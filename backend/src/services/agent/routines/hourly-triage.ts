import { query } from '../../../db/index.js';
import { createLogger } from '../../../utils/logger.js';
import type { AgentJobKind, ClaimedJob } from '../queue.service.js';
import type {
  AgentJobHandler,
  AgentJobHandlerContext,
  AgentJobHandlerResult,
} from '../job-runner.service.js';

/**
 * Wave 15 routine (`hourly_triage`, job kinds 122-125): the cheapest, fully
 * DETERMINISTIC tier of the agent's proactive loop.
 *
 * Every hour it:
 *   1. reads the user's events inside `TRIAGE_LOOKAHEAD_DAYS` (plus a bounded overdue
 *      lookback) and scores each one deterministically (`scoreEventCandidate`),
 *   2. buckets the score into an importance band (`importanceBand`),
 *   3. SUPPRESSES an item that was already surfaced inside `TRIAGE_DEDUPE_WINDOW_HOURS`
 *      unless its importance escalated by at least `TRIAGE_ESCALATION_DELTA`,
 *   4. persists one `agent_triage_state` row per item (fingerprint = `event:<id>`,
 *      unique per user) so the dedupe memory is durable across serverless invocations,
 *   5. returns the surfaced items in the job result; items below the bar are persisted
 *      for audit but NEVER pushed.
 *
 * The routine spends nothing: it never calls an AI provider and always reports
 * `costTokens: 0`. The job-runner still routes it through the budget/tier machinery
 * (`AGENT_JOB_TIER_BY_KIND.hourly_triage = 'lite'`); an exhausted budget may skip it,
 * which only means "no proactive nudges this hour", never data loss (the state table
 * keeps everything it has already seen).
 *
 * ## Importance bars (all exported, all deterministic)
 *   IMPORTANCE_URGENT_BAR = 85  score >= 85 -> band 'urgent'  (surface immediately)
 *   IMPORTANCE_HIGH_BAR   = 65  score >= 65 -> band 'high'    (surface)
 *   IMPORTANCE_NORMAL_BAR = 45  score >= 45 -> band 'normal'  (surface, at most once
 *                                per dedupe window - this is also MIN_SURFACE)
 *   IMPORTANCE_FYI_FLOOR  = 0   below 45    -> band 'fyi'     (persisted, never pushed)
 *
 * ## Dedupe mechanism
 *   - Fingerprint: `event:<id>` (one row per entity per user; `UNIQUE (user_id, fingerprint)`
 *     in `agent_triage_state`).
 *   - A row whose `last_surfaced_at` is younger than `TRIAGE_DEDUPE_WINDOW_HOURS` (12h)
 *     is skipped as a duplicate -> the same event cannot be pushed hourly.
 *   - Escalation bypass: a repeat is allowed when the new importance is at least
 *     `TRIAGE_ESCALATION_DELTA` (15) above the last recorded importance, so an item
 *     that became genuinely urgent is not muted by its own history.
 *   - Skipped repeats still bump `last_seen_at` (freshness audit), never
 *     `last_surfaced_at` (the suppression anchor).
 *
 * All data access is exported as injectable seams (`HourlyTriageDeps`) so tests can
 * drive the handler without a database, following the queue/gateway convention.
 */

const log = createLogger('agent.routines.hourly-triage');

/** `agent_jobs.kind` value this handler consumes. */
export const HOURLY_TRIAGE_KIND = 'hourly_triage' as const;

// ---------------------------------------------------------------------------
// Importance bars (the thresholds, exported individually for the surface bar)
// ---------------------------------------------------------------------------

/** score >= 85 -> 'urgent' (surface immediately, bypasses nothing else). */
export const IMPORTANCE_URGENT_BAR = 85;
/** score >= 65 -> 'high' (surface). */
export const IMPORTANCE_HIGH_BAR = 65;
/** score >= 45 -> 'normal'; also the MINIMUM score the triage will surface at all. */
export const IMPORTANCE_NORMAL_BAR = 45;
/** score >= 0 -> 'fyi' (persisted for audit, never pushed). */
export const IMPORTANCE_FYI_FLOOR = 0;

export type TriageBand = 'urgent' | 'high' | 'normal' | 'fyi';

/** The bars as one frozen map (descriptor/reporting convenience). */
export const TRIAGE_IMPORTANCE_BARS = {
  urgent: IMPORTANCE_URGENT_BAR,
  high: IMPORTANCE_HIGH_BAR,
  normal: IMPORTANCE_NORMAL_BAR,
  fyi: IMPORTANCE_FYI_FLOOR,
} as const;

export const TRIAGE_BAND_LABELS: Record<TriageBand, string> = {
  urgent: '紧急',
  high: '重要',
  normal: '留意',
  fyi: '参考',
};

// ---------------------------------------------------------------------------
// Windows and dedupe knobs
// ---------------------------------------------------------------------------

/** Forward horizon: events due within this many days are candidates. */
export const TRIAGE_LOOKAHEAD_DAYS = 7;
/** Backward horizon for overdue items; older overdue rows stop being triaged. */
export const TRIAGE_OVERDUE_LOOKBACK_DAYS = 30;
/** A surfaced fingerprint is suppressed for this long (hours) unless it escalates. */
export const TRIAGE_DEDUPE_WINDOW_HOURS = 12;
/** Minimum importance gain that re-surfaces an otherwise suppressed fingerprint. */
export const TRIAGE_ESCALATION_DELTA = 15;
/** Hard cap on candidates evaluated per run (bounded work, bounded writes). */
export const TRIAGE_CANDIDATE_LIMIT = 50;

export type TriageSurfaceKind = 'hourly_triage' | 'weekly_review';

/** Descriptor shape shared by every Wave 15 routine file (each exports its own). */
export type RoutineTier = 'lite' | 'medium' | 'high';

export interface RoutineDescriptor {
  kind: AgentJobKind;
  title: string;
  description: string;
  /** Default cron the scheduler should seed into `agent_routines.cron_expr`. */
  cron: string;
  tier: RoutineTier;
  /** Horizon the routine looks at, in days. */
  windowDays: number;
  /** Repeat-suppression window in hours; `null` = dedupe by ISO week key instead. */
  dedupeWindowHours: number | null;
  /** Importance thresholds (see `IMPORTANCE_*_BAR`). */
  importanceBars: Readonly<Record<TriageBand, number>>;
  /** Max items one digest/report surfaces. */
  topN: number;
}

export const HOURLY_TRIAGE_DESCRIPTOR: RoutineDescriptor = {
  kind: HOURLY_TRIAGE_KIND,
  title: '每小时巡检',
  description:
    '按小时扫描 7 天内到期（含 30 天逾期）的事项，确定性打分并按重要性门槛分流；12 小时内不重复推送，重要性上升至少 15 分才重新出现。全流程无 AI 调用。',
  cron: '0 * * * *',
  tier: 'lite',
  windowDays: TRIAGE_LOOKAHEAD_DAYS,
  dedupeWindowHours: TRIAGE_DEDUPE_WINDOW_HOURS,
  importanceBars: TRIAGE_IMPORTANCE_BARS,
  topN: TRIAGE_CANDIDATE_LIMIT,
};

// ---------------------------------------------------------------------------
// Deterministic scoring
// ---------------------------------------------------------------------------

/** Fixed, additive event-type weights (never learned, never LLM-derived). */
export const EVENT_TYPE_WEIGHTS: Record<string, number> = {
  medical: 12,
  exam: 10,
  deadline: 10,
  meeting: 6,
  wedding: 6,
  birthday: 5,
  anniversary: 5,
  trip: 4,
  graduation: 4,
  holiday: 3,
  other: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Pure importance score (0..100). Urgency bands by days-until, then an additive
 * event-type weight. Deterministic for identical inputs - the whole point of the
 * `lite` tier is that a re-run produces the same answer.
 */
export function scoreEventCandidate(input: { daysUntil: number; eventType: string }): number {
  const { daysUntil, eventType } = input;
  let base: number;
  if (daysUntil < 0) base = 88 + Math.min(12, -daysUntil);
  else if (daysUntil === 0) base = 80;
  else if (daysUntil === 1) base = 72;
  else if (daysUntil <= 3) base = 64;
  else if (daysUntil <= 7) base = 52;
  else base = 35;

  const weight = EVENT_TYPE_WEIGHTS[eventType] ?? 0;
  return clamp(Math.round(base + weight), 0, 100);
}

/** Map a score onto its band using the exported bars. */
export function importanceBand(score: number): TriageBand {
  if (score >= IMPORTANCE_URGENT_BAR) return 'urgent';
  if (score >= IMPORTANCE_HIGH_BAR) return 'high';
  if (score >= IMPORTANCE_NORMAL_BAR) return 'normal';
  return 'fyi';
}

/** Stable per-item dedupe key: one row per user+entity in `agent_triage_state`. */
export function triageFingerprint(sourceKind: string, sourceRef: string): string {
  return `${sourceKind}:${sourceRef}`;
}

// ---------------------------------------------------------------------------
// Candidate / state types
// ---------------------------------------------------------------------------

export interface TriageCandidate {
  fingerprint: string;
  sourceKind: 'event';
  sourceRef: string;
  title: string;
  eventType: string;
  /** Days until due: negative = overdue, 0 = today, null = unknown. */
  daysUntil: number | null;
  importance: number;
  band: TriageBand;
}

export interface TriageStateRow {
  fingerprint: string;
  title?: string;
  sourceKind?: string;
  sourceRef?: string | null;
  importance: number;
  lastSurfacedAt: Date | string | null;
  surfacedCount?: number;
  digestWeek: string | null;
}

export interface TriageStateWrite {
  candidate: TriageCandidate;
  /** true = counts as a surface (bumps `last_surfaced_at` + `surfaced_count`). */
  surfaced: boolean;
  /** Which routine surfaced it; null when only observed. */
  surfaceKind: TriageSurfaceKind | null;
}

function toEpochMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toFiniteInt(value: unknown): number | null {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

/**
 * Should an item be surfaced again? Pure and deterministic.
 *  - no previous row            -> yes (first sighting)
 *  - never surfaced             -> yes
 *  - last surface older than the window -> yes
 *  - importance escalated by >= delta   -> yes
 *  - otherwise                  -> no (deduped)
 */
export function shouldSurface(input: {
  previous: Pick<TriageStateRow, 'importance' | 'lastSurfacedAt'> | null;
  importance: number;
  nowMs: number;
  windowHours?: number;
  escalationDelta?: number;
}): boolean {
  const prev = input.previous;
  if (!prev) return true;
  const lastMs = toEpochMs(prev.lastSurfacedAt);
  if (lastMs === null) return true;
  const windowMs = (input.windowHours ?? TRIAGE_DEDUPE_WINDOW_HOURS) * 3_600_000;
  if (input.nowMs - lastMs >= windowMs) return true;
  const delta = input.escalationDelta ?? TRIAGE_ESCALATION_DELTA;
  return input.importance >= prev.importance + delta;
}

// ---------------------------------------------------------------------------
// SQL (exported so tests can execute the shipped text verbatim)
// ---------------------------------------------------------------------------

/** Candidates: due inside [today - lookback, today + lookahead]; days computed in SQL. */
export const TRIAGE_CANDIDATE_SQL = `
SELECT id, name, event_type,
       COALESCE(next_occurrence, date) - CURRENT_DATE AS days_until
FROM events
WHERE user_id = $1
  AND COALESCE(next_occurrence, date) BETWEEN (CURRENT_DATE - $4::int) AND (CURRENT_DATE + $2::int)
ORDER BY days_until ASC, id ASC
LIMIT $3`;

export const TRIAGE_STATE_LOAD_SQL = `
SELECT fingerprint, importance, last_surfaced_at, surfaced_count, digest_week
FROM agent_triage_state
WHERE user_id = $1 AND fingerprint = ANY($2::text[])`;

/**
 * Upsert one fingerprint. `last_surfaced_at`/`surfaced_count`/`last_surface_kind` are
 * only advanced when the write reports a surface (`COALESCE` keeps prior values for
 * observe-only writes).
 */
export const TRIAGE_STATE_UPSERT_SQL = `
INSERT INTO agent_triage_state
  (user_id, fingerprint, source_kind, source_ref, title, importance, band,
   last_seen_at, last_surfaced_at, surfaced_count, last_surface_kind)
VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10)
ON CONFLICT (user_id, fingerprint) DO UPDATE SET
  title = EXCLUDED.title,
  source_kind = EXCLUDED.source_kind,
  source_ref = EXCLUDED.source_ref,
  importance = EXCLUDED.importance,
  band = EXCLUDED.band,
  last_seen_at = now(),
  last_surfaced_at = COALESCE(EXCLUDED.last_surfaced_at, agent_triage_state.last_surfaced_at),
  surfaced_count = agent_triage_state.surfaced_count + EXCLUDED.surfaced_count,
  last_surface_kind = COALESCE(EXCLUDED.last_surface_kind, agent_triage_state.last_surface_kind)`;

// ---------------------------------------------------------------------------
// Data access (default implementations of the injectable seams)
// ---------------------------------------------------------------------------

export async function loadTriageCandidates(
  userId: number,
  lookaheadDays: number = TRIAGE_LOOKAHEAD_DAYS,
  limit: number = TRIAGE_CANDIDATE_LIMIT,
): Promise<TriageCandidate[]> {
  const result = await query(TRIAGE_CANDIDATE_SQL, [
    userId,
    lookaheadDays,
    limit,
    TRIAGE_OVERDUE_LOOKBACK_DAYS,
  ]);
  const candidates: TriageCandidate[] = [];
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const id = toFiniteInt(row.id);
    if (id === null) continue;
    const daysUntil = toFiniteInt(row.days_until);
    const eventType =
      typeof row.event_type === 'string' && row.event_type.trim() !== '' ? row.event_type.trim() : 'other';
    const rawName = typeof row.name === 'string' ? row.name.trim() : '';
    const importance = daysUntil === null ? 0 : scoreEventCandidate({ daysUntil, eventType });
    candidates.push({
      fingerprint: triageFingerprint('event', String(id)),
      sourceKind: 'event',
      sourceRef: String(id),
      title: rawName.slice(0, 200) || '未命名事项',
      eventType,
      daysUntil,
      importance,
      band: importanceBand(importance),
    });
  }
  return candidates;
}

export async function loadTriageState(
  userId: number,
  fingerprints: string[],
): Promise<Map<string, TriageStateRow>> {
  const state = new Map<string, TriageStateRow>();
  if (fingerprints.length === 0) return state;
  const result = await query(TRIAGE_STATE_LOAD_SQL, [userId, fingerprints]);
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const fingerprint = typeof row.fingerprint === 'string' ? row.fingerprint : '';
    if (fingerprint === '') continue;
    state.set(fingerprint, {
      fingerprint,
      importance: toFiniteInt(row.importance) ?? 0,
      lastSurfacedAt: (row.last_surfaced_at ?? null) as Date | string | null,
      surfacedCount: toFiniteInt(row.surfaced_count) ?? 0,
      digestWeek: row.digest_week == null ? null : String(row.digest_week),
    });
  }
  return state;
}

/** Persist the triage outcome for every observed candidate (bounded by the limit). */
export async function saveTriageState(
  userId: number,
  writes: TriageStateWrite[],
  nowMs: number,
): Promise<number> {
  let written = 0;
  for (const write of writes) {
    await query(TRIAGE_STATE_UPSERT_SQL, [
      userId,
      write.candidate.fingerprint,
      write.candidate.sourceKind,
      write.candidate.sourceRef,
      write.candidate.title,
      write.candidate.importance,
      write.candidate.band,
      write.surfaced ? new Date(nowMs) : null,
      write.surfaced ? 1 : 0,
      write.surfaceKind,
    ]);
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface HourlyTriageSummary {
  kind: typeof HOURLY_TRIAGE_KIND;
  candidates: number;
  surfaced: Array<Pick<TriageCandidate, 'fingerprint' | 'title' | 'importance' | 'band' | 'daysUntil'>>;
  deduped: number;
  belowBar: number;
}

export interface HourlyTriageDeps {
  /** Clock in epoch ms; injectable for deterministic dedupe tests. */
  now?: () => number;
  loadCandidates?: (userId: number, lookaheadDays: number) => Promise<TriageCandidate[]>;
  loadState?: (userId: number, fingerprints: string[]) => Promise<Map<string, TriageStateRow>>;
  saveState?: (userId: number, writes: TriageStateWrite[], nowMs: number) => Promise<number>;
}

/**
 * Build the `hourly_triage` job handler. Production uses {@link hourlyTriageHandler};
 * tests inject the three seams above and drive the whole flow without a database.
 */
export function createHourlyTriageHandler(deps: HourlyTriageDeps = {}): AgentJobHandler {
  const now = deps.now ?? Date.now;
  const loadCandidates = deps.loadCandidates ?? loadTriageCandidates;
  const loadState = deps.loadState ?? loadTriageState;
  const saveState = deps.saveState ?? saveTriageState;

  return async function execute(
    job: ClaimedJob,
    context: AgentJobHandlerContext,
  ): Promise<AgentJobHandlerResult> {
    const userId = job.userId;
    if (userId === null) {
      return { result: { skipped: true, reason: 'no_user' }, costTokens: 0 };
    }

    const nowMs = now();
    const candidates = await loadCandidates(userId, TRIAGE_LOOKAHEAD_DAYS);
    const state = await loadState(
      userId,
      candidates.map((candidate) => candidate.fingerprint),
    );

    const writes: TriageStateWrite[] = [];
    const surfaced: HourlyTriageSummary['surfaced'] = [];
    let deduped = 0;
    let belowBar = 0;

    for (const candidate of candidates) {
      if (candidate.importance < IMPORTANCE_NORMAL_BAR) {
        // Below the surface bar: recorded for audit, never pushed.
        belowBar += 1;
        writes.push({ candidate, surfaced: false, surfaceKind: null });
        continue;
      }
      const previous = state.get(candidate.fingerprint) ?? null;
      if (!shouldSurface({ previous, importance: candidate.importance, nowMs })) {
        deduped += 1;
        writes.push({ candidate, surfaced: false, surfaceKind: null });
        continue;
      }
      surfaced.push({
        fingerprint: candidate.fingerprint,
        title: candidate.title,
        importance: candidate.importance,
        band: candidate.band,
        daysUntil: candidate.daysUntil,
      });
      writes.push({ candidate, surfaced: true, surfaceKind: HOURLY_TRIAGE_KIND });
    }

    if (writes.length > 0) {
      await saveState(userId, writes, nowMs);
    }

    const summary: HourlyTriageSummary = {
      kind: HOURLY_TRIAGE_KIND,
      candidates: candidates.length,
      surfaced,
      deduped,
      belowBar,
    };
    log.info(
      {
        event: 'agent.hourly_triage.done',
        userId,
        tier: context.tier,
        candidates: candidates.length,
        surfaced: surfaced.length,
        deduped,
        belowBar,
      },
      'Hourly triage completed',
    );
    return { result: summary, costTokens: 0 };
  };
}

/** Production handler (real SQL). Spend-free, so it always reports 0 tokens. */
export const hourlyTriageHandler: AgentJobHandler = createHourlyTriageHandler();

/**
 * Ready-to-spread handler map for `createAgentJobExecutor({ handlers: { ...hourlyTriageHandlers } })`.
 * The executor is owned by another lane; this file never wires itself into routes.
 */
export const hourlyTriageHandlers: Partial<Record<AgentJobKind, AgentJobHandler>> = {
  [HOURLY_TRIAGE_KIND]: hourlyTriageHandler,
};
