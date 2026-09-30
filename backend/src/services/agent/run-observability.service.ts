import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import type { AiModelTier } from '../ai/gateway.js';

/**
 * Checkbox 130: observability for the background AI.
 *
 * THREE concerns live here, all read/write over EXISTING tables (no schema change):
 *
 *  1. PER-RUN RECORDS. Every executed AI job appends ONE `agent_job_events` row with
 *     `status = 'run_record'` and a compact `detail` JSON: routine, tier, model,
 *     provider, tokens, estimated cost, duration, outcome and - when the run was
 *     degraded - the SPECIFIC reason (budget/quota/provider error). `agent_job_events`
 *     is already the append-only audit trail of v54, so this needs no migration and
 *     survives the frozen `db/migrate.ts`.
 *
 *     Privacy: the detail carries ONLY operational counters/enums. Prompt bodies,
 *     completions, API keys and any credential are NEVER written or logged here.
 *
 *  2. COST LEDGER. A rolling per-day + current-month aggregate (tokens, estimated USD,
 *     run count) plus a linear month-to-date projection. The month boundary and the
 *     day buckets are computed BY THE DATABASE (`date_trunc`), never by slicing a UTC
 *     ISO string (the repo-wide trigger-date lesson). The projection multiplies the
 *     month-to-date total by `days_in_month / days_elapsed`, with the calendar values
 *     also supplied by the database so the JS side never guesses a timezone.
 *
 *  3. QUEUE / WORKER FACTS for `/api/agent/health` (task 130) and the self-watchdog
 *     (agent-watchdog.service.ts): queue depth + oldest-queued age, worker registry
 *     liveness (`agent_workers.last_seen_at`) and last successful run.
 *
 * Cost is an ESTIMATE from a tiny built-in blended-price table, overridable by
 * `AGENT_COST_PER_1K_TOKENS_USD`. Unknown models are recorded with cost 0 + cost_source
 * `unpriced` - never silently invented.
 */

const log = createLogger('agent-run-observability');

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

/** Event status marking one persisted per-run record in `agent_job_events`. */
export const RUN_RECORD_EVENT_STATUS = 'run_record';

export type AgentRunOutcome = 'succeeded' | 'failed' | 'timeout' | 'degraded';

/** Specific degraded reasons; `PROVIDER_ERROR` is derived from typed `AiError` codes. */
export type AgentDegradedReason =
  | 'BUDGET_EXHAUSTED_TOKENS'
  | 'BUDGET_EXHAUSTED_CALLS'
  | 'QUOTA_EXHAUSTED'
  | 'PROVIDER_ERROR';

export interface AgentRunRecordInput {
  jobId: string;
  userId: number | null;
  kind: string;
  routineId?: string | null;
  tier?: AiModelTier | null;
  model?: string | null;
  provider?: string | null;
  tokens?: number;
  durationMs?: number;
  outcome: AgentRunOutcome;
  degradedReason?: string | null;
  degradedAction?: string | null;
  errorCode?: string | null;
}

/** `agent_job_events` insert shared by the recorder (exported for the SQL-shape tests). */
export const RUN_RECORD_INSERT_SQL = `INSERT INTO agent_job_events (job_id, status, detail) VALUES ($1, $2, $3::jsonb)`;

/** Typed AI error codes that mean "the provider side failed", not a data/logic bug. */
const PROVIDER_ERROR_CODES = new Set<string>([
  'AI_DISABLED',
  'AI_INVALID_REQUEST',
  'AI_TIMEOUT',
  'AI_NETWORK',
  'AI_HTTP',
  'AI_PARSE',
]);

/** True for the gateway's typed provider failures (also accepts any future `AI_*`). */
export function isProviderErrorCode(code: string | null | undefined): boolean {
  if (typeof code !== 'string' || code.trim() === '') return false;
  return PROVIDER_ERROR_CODES.has(code) || code.startsWith('AI_');
}

/** The specific degraded reason for a failed run, or null when the failure was not provider-side. */
export function degradedReasonForError(errorCode: string | null | undefined): AgentDegradedReason | null {
  return isProviderErrorCode(errorCode) ? 'PROVIDER_ERROR' : null;
}

/**
 * Rough blended estimate (input+output averaged) per 1 000 tokens, matched by a
 * case-insensitive substring of the model name. Deliberately tiny and conservative:
 * anything not listed stays `unpriced` unless the operator sets the env override.
 */
export const BLENDED_PRICE_PER_1K_USD: Record<string, number> = {
  'gpt-4o-mini': 0.0003,
  'gpt-4.1-mini': 0.0005,
  'qwen3': 0.0002,
  'phi-4': 0.0001,
  'gemma': 0.0001,
};

export const COST_PER_1K_ENV = 'AGENT_COST_PER_1K_TOKENS_USD';

/** Effective per-1k USD rate: explicit env override wins, then the built-in table, else 0. */
export function resolveCostPer1k(
  model: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env[COST_PER_1K_ENV] ?? '').trim();
  if (raw !== '') {
    const override = Number.parseFloat(raw);
    if (Number.isFinite(override) && override >= 0) return override;
  }
  if (typeof model !== 'string' || model.trim() === '') return 0;
  const lower = model.toLowerCase();
  const match = Object.keys(BLENDED_PRICE_PER_1K_USD).find((key) => lower.includes(key));
  return match ? BLENDED_PRICE_PER_1K_USD[match] : 0;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toNonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/** Estimated cost in USD for a run; `cost_source` says whether a rate was known. */
export function estimateRunCost(input: {
  model: string | null;
  tokens: number;
  env?: Record<string, string | undefined>;
}): { costUsd: number; costSource: 'estimated' | 'unpriced' } {
  const rate = resolveCostPer1k(input.model, input.env ?? process.env);
  if (rate <= 0) return { costUsd: 0, costSource: 'unpriced' };
  return { costUsd: round6((input.tokens / 1000) * rate), costSource: 'estimated' };
}

/** The compact detail JSON persisted for one run. Never contains prompts or secrets. */
export function buildRunRecordDetail(input: AgentRunRecordInput): Record<string, unknown> {
  const tokens = toNonNegativeInt(input.tokens);
  const model = typeof input.model === 'string' && input.model.trim() !== '' ? input.model : null;
  const { costUsd, costSource } = estimateRunCost({ model, tokens });
  const duration = Number(input.durationMs);
  return {
    run: true,
    job_kind: input.kind,
    routine_id: input.routineId ?? null,
    tier: input.tier ?? null,
    model,
    provider: input.provider ?? null,
    tokens,
    cost_usd: costUsd,
    cost_source: costSource,
    duration_ms: Number.isFinite(duration) && duration >= 0 ? Math.trunc(duration) : null,
    outcome: input.outcome,
    degraded_reason: input.degradedReason ?? null,
    degraded_action: input.degradedAction ?? null,
    error_code: input.errorCode ?? null,
  };
}

/**
 * Best-effort append of ONE run record. A recording failure NEVER fails the job:
 * it is logged and swallowed (the queue row still carries the authoritative result).
 */
export async function recordAgentRun(input: AgentRunRecordInput): Promise<boolean> {
  try {
    const detail = buildRunRecordDetail(input);
    await query(RUN_RECORD_INSERT_SQL, [input.jobId, RUN_RECORD_EVENT_STATUS, JSON.stringify(detail)]);
    return true;
  } catch (error) {
    log.warn(
      { event: 'agent_run.record_failed', jobId: input.jobId, jobKind: input.kind, err: error },
      'Persisting the agent run record failed; the job result is unaffected',
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Queue + worker facts (health route / watchdog inputs)
// ---------------------------------------------------------------------------

export const QUEUE_HEALTH_SQL = `
SELECT COUNT(*)::int AS depth, MIN(run_at) AS oldest_run_at
FROM agent_jobs
WHERE status = 'queued'`;

export interface QueueHealth {
  depth: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeMs: number | null;
}

/** Queue depth + the age of the oldest queued job (null when the queue is empty). */
export async function readQueueHealth(nowMs: number = Date.now()): Promise<QueueHealth> {
  const result = await query(QUEUE_HEALTH_SQL);
  const row = (result.rows[0] ?? {}) as { depth?: unknown; oldest_run_at?: unknown };
  const depth = toNonNegativeInt(row.depth);
  if (row.oldest_run_at == null) return { depth, oldestQueuedAt: null, oldestQueuedAgeMs: null };
  const oldest = new Date(row.oldest_run_at as string | Date);
  const oldestMs = oldest.getTime();
  return {
    depth,
    oldestQueuedAt: Number.isFinite(oldestMs) ? oldest.toISOString() : null,
    oldestQueuedAgeMs: Number.isFinite(oldestMs) ? Math.max(0, nowMs - oldestMs) : null,
  };
}

export const DEFAULT_QUEUE_STALL_MS = 15 * 60 * 1000;
export const QUEUE_STALL_MS_ENV = 'AGENT_QUEUE_STALL_MS';

/** Queue-stall threshold in ms (env override, then the 15-minute default). */
export function resolveQueueStallMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env[QUEUE_STALL_MS_ENV] ?? '').trim();
  if (raw !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_QUEUE_STALL_MS;
}

/** "Deliberately stalled": queued work EXISTS and its oldest item has waited past the threshold. */
export function isQueueStalled(
  depth: number,
  oldestQueuedAgeMs: number | null,
  stallMs: number,
): boolean {
  return depth > 0 && oldestQueuedAgeMs !== null && oldestQueuedAgeMs > stallMs;
}

/** Mirrors `routes/admin/agent.ts` DEFAULT_WORKER_STALE_MS (defined locally to avoid a service->route import). */
export const DEFAULT_WORKER_STALE_MS = 120_000;
export const WORKER_STALE_MS_ENV = 'AGENT_WORKER_STALE_MS';

export function resolveWorkerStaleMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env[WORKER_STALE_MS_ENV] ?? '').trim();
  if (raw !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_WORKER_STALE_MS;
}

export const WORKER_TOUCH_SQL = `
INSERT INTO agent_workers (id, kind, last_seen_at, meta)
VALUES ($1, $2, now(), $3::jsonb)
ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, last_seen_at = now()`;

export const WORKER_LIST_SQL = `
SELECT id, kind, last_seen_at
FROM agent_workers
ORDER BY last_seen_at DESC NULLS LAST
LIMIT 20`;

export interface AgentWorkerHealth {
  id: string;
  kind: string | null;
  lastSeenAt: string | null;
  ageMs: number | null;
}

/** The same id the queue service uses for `lease_owner` (`AGENT_WORKER_ID` or `worker-<pid>`). */
export function resolveWorkerId(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.AGENT_WORKER_ID ?? '').trim();
  return explicit || `worker-${process.pid}`;
}

/** Best-effort worker registry heartbeat so `last_seen_at` (and worker liveness) stays fresh. */
export async function touchAgentWorker(
  workerId: string = resolveWorkerId(),
  kind: string = 'drain',
): Promise<void> {
  try {
    await query(WORKER_TOUCH_SQL, [workerId, kind, JSON.stringify({ source: 'agent-worker-drain' })]);
  } catch (error) {
    log.warn({ event: 'agent_worker.touch_failed', workerId, err: error }, 'Worker registry touch failed');
  }
}

/** Worker registry rows with derived ages vs the injected clock. */
export async function listAgentWorkers(nowMs: number = Date.now()): Promise<AgentWorkerHealth[]> {
  const result = await query(WORKER_LIST_SQL);
  return result.rows.map((row) => {
    const rawSeen = row.last_seen_at as string | Date | null | undefined;
    const seenMs = rawSeen == null ? NaN : new Date(rawSeen).getTime();
    return {
      id: String(row.id),
      kind: row.kind == null ? null : String(row.kind),
      lastSeenAt: Number.isFinite(seenMs) ? new Date(seenMs).toISOString() : null,
      ageMs: Number.isFinite(seenMs) ? Math.max(0, nowMs - seenMs) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Last successful run + recent degraded routines
// ---------------------------------------------------------------------------

export const LAST_SUCCESS_SQL = `
SELECT id, kind, finished_at
FROM agent_jobs
WHERE status = 'succeeded'
ORDER BY finished_at DESC NULLS LAST
LIMIT 1`;

export interface LastSuccessfulRun {
  jobId: string;
  kind: string;
  finishedAt: string | null;
  ageMs: number | null;
}

export async function getLastSuccessfulRun(nowMs: number = Date.now()): Promise<LastSuccessfulRun | null> {
  const result = await query(LAST_SUCCESS_SQL);
  const row = result.rows[0];
  if (!row) return null;
  const raw = row.finished_at as string | Date | null | undefined;
  const finishedMs = raw == null ? NaN : new Date(raw).getTime();
  return {
    jobId: String(row.id),
    kind: String(row.kind ?? ''),
    finishedAt: Number.isFinite(finishedMs) ? new Date(finishedMs).toISOString() : null,
    ageMs: Number.isFinite(finishedMs) ? Math.max(0, nowMs - finishedMs) : null,
  };
}

/**
 * Routines/kinds with a degraded run in the recent window, newest first. Used by the
 * health route (per-routine `已降级` labels) - the reason is the SPECIFIC one recorded
 * on the run (budget/quota/provider error), never a collapsed "error".
 */
export const DEGRADED_ROUTINES_SQL = `
SELECT e.detail->>'routine_id' AS routine_id,
       e.detail->>'job_kind' AS kind,
       e.detail->>'degraded_reason' AS reason,
       MAX(r.name) AS routine_name,
       MAX(e.at) AS last_at,
       COUNT(*)::int AS run_count
FROM agent_job_events e
JOIN agent_jobs j ON j.id = e.job_id
LEFT JOIN agent_routines r ON r.id::text = e.detail->>'routine_id'
WHERE e.status = 'run_record'
  AND e.detail->>'degraded_reason' IS NOT NULL
  AND e.at >= now() - make_interval(secs => $1::double precision)
GROUP BY 1, 2, 3
ORDER BY last_at DESC
LIMIT $2::int`;

export interface DegradedRoutine {
  routineId: string | null;
  kind: string | null;
  name: string | null;
  reason: string;
  lastAt: string | null;
  count: number;
}

export const DEFAULT_DEGRADED_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function getDegradedRoutines(
  windowMs: number = DEFAULT_DEGRADED_WINDOW_MS,
  limit: number = 10,
): Promise<DegradedRoutine[]> {
  const result = await query(DEGRADED_ROUTINES_SQL, [Math.max(1, Math.trunc(windowMs / 1000)), Math.max(1, limit)]);
  return result.rows.map((row) => ({
    routineId: row.routine_id == null ? null : String(row.routine_id),
    kind: row.kind == null ? null : String(row.kind),
    name: row.routine_name == null ? null : String(row.routine_name),
    reason: String(row.reason ?? 'UNKNOWN'),
    lastAt: row.last_at == null ? null : new Date(row.last_at as string | Date).toISOString(),
    count: toNonNegativeInt(row.run_count) || 1,
  }));
}

// ---------------------------------------------------------------------------
// Cost ledger (day/month + projection) and the /stats summary
// ---------------------------------------------------------------------------

export const LEDGER_DEFAULT_DAYS = 30;

const LEDGER_DAY_SQL = `
SELECT to_char(date_trunc('day', e.at), 'YYYY-MM-DD') AS day,
       COUNT(*)::int AS runs,
       COALESCE(SUM((e.detail->>'tokens')::int), 0)::int AS tokens,
       COALESCE(SUM((e.detail->>'cost_usd')::numeric), 0)::float8 AS cost_usd
FROM agent_job_events e
JOIN agent_jobs j ON j.id = e.job_id
WHERE e.status = 'run_record'
  AND e.at >= date_trunc('day', now()) - make_interval(days => $1::int)
  AND ($2::int IS NULL OR j.user_id = $2::int)
GROUP BY 1
ORDER BY 1`;

const LEDGER_MONTH_SQL = `
SELECT to_char(date_trunc('month', e.at), 'YYYY-MM') AS month,
       COUNT(*)::int AS runs,
       COALESCE(SUM((e.detail->>'tokens')::int), 0)::int AS tokens,
       COALESCE(SUM((e.detail->>'cost_usd')::numeric), 0)::float8 AS cost_usd
FROM agent_job_events e
JOIN agent_jobs j ON j.id = e.job_id
WHERE e.status = 'run_record'
  AND e.at >= date_trunc('month', now())
  AND ($1::int IS NULL OR j.user_id = $1::int)
GROUP BY 1`;

const LEDGER_CALENDAR_SQL = `
SELECT EXTRACT(DAY FROM now())::int AS days_elapsed,
       EXTRACT(DAY FROM (date_trunc('month', now()) + interval '1 month - 1 day'))::int AS days_in_month`;
export interface AgentLedgerBucket {
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface AgentRunLedgerDay extends AgentLedgerBucket {
  day: string;
}

export interface AgentRunLedger {
  /** Rolling per-day buckets, oldest -> newest (only days with runs are present). */
  days: AgentRunLedgerDay[];
  month: ({ month: string } & AgentLedgerBucket) | null;
  projection: {
    month: string | null;
    daysElapsed: number;
    daysInMonth: number;
    basis: 'linear_month_to_date';
    tokens: number;
    costUsd: number;
    runs: number;
  };
  windowDays: number;
  generatedAt: string;
}

function toBucket(row: { runs?: unknown; tokens?: unknown; cost_usd?: unknown }): AgentLedgerBucket {
  const cost = Number(row.cost_usd);
  return {
    runs: toNonNegativeInt(row.runs),
    tokens: toNonNegativeInt(row.tokens),
    costUsd: Number.isFinite(cost) && cost > 0 ? round6(cost) : 0,
  };
}

/** Linear month-to-date projection: `mtd * days_in_month / days_elapsed`. Trivial to test. */
export function projectMonthToDate(input: {
  month: AgentLedgerBucket;
  daysElapsed: number;
  daysInMonth: number;
}): { tokens: number; costUsd: number; runs: number } {
  const elapsed = Math.max(1, Math.trunc(input.daysElapsed));
  const inMonth = Math.max(1, Math.trunc(input.daysInMonth));
  const factor = inMonth / elapsed;
  return {
    tokens: Math.round(input.month.tokens * factor),
    costUsd: round6(input.month.costUsd * factor),
    runs: Math.round(input.month.runs * factor),
  };
}

/**
 * Rolling day ledger + current-month total + projection. Never throws: on a missing
 * table (pre-migration database) it returns an honest empty ledger.
 */
export async function getAgentRunLedger(
  userId: number | null,
  options: { days?: number; nowMs?: number } = {},
): Promise<AgentRunLedger> {
  const days = Number.isInteger(options.days) && (options.days as number) > 0 ? (options.days as number) : LEDGER_DEFAULT_DAYS;
  const nowMs = options.nowMs ?? Date.now();
  const empty: AgentRunLedger = {
    days: [],
    month: null,
    projection: {
      month: null,
      daysElapsed: 1,
      daysInMonth: 31,
      basis: 'linear_month_to_date',
      tokens: 0,
      costUsd: 0,
      runs: 0,
    },
    windowDays: days,
    generatedAt: new Date(nowMs).toISOString(),
  };
  try {
    const [dayRows, monthRows, calendarRows] = await Promise.all([
      query(LEDGER_DAY_SQL, [days, userId]),
      query(LEDGER_MONTH_SQL, [userId]),
      query(LEDGER_CALENDAR_SQL),
    ]);
    const dayBuckets: AgentRunLedgerDay[] = dayRows.rows.map((row) => ({
      day: String(row.day ?? ''),
      ...toBucket(row),
    }));
    const monthRow = monthRows.rows[0];
    const month = monthRow
      ? { month: String(monthRow.month ?? ''), ...toBucket(monthRow) }
      : null;
    const calendar = (calendarRows.rows[0] ?? {}) as { days_elapsed?: unknown; days_in_month?: unknown };
    const daysElapsed = toNonNegativeInt(calendar.days_elapsed) || 1;
    const daysInMonth = toNonNegativeInt(calendar.days_in_month) || 31;
    const basis = month ?? { runs: 0, tokens: 0, costUsd: 0 };
    const projected = projectMonthToDate({ month: basis, daysElapsed, daysInMonth });
    return {
      days: dayBuckets,
      month,
      projection: {
        month: month?.month ?? null,
        daysElapsed,
        daysInMonth,
        basis: 'linear_month_to_date',
        ...projected,
      },
      windowDays: days,
      generatedAt: new Date(nowMs).toISOString(),
    };
  } catch (error) {
    log.warn({ event: 'agent_ledger.read_failed', err: error }, 'Reading the agent cost ledger failed; returning the empty ledger');
    return empty;
  }
}

export const RECENT_RUNS_SQL = `
SELECT e.job_id, e.at, e.detail
FROM agent_job_events e
JOIN agent_jobs j ON j.id = e.job_id
WHERE e.status = 'run_record'
  AND ($1::int IS NULL OR j.user_id = $1::int)
ORDER BY e.at DESC
LIMIT $2`;

export interface AgentRunView {
  jobId: string;
  at: string;
  kind: string | null;
  routineId: string | null;
  tier: string | null;
  model: string | null;
  provider: string | null;
  tokens: number;
  costUsd: number;
  durationMs: number | null;
  outcome: string | null;
  degradedReason: string | null;
}

/** Recent run records (newest first) for `GET /api/stats`. Never throws. */
export async function listRecentRuns(userId: number | null, limit: number = 10): Promise<AgentRunView[]> {
  try {
    const result = await query(RECENT_RUNS_SQL, [userId, Math.max(1, Math.min(limit, 100))]);
    return result.rows.map((row) => {
      const detail = (typeof row.detail === 'object' && row.detail !== null ? row.detail : {}) as Record<string, unknown>;
      return {
        jobId: String(row.job_id ?? ''),
        at: row.at == null ? '' : new Date(row.at as string | Date).toISOString(),
        kind: detail.job_kind == null ? null : String(detail.job_kind),
        routineId: detail.routine_id == null ? null : String(detail.routine_id),
        tier: detail.tier == null ? null : String(detail.tier),
        model: detail.model == null ? null : String(detail.model),
        provider: detail.provider == null ? null : String(detail.provider),
        tokens: toNonNegativeInt(detail.tokens),
        costUsd: Number.isFinite(Number(detail.cost_usd)) ? round6(Number(detail.cost_usd)) : 0,
        durationMs: Number.isFinite(Number(detail.duration_ms)) ? Math.trunc(Number(detail.duration_ms)) : null,
        outcome: detail.outcome == null ? null : String(detail.outcome),
        degradedReason: detail.degraded_reason == null ? null : String(detail.degraded_reason),
      };
    });
  } catch (error) {
    log.warn({ event: 'agent_runs.list_failed', err: error }, 'Listing recent agent runs failed; returning an empty list');
    return [];
  }
}

export interface AgentObservabilitySummary {
  generatedAt: string;
  recentRuns: AgentRunView[];
  ledger: AgentRunLedger;
  degradedLast24h: number;
}

/**
 * The compact `agent` section surfaced by `GET /api/stats` (task 130). Shaped for the
 * frontend degraded-state hook too. A read failure yields empty arrays, never a 500.
 */
export async function getAgentObservabilitySummary(
  userId: number | null,
  options: { nowMs?: number } = {},
): Promise<AgentObservabilitySummary> {
  const nowMs = options.nowMs ?? Date.now();
  const [recentRuns, ledger, degraded] = await Promise.all([
    listRecentRuns(userId, 10),
    getAgentRunLedger(userId, { nowMs }),
    getDegradedRoutines(DEFAULT_DEGRADED_WINDOW_MS, 10).catch(() => [] as DegradedRoutine[]),
  ]);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    recentRuns,
    ledger,
    degradedLast24h: degraded.length,
  };
}
