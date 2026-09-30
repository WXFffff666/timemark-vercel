import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

/**
 * Checkbox 121(g): Neon CU-hour budget guard + schedule registry + the hot/cold split
 * for `/api/cron/reminder-check`.
 *
 * ARITHMETIC (Neon bills compute as CU-hours; Free = 100 CU-hours/project/month):
 *
 *   always-on 0.25 CU  ->  0.25 CU x 730 h = 182.5 CU-h/month  (OVER the 100 CU-h free
 *                          allowance: an always-awake 0.25 CU compute alone burns 182.5%
 *                          of the free plan, hence this guard).
 *   10-minute ticks    ->  6 ticks/h x 720 h = 4320 ticks/month; a 3-second wake each at
 *                          0.25 CU = 4320 x 3 s x 0.25 CU = 3240 CU-s = 0.9 CU-h/month
 *                          (well under budget - the hot path must simply never wake the
 *                          compute for ticks that have no work, which is what the
 *                          hot/cold split below enforces).
 *
 * The guard alerts ONCE at 70% and ONCE at 90% of the monthly allowance. Alert identity
 * is `(month, threshold)`; the in-memory `NeonBudgetGuard` dedupes per process, and
 * `recordNeonBudgetAlert` dedupes across cold-started instances through
 * `agent_neon_budget_alerts` (pending DDL 60-notification-budget.sql).
 *
 * SCHEDULE REGISTRY: every scheduled job declares its cadence and how often it may touch
 * Postgres; `validateScheduleRegistry` asserts the hard floor - NO scheduled job opens a
 * Postgres connection more often than every 5 minutes. The reminder-check entry is the
 * only minute-cadence job and it declares `touchesPostgres: false` + a 5-minute Postgres
 * floor: its per-minute tick is the HOT path (in-memory/edge KV due index, zero Postgres),
 * and only a tick that is actually due reaches the COLD Postgres path
 * (`createReminderCheckHotPath`).
 */

const log = createLogger('neon-budget');

export const NEON_FREE_CU_HOURS_PER_MONTH = 100;
export const NEON_ALERT_THRESHOLDS = [70, 90] as const;
export const DEFAULT_COMPUTE_UNITS = 0.25;
export const DEFAULT_ALWAYS_ON_HOURS_PER_MONTH = 730;
export const DEFAULT_DAYS_PER_MONTH = 30;
export const MIN_POSTGRES_TOUCH_INTERVAL_MINUTES = 5;

export const NEON_BUDGET_ENV = {
  monthlyCuHours: 'NEON_FREE_CU_HOURS_PER_MONTH',
  computeUnits: 'NEON_COMPUTE_UNITS',
} as const;

// ---------------------------------------------------------------------------
// CU-hour arithmetic
// ---------------------------------------------------------------------------

export interface NeonBudgetEstimate {
  computeUnits: number;
  awakeHours: number;
  cuHours: number;
  budgetCuHours: number;
  percent: number;
  overBudget: boolean;
}

function toPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** CU-hours = compute units x awake hours. */
export function estimateCuHours(computeUnits: number, awakeHours: number): number {
  return toPositive(computeUnits, DEFAULT_COMPUTE_UNITS) * Math.max(0, awakeHours);
}

/** Reference case A: an always-awake compute. 0.25 CU x 730 h = 182.5 CU-h/month. */
export function estimateAlwaysOnCuHours(
  computeUnits: number = DEFAULT_COMPUTE_UNITS,
  hoursPerMonth: number = DEFAULT_ALWAYS_ON_HOURS_PER_MONTH,
): number {
  return estimateCuHours(computeUnits, hoursPerMonth);
}

/**
 * Reference case B: scheduled ticks. Each tick wakes the compute for `wakeSeconds`.
 * 10-min ticks, 3 s wake, 0.25 CU, 30-day month = 4320 ticks x 3 s x 0.25 CU
 * = 3240 CU-s = 0.9 CU-h/month.
 */
export function estimateScheduledCuHours(options: {
  cadenceMinutes: number;
  wakeSeconds: number;
  computeUnits?: number;
  daysPerMonth?: number;
}): { ticksPerMonth: number; cuHours: number } {
  const cadence = toPositive(options.cadenceMinutes, 10);
  const wakeSeconds = Math.max(0, options.wakeSeconds);
  const computeUnits = toPositive(options.computeUnits ?? DEFAULT_COMPUTE_UNITS, DEFAULT_COMPUTE_UNITS);
  const days = toPositive(options.daysPerMonth ?? DEFAULT_DAYS_PER_MONTH, DEFAULT_DAYS_PER_MONTH);
  const ticksPerMonth = (days * 24 * 60) / cadence;
  const cuHours = (ticksPerMonth * wakeSeconds * computeUnits) / 3600;
  return { ticksPerMonth, cuHours };
}

export function buildNeonEstimate(
  computeUnits: number,
  awakeHours: number,
  budgetCuHours: number = NEON_FREE_CU_HOURS_PER_MONTH,
): NeonBudgetEstimate {
  const cuHours = estimateCuHours(computeUnits, awakeHours);
  const budget = toPositive(budgetCuHours, NEON_FREE_CU_HOURS_PER_MONTH);
  const percent = (cuHours / budget) * 100;
  return { computeUnits, awakeHours, cuHours, budgetCuHours: budget, percent, overBudget: cuHours > budget };
}

// ---------------------------------------------------------------------------
// Threshold alerts (once at 70%, once at 90%)
// ---------------------------------------------------------------------------

export interface NeonBudgetAlert {
  month: string;
  threshold: number;
  percent: number;
  cuHours: number;
  budgetCuHours: number;
}

/**
 * Highest crossed threshold that has not been alerted yet; null when no alert is due.
 * `alreadyAlerted` is the persistable alert identity for the month.
 */
export function evaluateNeonBudgetUsage(
  month: string,
  cuHours: number,
  budgetCuHours: number = NEON_FREE_CU_HOURS_PER_MONTH,
  alreadyAlerted: readonly number[] = [],
): NeonBudgetAlert | null {
  const budget = toPositive(budgetCuHours, NEON_FREE_CU_HOURS_PER_MONTH);
  const percent = (Math.max(0, cuHours) / budget) * 100;
  let crossed: number | null = null;
  for (const threshold of NEON_ALERT_THRESHOLDS) {
    if (percent >= threshold && !alreadyAlerted.includes(threshold)) crossed = threshold;
  }
  if (crossed === null) return null;
  return { month, threshold: crossed, percent, cuHours, budgetCuHours: budget };
}

/** Per-process once-per-month alert dedupe; pair with `recordNeonBudgetAlert` for cross-instance dedupe. */
export class NeonBudgetGuard {
  private readonly alerted = new Map<string, Set<number>>();

  check(
    month: string,
    cuHours: number,
    budgetCuHours: number = NEON_FREE_CU_HOURS_PER_MONTH,
  ): NeonBudgetAlert | null {
    const fired = this.alerted.get(month) ?? new Set<number>();
    const alert = evaluateNeonBudgetUsage(month, cuHours, budgetCuHours, [...fired]);
    if (alert !== null) {
      fired.add(alert.threshold);
      this.alerted.set(month, fired);
    }
    return alert;
  }
}

/**
 * Cross-instance alert ledger (pending DDL). Returns true when THIS caller recorded the
 * alert first (i.e. it should send it); false = another instance already did, or the
 * ledger table is not deployed yet (then the caller still alerts, at-least-once).
 */
export async function recordNeonBudgetAlert(
  month: string,
  threshold: number,
  cuHours: number,
): Promise<boolean> {
  try {
    const result = await query(
      `INSERT INTO agent_neon_budget_alerts (month, threshold_percent, cu_hours)
       VALUES ($1, $2, $3)
       ON CONFLICT (month, threshold_percent) DO NOTHING
       RETURNING month`,
      [month, threshold, cuHours],
    );
    return result.rows.length > 0;
  } catch (error) {
    log.warn(
      { event: 'neon_budget.alert_ledger_unavailable', month, threshold, err: error },
      'Neon budget alert ledger unavailable; alerting at-least-once',
    );
    return true;
  }
}

export async function checkNeonBudget(
  month: string,
  cuHours: number,
  alreadyAlerted: readonly number[] = [],
  budgetCuHours: number = NEON_FREE_CU_HOURS_PER_MONTH,
): Promise<NeonBudgetAlert | null> {
  const alert = evaluateNeonBudgetUsage(month, cuHours, budgetCuHours, alreadyAlerted);
  if (alert === null) return null;
  const first = await recordNeonBudgetAlert(month, alert.threshold, alert.cuHours);
  if (!first) return null;
  log.warn(
    {
      event: 'neon_budget.threshold_crossed',
      month,
      threshold: alert.threshold,
      percent: Math.round(alert.percent * 10) / 10,
      cuHours: alert.cuHours,
      budgetCuHours: alert.budgetCuHours,
    },
    `Neon compute crossed ${alert.threshold}% of the free monthly CU-hour allowance`,
  );
  return alert;
}

// ---------------------------------------------------------------------------
// Schedule registry (asserted by the integrator)
// ---------------------------------------------------------------------------

export interface ScheduledJobSpec {
  job: string;
  /** Nominal invocation cadence. */
  cadenceMinutes: number;
  /** True when the job opens a Postgres connection on every invocation. */
  touchesPostgres: boolean;
  /** Floor between two Postgres touches; must be >= MIN_POSTGRES_TOUCH_INTERVAL_MINUTES. */
  postgresMinIntervalMinutes: number;
  /** Set when the job's cheap tick is DB-free and only escalates when due. */
  hotPath: 'in_memory_due_index' | null;
}

/**
 * The registry the integrator asserts over (`validateScheduleRegistry` returns []).
 * reminder-check is the minute-cadence HOT path: it touches Postgres only when work is
 * due, at most once per the 5-minute floor.
 */
export const SCHEDULE_REGISTRY: readonly ScheduledJobSpec[] = [
  { job: 'reminder-check', cadenceMinutes: 1, touchesPostgres: false, postgresMinIntervalMinutes: 5, hotPath: 'in_memory_due_index' },
  { job: 'retry-notifications', cadenceMinutes: 10, touchesPostgres: true, postgresMinIntervalMinutes: 10, hotPath: null },
  { job: 'calendar-sync', cadenceMinutes: 15, touchesPostgres: true, postgresMinIntervalMinutes: 15, hotPath: null },
  { job: 'caldav-sync', cadenceMinutes: 15, touchesPostgres: true, postgresMinIntervalMinutes: 15, hotPath: null },
  { job: 'channel-health', cadenceMinutes: 1440, touchesPostgres: true, postgresMinIntervalMinutes: 1440, hotPath: null },
  { job: 'lunar-phase-reminders', cadenceMinutes: 1440, touchesPostgres: true, postgresMinIntervalMinutes: 1440, hotPath: null },
  { job: 'digest-monthly', cadenceMinutes: 43_200, touchesPostgres: true, postgresMinIntervalMinutes: 43_200, hotPath: null },
  { job: 'daily-maintenance', cadenceMinutes: 1440, touchesPostgres: true, postgresMinIntervalMinutes: 1440, hotPath: null },
];

/** Violations, empty array = registry obeys the 5-minute Postgres floor. */
export function validateScheduleRegistry(
  entries: readonly ScheduledJobSpec[] = SCHEDULE_REGISTRY,
): string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    if (entry.touchesPostgres && entry.postgresMinIntervalMinutes < MIN_POSTGRES_TOUCH_INTERVAL_MINUTES) {
      violations.push(
        `${entry.job}: postgresMinIntervalMinutes=${entry.postgresMinIntervalMinutes} < ${MIN_POSTGRES_TOUCH_INTERVAL_MINUTES}`,
      );
    }
    if (!entry.touchesPostgres && entry.hotPath === null) {
      violations.push(`${entry.job}: non-Postgres job must declare a hotPath`);
    }
  }
  return violations;
}

/** Estimated monthly CU-hours of a registry entry (Postgres-touching jobs only). */
export function estimateJobCuHours(
  entry: ScheduledJobSpec,
  options: { wakeSeconds?: number; computeUnits?: number; daysPerMonth?: number } = {},
): number {
  if (!entry.touchesPostgres) return 0;
  return estimateScheduledCuHours({
    cadenceMinutes: Math.max(entry.cadenceMinutes, entry.postgresMinIntervalMinutes),
    wakeSeconds: options.wakeSeconds ?? 5,
    computeUnits: options.computeUnits ?? DEFAULT_COMPUTE_UNITS,
    daysPerMonth: options.daysPerMonth ?? DEFAULT_DAYS_PER_MONTH,
  }).cuHours;
}

// ---------------------------------------------------------------------------
// Hot/cold split for /api/cron/reminder-check
// ---------------------------------------------------------------------------

/**
 * Pluggable due-index store. The HOT path asks this (in-memory Map or an edge KV over
 * REST) whether work is due; Postgres is only opened when the answer is yes. The adapter
 * FAILS OPEN on error (returns due=true) so a KV outage can never silently drop a
 * reminder - the Postgres path stays the source of truth.
 */
export interface DueIndexAdapter {
  isDue(key: string, nowMs: number): Promise<boolean>;
  markChecked(key: string, nextDueAtMs: number): Promise<void>;
}

export class InMemoryDueIndex implements DueIndexAdapter {
  private readonly nextDueAt = new Map<string, number>();

  async isDue(key: string, nowMs: number): Promise<boolean> {
    const next = this.nextDueAt.get(key);
    return next === undefined || nowMs >= next;
  }

  async markChecked(key: string, nextDueAtMs: number): Promise<void> {
    this.nextDueAt.set(key, nextDueAtMs);
  }
}

export interface EdgeKvConfig {
  /** KV REST base URL, e.g. https://kv.example.com (one path segment per key). */
  baseUrl: string;
  token?: string;
  keyPrefix?: string;
  fetchImpl?: typeof fetch;
}

/** Edge-KV adapter (Upstash-style REST: GET returns the raw value, 404 = missing). */
export class EdgeKvDueIndex implements DueIndexAdapter {
  constructor(private readonly config: EdgeKvConfig) {}

  private keyUrl(key: string): string {
    const prefix = this.config.keyPrefix ?? 'timemark:due:';
    return `${this.config.baseUrl.replace(/\/+$/, '')}/keys/${encodeURIComponent(`${prefix}${key}`)}`;
  }

  private headers(): Record<string, string> {
    return this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {};
  }

  async isDue(key: string, nowMs: number): Promise<boolean> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(this.keyUrl(key), { headers: this.headers() });
      if (response.status === 404) return true;
      if (!response.ok) return true; // fail open to the Postgres path
      const raw = (await response.text()).trim();
      if (raw === '') return true;
      const next = Number.parseInt(raw, 10);
      return !Number.isFinite(next) || nowMs >= next;
    } catch {
      return true; // fail open: an unreachable KV must never drop a reminder
    }
  }

  async markChecked(key: string, nextDueAtMs: number): Promise<void> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    try {
      await fetchImpl(this.keyUrl(key), {
        method: 'PUT',
        headers: { ...this.headers(), 'content-type': 'text/plain' },
        body: String(Math.trunc(nextDueAtMs)),
      });
    } catch {
      // Advisory only: the Postgres claim path remains the correctness authority.
    }
  }
}

export interface ReminderHotPathOptions<T> {
  /** Pluggable hot due-index (InMemoryDueIndex in tests / EdgeKvDueIndex in prod). */
  dueIndex: DueIndexAdapter;
  /** DB-FREE predicate: does any schedule look due at `nowMs`? (in-memory/KV config). */
  hasDueWork: (nowMs: number) => Promise<boolean> | boolean;
  /** The COLD path: the existing Postgres reminder path (sendReminders). */
  postgresCheck: () => Promise<T>;
  now?: () => number;
  /** Hard floor between Postgres touches; clamped up to the 5-minute registry minimum. */
  minPostgresIntervalMinutes?: number;
  userId?: number;
}

export interface ReminderHotPathResult<T> {
  executed: boolean;
  touchedPostgres: boolean;
  skippedReason: 'no_work_due' | 'hot_index_not_due' | 'min_postgres_interval' | 'already_running' | null;
  result: T | null;
}

/**
 * Build the reminder-check handler with the hot/cold split:
 *   tick -> hasDueWork (NO Postgres) -> dueIndex.isDue (KV/memory) -> 5-min floor
 *        -> ONLY THEN postgresCheck() (the existing Postgres path).
 * Returns the structured outcome so the cron route can report what happened.
 */
export function createReminderCheckHotPath<T>(
  options: ReminderHotPathOptions<T>,
): () => Promise<ReminderHotPathResult<T>> {
  const now = options.now ?? Date.now;
  const intervalMs =
    Math.max(options.minPostgresIntervalMinutes ?? MIN_POSTGRES_TOUCH_INTERVAL_MINUTES, MIN_POSTGRES_TOUCH_INTERVAL_MINUTES) *
    60_000;
  const key = options.userId === undefined ? 'reminder-check' : `reminder-check:${options.userId}`;
  let lastPostgresTouchMs: number | null = null;
  let running = false;

  return async function runReminderCheckHotPath(): Promise<ReminderHotPathResult<T>> {
    if (running) {
      return { executed: false, touchedPostgres: false, skippedReason: 'already_running', result: null };
    }
    running = true;
    try {
      const nowMs = now();
      const due = await options.hasDueWork(nowMs);
      if (!due) {
        return { executed: false, touchedPostgres: false, skippedReason: 'no_work_due', result: null };
      }
      if (!(await options.dueIndex.isDue(key, nowMs))) {
        return { executed: false, touchedPostgres: false, skippedReason: 'hot_index_not_due', result: null };
      }
      if (lastPostgresTouchMs !== null && nowMs - lastPostgresTouchMs < intervalMs) {
        return { executed: false, touchedPostgres: false, skippedReason: 'min_postgres_interval', result: null };
      }
      const result = await options.postgresCheck();
      lastPostgresTouchMs = now();
      await options.dueIndex.markChecked(key, lastPostgresTouchMs + intervalMs);
      return { executed: true, touchedPostgres: true, skippedReason: null, result };
    } finally {
      running = false;
    }
  };
}
