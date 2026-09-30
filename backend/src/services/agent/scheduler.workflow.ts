import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { AGENT_JOB_KINDS, enqueue, type AgentJobKind } from './queue.service.js';

/**
 * Checkbox 115: the self-perpetuating, table-backed scheduling loop.
 *
 * Vercel Workflow DevKit is deliberately NOT a dependency here: the Postgres row
 * in `scheduler_runs` is the chain of custody, and cron-job.org / Vercel Cron
 * wakes the loop up (POST /api/agent/scheduler/start -> {@link pumpSchedulerChain}).
 *
 * Platform facts this module encodes:
 *  - a workflow run's duration is unlimited, and `sleep()` would be unlimited and
 *    compute-free — but no durable `sleep()` is needed: all slack lives in the
 *    `next_run_at` columns, so a cold start costlessly resumes the chain.
 *  - hard platform ceilings per run: 25,000 events and 10,000 steps. This loop
 *    hands the run off to a successor at {@link HANDOFF_EVENT_THRESHOLD} (1,800)
 *    events, an order of magnitude below both, so the chain is indefinitely
 *    self-perpetuating without ever approaching a cap.
 *  - Vercel Hobby allows ~50,000 events/month. At the 10-minute default tick the
 *    scheduler projects 4,320 ticks/month (43,200 minutes ÷ 10); the module-load
 *    assert below fails fast if that math ever drifts over the ceiling.
 */

const log = createLogger('scheduler-workflow');

/** Fastest tick we allow: Neon Free scales to zero, and the Hobby event budget is finite. */
export const MIN_TICK_INTERVAL_MS = 5 * 60 * 1000;

/** Production cadence: one tick per 10 minutes (4,320 ticks in a 30-day month). */
export const DEFAULT_TICK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Platform ceiling per run: 25,000 events. Documented here for the arithmetic; the
 * loop hands off at {@link HANDOFF_EVENT_THRESHOLD}, an order of magnitude below it.
 */
export const PER_RUN_EVENT_CAP = 25_000;

/** Hand the chain to a successor run once the live run has emitted this many events. */
export const HANDOFF_EVENT_THRESHOLD = 1_800;

/** A run whose heartbeat is older than this many tick intervals is declared stalled. */
export const WATCHDOG_MISSED_TICKS = 3;

/** Routines processed (and steps taken) in one tick; the due scan is bounded by design. */
const DUE_ROUTINES_PER_TICK = 50;

/** Single chain for now; the column exists so future chains can coexist. */
const CHAIN_ID = 'default';

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;
const HOBBY_MONTHLY_EVENT_CEILING = 50_000;
const DEFAULT_ROUTINE_INTERVAL_MINUTES = 24 * 60;

/**
 * Master switch for the agent workflows. Defaults to ON so a fresh deployment keeps
 * ticking; `WORKFLOWS_ENABLED=false` (or `0` / `off`) disables every export here —
 * when disabled, NOTHING runs and the plain queue drain is untouched.
 */
export function isWorkflowsEnabled(): boolean {
  const raw = process.env.WORKFLOWS_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

/** Clamp any caller-supplied interval to the Neon Free scale-to-zero floor. */
function normalizeTickInterval(intervalMs: number | null | undefined): number {
  const candidate =
    typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0
      ? Math.trunc(intervalMs)
      : DEFAULT_TICK_INTERVAL_MS;
  return Math.max(candidate, MIN_TICK_INTERVAL_MS);
}

/**
 * Ticks the scheduler projects in a 30-day month at `intervalMs` (default 10 min):
 * 43,200 minutes ÷ 10 = **4,320 ticks/month** — the math behind
 * {@link PROJECTED_MONTHLY_EVENTS} and the Hobby 50,000-events/month budget.
 */
export function computeProjectedMonthlyEvents(intervalMs: number = DEFAULT_TICK_INTERVAL_MS): number {
  return Math.ceil(MS_PER_MONTH / normalizeTickInterval(intervalMs));
}

/** Module-load projection for the default cadence; asserted below the Hobby ceiling. */
export const PROJECTED_MONTHLY_EVENTS = computeProjectedMonthlyEvents();

if (PROJECTED_MONTHLY_EVENTS >= HOBBY_MONTHLY_EVENT_CEILING) {
  throw new Error(
    `scheduler: ${PROJECTED_MONTHLY_EVENTS} projected events/month >= Hobby ceiling ` +
      `(${HOBBY_MONTHLY_EVENT_CEILING}); raise the tick interval (floor ${MIN_TICK_INTERVAL_MS} ms).`,
  );
}

export type SchedulerRunStatus = 'running' | 'handed_off' | 'stalled' | 'stopped';

const RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'handed_off', 'stalled', 'stopped']);

const AGENT_JOB_KIND_SET: ReadonlySet<string> = new Set(AGENT_JOB_KINDS);

function isAgentJobKind(kind: string): kind is AgentJobKind {
  return AGENT_JOB_KIND_SET.has(kind);
}

export interface SchedulerRunRow {
  id: string;
  chainId: string;
  parentRunId: string | null;
  status: SchedulerRunStatus;
  tickIntervalMs: number;
  stepCount: number;
  eventCount: number;
  startedAt: string | null;
  lastTickAt: string | null;
  handedOffAt: string | null;
  endedAt: string | null;
  meta: Record<string, unknown> | null;
}

export interface AgentRoutineRow {
  id: string;
  userId: number;
  name: string;
  kind: string;
  cronExpr: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  config: Record<string, unknown> | null;
}

export interface SchedulerTickRow {
  id: number;
  runId: string;
  at: string | null;
  dueCount: number;
  ranCount: number;
  skippedCount: number;
  errorCount: number;
  detail: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunStatus(value: unknown): value is SchedulerRunStatus {
  return typeof value === 'string' && RUN_STATUSES.has(value);
}

/** pg surfaces timestamptz as `Date`; normalise everything to an ISO string (or null). */
function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapRun(row: unknown): SchedulerRunRow {
  const record = isRecord(row) ? row : {};
  return {
    id: String(record.id ?? ''),
    chainId: typeof record.chain_id === 'string' ? record.chain_id : CHAIN_ID,
    parentRunId: record.parent_run_id == null ? null : String(record.parent_run_id),
    status: isRunStatus(record.status) ? record.status : 'running',
    tickIntervalMs: normalizeTickInterval(numberOr(record.tick_interval_ms, DEFAULT_TICK_INTERVAL_MS)),
    stepCount: numberOr(record.step_count, 0),
    eventCount: numberOr(record.event_count, 0),
    startedAt: toIsoOrNull(record.started_at),
    lastTickAt: toIsoOrNull(record.last_tick_at),
    handedOffAt: toIsoOrNull(record.handed_off_at),
    endedAt: toIsoOrNull(record.ended_at),
    meta: isRecord(record.meta) ? record.meta : null,
  };
}

function mapRoutine(row: unknown): AgentRoutineRow {
  const record = isRecord(row) ? row : {};
  return {
    id: String(record.id ?? ''),
    userId: numberOr(record.user_id, 0),
    name: typeof record.name === 'string' ? record.name : '',
    kind: typeof record.kind === 'string' ? record.kind : '',
    cronExpr: typeof record.cron_expr === 'string' ? record.cron_expr : null,
    enabled: record.enabled === true,
    nextRunAt: toIsoOrNull(record.next_run_at),
    lastRunAt: toIsoOrNull(record.last_run_at),
    config: isRecord(record.config) ? record.config : null,
  };
}

function mapTick(row: unknown): SchedulerTickRow {
  const record = isRecord(row) ? row : {};
  return {
    id: numberOr(record.id, 0),
    runId: String(record.run_id ?? ''),
    at: toIsoOrNull(record.at),
    dueCount: numberOr(record.due_count, 0),
    ranCount: numberOr(record.ran_count, 0),
    skippedCount: numberOr(record.skipped_count, 0),
    errorCount: numberOr(record.error_count, 0),
    detail: isRecord(record.detail) ? record.detail : null,
  };
}

/** The live run of the chain, if one exists. */
async function selectActiveRun(): Promise<SchedulerRunRow | null> {
  const result = await query(
    `SELECT * FROM scheduler_runs
     WHERE chain_id = $1 AND status = 'running'
     ORDER BY started_at DESC
     LIMIT 1`,
    [CHAIN_ID],
  );
  return result.rows.length > 0 ? mapRun(result.rows[0]) : null;
}

/**
 * Create the successor run for a finished/stalled parent, or return the live one.
 *
 * `last_tick_at = NULL` makes the successor due immediately ("ticks promptly").
 * Concurrency: the partial unique index over `(chain_id) WHERE status = 'running'`
 * plus `ON CONFLICT ... DO NOTHING` + re-select means N concurrent callers converge
 * on EXACTLY ONE live run; the loser of the race returns the winner's row.
 */
async function createSuccessorRun(
  parent: SchedulerRunRow,
  reason: 'handoff' | 'stall-restart',
): Promise<SchedulerRunRow | null> {
  const inserted = await query(
    `INSERT INTO scheduler_runs (chain_id, parent_run_id, status, tick_interval_ms, last_tick_at, meta)
     VALUES ($1, $2, 'running', $3, NULL, $4::jsonb)
     ON CONFLICT (chain_id) WHERE status = 'running' DO NOTHING
     RETURNING *`,
    [
      parent.chainId,
      parent.id,
      parent.tickIntervalMs,
      JSON.stringify({ reason, parentRunId: parent.id }),
    ],
  );
  if (inserted.rows.length > 0) return mapRun(inserted.rows[0]);
  return selectActiveRun();
}

/**
 * Idempotent bootstrap: create the chain's first run only when no live run exists.
 *
 * The `INSERT ... ON CONFLICT (chain_id) WHERE status = 'running' DO NOTHING` races
 * safely: concurrent callers either win the insert or fall through to the re-select,
 * so calling this twice (or from two instances at once) yields ONE chain.
 */
export async function bootstrapSchedulerChain(): Promise<SchedulerRunRow | null> {
  if (!isWorkflowsEnabled()) return null;
  const inserted = await query(
    `INSERT INTO scheduler_runs (chain_id, status, tick_interval_ms)
     VALUES ($1, 'running', $2)
     ON CONFLICT (chain_id) WHERE status = 'running' DO NOTHING
     RETURNING *`,
    [CHAIN_ID, DEFAULT_TICK_INTERVAL_MS],
  );
  if (inserted.rows.length > 0) return mapRun(inserted.rows[0]);
  return selectActiveRun();
}

export type SchedulerWatchdogAction = 'disabled' | 'bootstrapped' | 'healthy' | 'restarted';

export interface SchedulerWatchdogResult {
  action: SchedulerWatchdogAction;
  /** The live run after the watchdog pass (the successor when `restarted`). */
  run: SchedulerRunRow | null;
}

/**
 * Heartbeat watchdog: restart the chain when the active run has not ticked for
 * {@link WATCHDOG_MISSED_TICKS} intervals (using `started_at` for a run that never
 * ticked). The stall transition is a single CAS statement, so of N concurrent
 * watchdogs exactly one flips `running -> stalled` and creates the successor; the
 * others observe 0 rows and report `healthy`. No active run => bootstrap.
 */
export async function runSchedulerWatchdog(): Promise<SchedulerWatchdogResult> {
  if (!isWorkflowsEnabled()) return { action: 'disabled', run: null };

  const active = await selectActiveRun();
  if (!active) {
    const bootstrapped = await bootstrapSchedulerChain();
    return { action: 'bootstrapped', run: bootstrapped };
  }

  const missedSeconds = (WATCHDOG_MISSED_TICKS * normalizeTickInterval(active.tickIntervalMs)) / 1000;
  const stalled = await query(
    `UPDATE scheduler_runs
     SET status = 'stalled', ended_at = now()
     WHERE id = $1 AND status = 'running'
       AND COALESCE(last_tick_at, started_at) <= now() - make_interval(secs => $2::double precision)
     RETURNING *`,
    [active.id, missedSeconds],
  );
  if (stalled.rows.length === 0) {
    // Fresh heartbeat, or another watchdog won the CAS and already parked a successor.
    return { action: 'healthy', run: await selectActiveRun() };
  }

  const successor = await createSuccessorRun(mapRun(stalled.rows[0]), 'stall-restart');
  log.warn(
    {
      event: 'scheduler.watchdog_restart',
      stalledRunId: active.id,
      successorRunId: successor?.id ?? null,
      missedTicks: WATCHDOG_MISSED_TICKS,
    },
    'Scheduler run stalled; a successor was created and ticks promptly',
  );
  return { action: 'restarted', run: successor };
}

export interface RoutineTickContext {
  /** The scheduler run that owns this tick (linked into the job payload for tracing). */
  runId: string;
}

export type RoutineTickOutcome =
  | {
      status: 'ran';
      reason: 'enqueued';
      jobId: string | null;
      jobCreated: boolean;
      nextRunAt: string;
    }
  | { status: 'skipped'; reason: 'disabled' | 'unknown-kind' | 'cas-conflict' };

/**
 * How many minutes until a routine's next slot, in documented precedence:
 *   1. `config.tick_interval_minutes` (explicit per-routine cadence),
 *   2. the every-N-minutes form of `cron_expr` (`*\/N * * * *`),
 *   3. 1440 minutes (once per day) as the default.
 * Richer 5-field crons (`0 7 * * *`) are NOT interpreted here — the table slot only
 * understands the every-N-minutes form; such routines re-run daily.
 */
export function resolveRoutineIntervalMinutes(routine: {
  config: Record<string, unknown> | null;
  cronExpr: string | null;
}): number {
  const configured = routine.config?.tick_interval_minutes;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.max(Math.trunc(configured), 1);
  }
  const fromCron = parseEveryMinutesCron(routine.cronExpr);
  if (fromCron !== null) return fromCron;
  return DEFAULT_ROUTINE_INTERVAL_MINUTES;
}

function parseEveryMinutesCron(cronExpr: string | null): number | null {
  if (!cronExpr) return null;
  const match = /^\*\/([0-9]{1,4})\s+\*\s+\*\s+\*\s+\*$/.exec(cronExpr.trim());
  if (!match) return null;
  const minutes = Number.parseInt(match[1] ?? '', 10);
  return Number.isInteger(minutes) && minutes > 0 ? minutes : null;
}

/**
 * One routine, one step — idempotent in BOTH directions (no double-run, no lost run):
 *
 *  (i) ENQUEUE FIRST with `idempotencyKey = routine:<id>:<slotKey>`, where `slotKey`
 *      is the observed `next_run_at ?? last_run_at ?? 'genesis'`. The unique partial
 *      index on `(user_id, idempotency_key)` suppresses a replay's duplicate insert,
 *      so two workers observing the same slot can only ever create ONE job.
 * (ii) THEN advance with a compare-and-swap: the UPDATE matches only when the row
 *      still carries the observed `next_run_at`/`last_run_at` values; 0 rows means
 *      another process already ran this slot — we skip, and nothing is lost because
 *      that process enqueued under the same idempotency key.
 *
 * Crash windows are safe either way: enqueue-then-CAS means losing the CAS never
 * loses the job (the winner's enqueue is the same key), and crashing after enqueue
 * but before the CAS repeats both steps next tick — the dedupe suppresses the
 * second insert and the CAS then succeeds cleanly.
 *
 * Only kinds present in `AGENT_JOB_KINDS` are enqueued; an unknown kind is skipped
 * (never an error loop) because no handler could ever execute it.
 */
export async function runRoutineTickStep(
  routine: AgentRoutineRow,
  ctx: RoutineTickContext,
): Promise<RoutineTickOutcome> {
  if (!routine.enabled) return { status: 'skipped', reason: 'disabled' };
  const kind = routine.kind;
  if (!isAgentJobKind(kind)) return { status: 'skipped', reason: 'unknown-kind' };

  const observedNext = routine.nextRunAt;
  const observedLast = routine.lastRunAt;
  const slotKey = observedNext ?? observedLast ?? 'genesis';

  const job = await enqueue(
    kind,
    { routine_id: routine.id, run_id: ctx.runId },
    { userId: routine.userId, idempotencyKey: `routine:${routine.id}:${slotKey}` },
  );

  const nextRunAt = new Date(
    Date.now() + resolveRoutineIntervalMinutes(routine) * 60_000,
  ).toISOString();
  const advanced = await query(
    `UPDATE agent_routines
     SET last_run_at = now(), next_run_at = $2::timestamptz
     WHERE id = $1
       AND enabled = TRUE
       AND date_trunc('milliseconds', next_run_at) IS NOT DISTINCT FROM date_trunc('milliseconds', $3::timestamptz)
       AND date_trunc('milliseconds', last_run_at) IS NOT DISTINCT FROM date_trunc('milliseconds', $4::timestamptz)
     RETURNING id`,
    [routine.id, nextRunAt, observedNext, observedLast],
  );
  if (advanced.rowCount === 0) {
    return { status: 'skipped', reason: 'cas-conflict' };
  }
  return { status: 'ran', reason: 'enqueued', jobId: job.id, jobCreated: job.created, nextRunAt };
}

export interface SchedulerTickSummary {
  dueCount: number;
  ranCount: number;
  skippedCount: number;
  errorCount: number;
}

export type SchedulerPumpReason = 'ticked' | 'not-due' | 'disabled' | 'no-run';

export interface SchedulerPumpResult {
  enabled: boolean;
  ticked: boolean;
  reason: SchedulerPumpReason;
  runId: string | null;
  /** The tick counters when `ticked` is true, otherwise null. */
  tick: SchedulerTickSummary | null;
  handedOff: boolean;
  successorRunId: string | null;
}

/**
 * One HTTP-callback's worth of work: ensure/bootstrap, watchdog, then AT MOST one
 * due tick. Safe to call concurrently and repeatedly — the tick is claimed with a
 * CAS on `last_tick_at`, so a duplicate callback is a cheap no-op ("not-due")
 * instead of a second tick.
 */
export async function pumpSchedulerChain(): Promise<SchedulerPumpResult> {
  if (!isWorkflowsEnabled()) {
    return {
      enabled: false,
      ticked: false,
      reason: 'disabled',
      runId: null,
      tick: null,
      handedOff: false,
      successorRunId: null,
    };
  }

  // 1. Ensure/bootstrap + watchdog. `runSchedulerWatchdog()` restarts a stalled run
  //    (its successor has `last_tick_at = NULL`, so it is due immediately).
  const watchdog = await runSchedulerWatchdog();
  const active = watchdog.run;
  if (!active) {
    return {
      enabled: true,
      ticked: false,
      reason: 'no-run',
      runId: null,
      tick: null,
      handedOff: false,
      successorRunId: null,
    };
  }

  // 2. Claim this tick: exactly ONE concurrent pump can win this CAS.
  const intervalMs = normalizeTickInterval(active.tickIntervalMs);
  const claimed = await query(
    `UPDATE scheduler_runs
     SET last_tick_at = now()
     WHERE id = $1 AND status = 'running'
       AND (last_tick_at IS NULL OR last_tick_at <= now() - make_interval(secs => $2::double precision))
     RETURNING *`,
    [active.id, intervalMs / 1000],
  );
  if (claimed.rows.length === 0) {
    // Not due yet, or a concurrent pump already claimed this tick.
    return {
      enabled: true,
      ticked: false,
      reason: 'not-due',
      runId: active.id,
      tick: null,
      handedOff: false,
      successorRunId: null,
    };
  }
  const run = mapRun(claimed.rows[0]);

  // 3. ONE tick: at most 50 due routines, each processed as ONE step.
  const due = await query(
    `SELECT * FROM agent_routines
     WHERE enabled = TRUE AND (next_run_at IS NULL OR next_run_at <= now())
     ORDER BY next_run_at ASC NULLS FIRST, name ASC
     LIMIT $1`,
    [DUE_ROUTINES_PER_TICK],
  );
  const tick: SchedulerTickSummary = {
    dueCount: due.rows.length,
    ranCount: 0,
    skippedCount: 0,
    errorCount: 0,
  };
  for (const row of due.rows) {
    const routine = mapRoutine(row);
    try {
      const outcome = await runRoutineTickStep(routine, { runId: run.id });
      if (outcome.status === 'ran') tick.ranCount += 1;
      else tick.skippedCount += 1;
    } catch (error) {
      // One bad routine must never wedge the tick (or the chain).
      tick.errorCount += 1;
      log.error(
        { event: 'scheduler.routine_tick_failed', routineId: routine.id, kind: routine.kind, err: error },
        'Routine tick step threw; the tick continues',
      );
    }
  }

  // 4. One ledger row per executed tick.
  await query(
    `INSERT INTO scheduler_ticks (run_id, due_count, ran_count, skipped_count, error_count, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [run.id, tick.dueCount, tick.ranCount, tick.skippedCount, tick.errorCount, JSON.stringify(tick)],
  );

  // 5. Atomic counters: every processed routine is one step; every successful step
  //    emits (at most) one queue event. Both stay far below the platform ceilings.
  const bumped = await query(
    `UPDATE scheduler_runs
     SET step_count = step_count + $2, event_count = event_count + $3
     WHERE id = $1 AND status = 'running'
     RETURNING *`,
    [run.id, tick.dueCount, tick.ranCount],
  );

  // 6. Hand the chain off before the run gets anywhere near the per-run caps.
  let handedOff = false;
  let successorRunId: string | null = null;
  if (bumped.rows.length > 0) {
    const counted = mapRun(bumped.rows[0]);
    if (counted.eventCount >= HANDOFF_EVENT_THRESHOLD) {
      const handoff = await handoffSchedulerRun(counted);
      handedOff = handoff.handedOff;
      successorRunId = handoff.successor?.id ?? null;
    }
  }

  return {
    enabled: true,
    ticked: true,
    reason: 'ticked',
    runId: run.id,
    tick,
    handedOff,
    successorRunId,
  };
}

export interface SchedulerHandoffResult {
  /** True only for the caller that actually flipped the run to `handed_off`. */
  handedOff: boolean;
  successor: SchedulerRunRow | null;
}

/**
 * Park `run` as `handed_off` and ensure its successor exists, so the chain outlives
 * any single run's counters. Idempotent on replay: a second call transitions 0 rows
 * and the successor insert either conflicts (returning the existing live run) or
 * bootstraps a fresh one — concurrent replays still converge on ONE live run.
 */
export async function handoffSchedulerRun(run: SchedulerRunRow): Promise<SchedulerHandoffResult> {
  const transitioned = await query(
    `UPDATE scheduler_runs
     SET status = 'handed_off', handed_off_at = now(), ended_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING *`,
    [run.id],
  );
  const successor = await createSuccessorRun(run, 'handoff');
  if (transitioned.rows.length > 0) {
    log.info(
      { event: 'scheduler.handoff', runId: run.id, successorRunId: successor?.id ?? null },
      'Scheduler run handed off to a successor',
    );
  }
  return { handedOff: transitioned.rows.length > 0, successor };
}

export interface SchedulerStatus {
  enabled: boolean;
  chainId: string;
  activeRun: SchedulerRunRow | null;
  /** Most recent tick ledger row of the active run, if any. */
  lastTick: SchedulerTickRow | null;
  projectedMonthlyEvents: number;
}

/**
 * Read-only status for `GET /api/agent/scheduler/status`: active run, last tick,
 * the enabled flag and the projected monthly event budget. When the workflows are
 * disabled this does not touch the database at all.
 */
export async function getSchedulerStatus(): Promise<SchedulerStatus> {
  const projectedMonthlyEvents = PROJECTED_MONTHLY_EVENTS;
  if (!isWorkflowsEnabled()) {
    return { enabled: false, chainId: CHAIN_ID, activeRun: null, lastTick: null, projectedMonthlyEvents };
  }
  const activeRun = await selectActiveRun();
  let lastTick: SchedulerTickRow | null = null;
  if (activeRun) {
    const result = await query(
      `SELECT * FROM scheduler_ticks
       WHERE run_id = $1
       ORDER BY at DESC, id DESC
       LIMIT 1`,
      [activeRun.id],
    );
    lastTick = result.rows.length > 0 ? mapTick(result.rows[0]) : null;
  }
  return { enabled: true, chainId: CHAIN_ID, activeRun, lastTick, projectedMonthlyEvents };
}
