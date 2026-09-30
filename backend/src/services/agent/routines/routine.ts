import type { AgentJobKind } from '../queue.service.js';
import type { AiModelTier } from '../../ai/gateway.js';
import { query } from '../../../db/index.js';
import { getUserConfig } from '../../config.service.js';

/**
 * Shared contract for the agent routines (checkboxes 122-125).
 *
 * A routine is deliberately just:
 *   - a plain exported `run(ctx)` function, and
 *   - a small descriptor `{ kind, tier, defaultSchedule, run }`.
 *
 * A later integrator registers the descriptor (seeds an `agent_routines` row and
 * binds the handler). Nothing in this module touches the queue, cron or routes.
 *
 * Delivery contract: the queue is at-least-once, so `run` must be idempotent per
 * `(user_id, idempotency_key)`. The key is `"<kind>:<user-local-date>"`; the first
 * run claims the `agent_routine_artifacts` row (INSERT .. ON CONFLICT DO NOTHING),
 * renders and delivers exactly one Inbox message, then flips `delivered = TRUE`.
 * A claim that never delivered (crash mid-run) is reclaimable after 15 minutes.
 *
 * Deterministic when AI is off: the routines perform ZERO model calls on their
 * own. An optional `ctx.narrator` may add one narrative paragraph; when absent
 * (AI off), under budget, or throwing, the template body is used unchanged.
 */

/** Routine kinds this package can express (mirrors `AGENT_JOB_KINDS`). */
export type RoutineKind = Extract<
  AgentJobKind,
  'morning_brief' | 'evening_review' | 'weekly_review' | 'hourly_triage'
>;

/** Mirrors the AI gateway's tier vocabulary (`lite` / `medium` / `high`). */
export type RoutineTier = AiModelTier;

export interface RoutineNarrativeInput {
  kind: RoutineKind;
  localDate: string;
  timezone: string;
  /** The same structured facts the deterministic renderer used. */
  facts: unknown;
}

export type RoutineNarrator = (
  input: RoutineNarrativeInput,
) => Promise<string | null | undefined> | string | null | undefined;

export interface RoutineDelivery {
  userId: number;
  kind: RoutineKind;
  localDate: string;
  title: string;
  body: string;
}

export type RoutineDeliver = (delivery: RoutineDelivery) => Promise<void> | void;

export interface RoutineContext {
  userId: number;
  /** Injected clock (tests); defaults to `new Date()`. */
  now?: Date;
  /** IANA timezone override; defaults to the user config (`Asia/Shanghai`). */
  timezone?: string;
  /** Optional AI narrator. Absent => deterministic template only. */
  narrator?: RoutineNarrator;
  /** Optional push/channel delivery; absent => Inbox only. Best-effort. */
  deliver?: RoutineDeliver;
  /** Tokens left in the job's budget; the narrator is skipped below the floor. */
  budgetTokensRemaining?: number;
}

export type RoutineStatus = 'delivered' | 'duplicate' | 'not_delivered';

export interface RoutineResult {
  kind: RoutineKind;
  userId: number;
  localDate: string;
  status: RoutineStatus;
  title: string;
  body: string;
  usedNarrative: boolean;
  artifactId: number | null;
  /** The structured facts behind the rendered body (inspectable by the caller). */
  facts: unknown;
}

export interface RoutineDescriptor {
  kind: RoutineKind;
  tier: RoutineTier;
  /** Cron expression in the user's local timezone (seeds `agent_routines.cron_expr`). */
  defaultSchedule: string;
  run: (ctx: RoutineContext) => Promise<RoutineResult>;
}

export const DEFAULT_ROUTINE_TIMEZONE = 'Asia/Shanghai';
/** Narration is skipped when the remaining job budget is below this (tokens). */
export const NARRATIVE_MIN_BUDGET_TOKENS = 500;
/** Seconds before a claimed-but-undelivered artifact may be reclaimed. */
export const ROUTINE_ARTIFACT_STALE_SECONDS = 15 * 60;

/* ------------------------------------------------------------------ */
/* Date helpers (UTC arithmetic on YYYY-MM-DD strings)                */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function toYmd(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return toYmd(new Date(Date.UTC(y, m - 1, d + delta)));
}

export function diffDaysYmd(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** The user-local calendar day (YYYY-MM-DD) for an instant + IANA timezone. */
export function localDateIn(now: Date, timezone: string | null | undefined): string {
  if (timezone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
    } catch {
      // Unknown timezone: fall back to UTC rather than throwing mid-run.
    }
  }
  return toYmd(now);
}

export async function getUserTimezone(userId: number): Promise<string> {
  try {
    const config = (await getUserConfig(userId)) as unknown as Record<string, unknown> | null;
    const timezone = config?.timezone;
    return typeof timezone === 'string' && timezone.length > 0 ? timezone : DEFAULT_ROUTINE_TIMEZONE;
  } catch {
    return DEFAULT_ROUTINE_TIMEZONE;
  }
}

/** Human label for a due date relative to the routine's local day. */
export function dueUrgencyLabel(localDate: string, due: string): string {
  const delta = diffDaysYmd(localDate, due);
  if (delta === 0) return '今天到期';
  if (delta > 0) return `还剩 ${delta} 天`;
  return `已逾期 ${-delta} 天`;
}

/* ------------------------------------------------------------------ */
/* Medication summary (shared by the daily routines)                   */
/* ------------------------------------------------------------------ */

export interface RoutineMedicationSummary {
  taken: number;
  skipped: number;
  missed: number;
  total: number;
  percentage: number;
}

/**
 * Narrow an `AdherenceReport`-shaped value to the display summary.
 * Returns `null` for a zero-dose window so callers skip the section entirely
 * (no divide-by-zero, no empty shell).
 */
export function medicationSummary(
  report: { overall: RoutineMedicationSummary } | null | undefined,
): RoutineMedicationSummary | null {
  if (!report || !(report.overall.total > 0)) return null;
  const { taken, skipped, missed, total, percentage } = report.overall;
  return {
    taken,
    skipped,
    missed,
    total,
    percentage: Number.isFinite(percentage) ? Math.round(percentage) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Optional narration (AI-on only; deterministic when off)             */
/* ------------------------------------------------------------------ */

export async function resolveRoutineNarrative(
  ctx: RoutineContext,
  input: RoutineNarrativeInput,
): Promise<string | null> {
  if (!ctx.narrator) return null;
  if (
    typeof ctx.budgetTokensRemaining === 'number' &&
    ctx.budgetTokensRemaining < NARRATIVE_MIN_BUDGET_TOKENS
  ) {
    return null;
  }
  try {
    const text = await ctx.narrator(input);
    const trimmed = typeof text === 'string' ? text.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Narration is strictly additive: a failed/slow narrator degrades to the
    // deterministic template and never fails the run.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Artifact idempotency store (table from pending migration 61)        */
/* ------------------------------------------------------------------ */

export const ROUTINE_ARTIFACT_SQL = {
  claim: `
INSERT INTO agent_routine_artifacts (user_id, routine, local_date, idempotency_key, title, body, payload)
VALUES ($1, $2, $3::date, $4, $5, $6, $7::jsonb)
ON CONFLICT (user_id, idempotency_key) DO NOTHING
RETURNING id`,
  staleReclaim: `
UPDATE agent_routine_artifacts
SET created_at = now(),
    title = $3,
    body = $4,
    payload = $5::jsonb
WHERE user_id = $1
  AND idempotency_key = $2
  AND delivered = FALSE
  AND created_at < now() - make_interval(secs => $6::double precision)
RETURNING id`,
  markDelivered: `
UPDATE agent_routine_artifacts
SET delivered = TRUE,
    delivered_at = now(),
    channel = $3
WHERE id = $1 AND user_id = $2`,
} as const;

export interface RoutineArtifactClaim {
  userId: number;
  kind: RoutineKind;
  localDate: string;
  idempotencyKey: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
}

/**
 * Claim the once-per-local-day slot for a routine artifact.
 * Returns the artifact id to deliver, or `null` when this local day was already
 * delivered (duplicate run) — the caller MUST then stop without side effects.
 */
export async function claimRoutineArtifact(claim: RoutineArtifactClaim): Promise<number | null> {
  const inserted = await query(ROUTINE_ARTIFACT_SQL.claim, [
    claim.userId,
    claim.kind,
    claim.localDate,
    claim.idempotencyKey,
    claim.title,
    claim.body,
    JSON.stringify(claim.payload),
  ]);
  if (inserted.rows.length > 0) return Number(inserted.rows[0].id);

  const reclaimed = await query(ROUTINE_ARTIFACT_SQL.staleReclaim, [
    claim.userId,
    claim.idempotencyKey,
    claim.title,
    claim.body,
    JSON.stringify(claim.payload),
    ROUTINE_ARTIFACT_STALE_SECONDS,
  ]);
  if (reclaimed.rows.length > 0) return Number(reclaimed.rows[0].id);
  return null;
}

export async function markRoutineArtifactDelivered(
  userId: number,
  artifactId: number,
  channel: string,
): Promise<void> {
  await query(ROUTINE_ARTIFACT_SQL.markDelivered, [artifactId, userId, channel]);
}

/** Canonical once-per-local-day idempotency key: `<kind>:<YYYY-MM-DD>`. */
export function routineArtifactKey(kind: RoutineKind, localDate: string): string {
  return `${kind}:${localDate}`;
}
