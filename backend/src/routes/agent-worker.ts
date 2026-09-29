import { Hono, type Context, type Next } from 'hono';
import { timingSafeEqual } from 'crypto';
import { getCronSecret } from '../utils/heartbeat.js';
import { query } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { agentQueue, type AgentQueue, type ClaimedJob } from '../services/agent/queue.service.js';

/**
 * Checkbox 114: the bounded worker-drain endpoint + trigger topology.
 *
 *   GET  /api/agent/worker/drain  -> cheap liveness probe (no auth, no DB, no claim)
 *   POST /api/agent/worker/drain  -> CRON_SECRET / AGENT_WORKER_TOKEN guarded drain
 *
 * Trigger topology (docs/CRON.md):
 *  - cron-job.org calls POST every minute with `Authorization: Bearer <secret>` (and the
 *    `X-Requested-With: XMLHttpRequest` marker the app's CSRF guard requires for a machine
 *    POST that carries no Origin/Referer).
 *  - Vercel's built-in daily cron keeps handling batch/maintenance work; minute-level
 *    schedules cannot be expressed on the Hobby plan (vercel.json is checked for that).
 *
 * Bounded by construction - the mechanism is IN the loop, not a hope:
 *  1. `claimBatch(limit, leaseSeconds)` claims AT MOST N jobs (default 3) in one call.
 *  2. `cutAt = start + min(deadlineMs, responseBudgetMs)` (defaults 45 s / 25 s) is the hard
 *     work window. `responseBudgetMs` reserves the margin under cron-job.org's 30 s timeout
 *     while `deadlineMs` caps total work inside the 300 s function limit.
 *  3. Before every job the loop re-checks the remaining budget; each job execution is raced
 *     against `cutAt - now()`. When the budget runs out the loop stops and the response is
 *     serialised immediately - a slow handler can never hold the HTTP response open.
 *  4. Abandoned jobs stay `leased`; the next tick's `reclaimExpiredLeases()` returns them to
 *     `queued` (or dead-letters them) once the lease expires, so nothing is lost.
 *  5. `reclaimExpiredLeases()` runs first on every invocation, recovering leases left behind
 *     by a dead worker before this tick claims new work.
 *
 * The executor seam: no job handler exists yet (Wave 15 registers the routines). The default
 * executor deliberately FAILS a claimed job with the machine-readable `NO_HANDLER` code
 * instead of silently completing it - a silent no-op would mark work done while losing it.
 * Later checkboxes inject/replace the executor without touching the route.
 */

const log = createLogger('agent-worker');

/** Default jobs claimed per invocation; overridable via AGENT_DRAIN_LIMIT or `?limit=`. */
export const DEFAULT_DRAIN_LIMIT = 3;
/** Upper bound for `?limit=` so one call can never claim an unbounded batch. */
export const MAX_DRAIN_LIMIT = 50;
/** Hard per-invocation work budget (plan default: 45 s, well inside the 300 s function limit). */
export const DEFAULT_DRAIN_DEADLINE_MS = 45_000;
/** Response margin under cron-job.org's 30 s HTTP timeout (plan: respond within ~25 s). */
export const DEFAULT_DRAIN_RESPONSE_BUDGET_MS = 25_000;
/** Lease renewal cadence while a job runs. */
export const DEFAULT_DRAIN_HEARTBEAT_INTERVAL_MS = 15_000;
/** Minimum remaining budget before a batch is claimed at all (avoids claim-then-abandon). */
export const DEFAULT_MIN_CLAIM_BUDGET_MS = 250;

/**
 * The exact statement behind `remaining`: queued jobs after this invocation. Unfinished
 * claimed jobs are still `leased` and are added on top of this count by the route.
 */
export const QUEUED_COUNT_SQL = `SELECT COUNT(*)::int AS remaining FROM agent_jobs WHERE status = 'queued'`;

/** Runtime knobs, all injectable for tests and overridable from the environment. */
export interface AgentWorkerDrainConfig {
  limit: number;
  deadlineMs: number;
  responseBudgetMs: number;
  heartbeatIntervalMs: number;
  minClaimBudgetMs: number;
}

/** What an executor returns on success; `void` is accepted for a handler with no result. */
export interface AgentJobExecutionResult {
  result?: unknown;
  costTokens?: number;
}

/** Executes one claimed job. MUST be idempotent (the queue contract is at-least-once). */
export type AgentJobExecutor = (job: ClaimedJob) => Promise<AgentJobExecutionResult | void>;

/** The subset of {@link AgentQueue} the drain needs (injected whole in tests). */
export type AgentWorkerQueue = Pick<
  AgentQueue,
  'claimBatch' | 'heartbeat' | 'complete' | 'fail' | 'reclaimExpiredLeases'
>;

export interface AgentWorkerRouteDeps {
  /** Queue to drain; defaults to the process-wide `agentQueue` singleton. */
  queue?: AgentWorkerQueue;
  /** Executor seam; defaults to the NO_HANDLER-failing executor (see module comment). */
  execute?: AgentJobExecutor;
  /** Clock in epoch ms (injectable for deterministic deadline tests). */
  now?: () => number;
  /** Config overrides; environment values, then defaults, fill the rest. */
  config?: Partial<AgentWorkerDrainConfig>;
  /** Queue-depth source for `remaining`; defaults to {@link QUEUED_COUNT_SQL}. */
  countQueued?: () => Promise<number>;
}

/** The five-key summary the endpoint always returns (plus `error` on an infra failure). */
export interface AgentWorkerDrainSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  reclaimed: number;
  remaining: number;
}

/** Raised by the default executor until a later checkbox registers a real handler. */
export class AgentJobHandlerMissingError extends Error {
  readonly code = 'NO_HANDLER';

  constructor(kind: string) {
    super(`no executor is registered for agent job kind "${kind}"`);
    this.name = 'AgentJobHandlerMissingError';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readEnvInt(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Constrain every knob so no configuration can make the invocation unbounded. */
function resolveConfig(overrides: Partial<AgentWorkerDrainConfig> = {}): AgentWorkerDrainConfig {
  const limit = overrides.limit ?? readEnvInt('AGENT_DRAIN_LIMIT') ?? DEFAULT_DRAIN_LIMIT;
  const deadlineMs = overrides.deadlineMs ?? readEnvInt('AGENT_DRAIN_DEADLINE_MS') ?? DEFAULT_DRAIN_DEADLINE_MS;
  const responseBudgetMs =
    overrides.responseBudgetMs ?? readEnvInt('AGENT_DRAIN_RESPONSE_BUDGET_MS') ?? DEFAULT_DRAIN_RESPONSE_BUDGET_MS;
  const heartbeatIntervalMs =
    overrides.heartbeatIntervalMs ?? readEnvInt('AGENT_DRAIN_HEARTBEAT_MS') ?? DEFAULT_DRAIN_HEARTBEAT_INTERVAL_MS;
  const minClaimBudgetMs =
    overrides.minClaimBudgetMs ?? readEnvInt('AGENT_DRAIN_MIN_CLAIM_MS') ?? DEFAULT_MIN_CLAIM_BUDGET_MS;

  return {
    limit: clamp(Math.trunc(limit), 1, MAX_DRAIN_LIMIT),
    deadlineMs: clamp(Math.trunc(deadlineMs), 50, 120_000),
    responseBudgetMs: clamp(Math.trunc(responseBudgetMs), 20, 120_000),
    heartbeatIntervalMs: clamp(Math.trunc(heartbeatIntervalMs), 10, 60_000),
    minClaimBudgetMs: clamp(Math.trunc(minClaimBudgetMs), 0, 60_000),
  };
}

/**
 * Lease length handed to `claimBatch`: the work window plus 30 s of slack, so a healthy
 * worker never loses a lease mid-run while a dead worker's jobs still become reclaimable
 * within about a minute.
 */
function leaseSecondsFor(config: AgentWorkerDrainConfig): number {
  return Math.max(30, Math.ceil(Math.min(config.deadlineMs, config.responseBudgetMs) / 1000) + 30);
}

/** `Bearer <secret>` against CRON_SECRET and/or AGENT_WORKER_TOKEN, constant-time. */
export function hasValidWorkerCredential(authorization: string | undefined): boolean {
  if (!authorization) return false;
  const candidates = [getCronSecret(), (process.env.AGENT_WORKER_TOKEN ?? '').trim()].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const actual = Buffer.from(authorization);
  return candidates.some((secret) => {
    const expected = Buffer.from(`Bearer ${secret}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

function drainGuard() {
  return async (c: Context, next: Next) => {
    // No configured credential means the endpoint must stay closed, not open (mirrors cron.ts).
    if (!getCronSecret() && !(process.env.AGENT_WORKER_TOKEN ?? '').trim()) {
      return c.json({ error: 'CRON_SECRET / AGENT_WORKER_TOKEN not configured' }, 500);
    }
    if (!hasValidWorkerCredential(c.req.header('Authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  };
}

/** `?limit=` wins, then a JSON `{ "limit": n }` body; invalid/absent -> null (use default). */
async function readRequestedLimit(c: Context): Promise<number | null> {
  const fromQuery = Number.parseInt(c.req.query('limit') ?? '', 10);
  if (Number.isInteger(fromQuery) && fromQuery > 0) return clamp(fromQuery, 1, MAX_DRAIN_LIMIT);

  const body: unknown = await c.req.json().catch(() => null);
  if (body && typeof body === 'object' && 'limit' in body) {
    const raw = (body as Record<string, unknown>).limit;
    const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isInteger(parsed) && parsed > 0) return clamp(parsed, 1, MAX_DRAIN_LIMIT);
  }
  return null;
}

type ExecutionOutcome =
  | { kind: 'ok'; value: AgentJobExecutionResult | void }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

/**
 * Race the executor against the remaining budget. A timeout means "not finished", never
 * "failed": the row is left `leased` so the next tick reclaims it. The losing promise is
 * wrapped so a late rejection can never become an unhandled rejection.
 */
async function executeWithinBudget(
  execute: AgentJobExecutor,
  job: ClaimedJob,
  budgetMs: number,
): Promise<ExecutionOutcome> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return { kind: 'timeout' };
  const execution = Promise.resolve()
    .then(() => execute(job))
    .then((value): ExecutionOutcome => ({ kind: 'ok', value }))
    .catch((error: unknown): ExecutionOutcome => ({ kind: 'error', error }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<ExecutionOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), budgetMs);
  });
  try {
    return await Promise.race([execution, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim() !== '') return code.slice(0, 64);
  }
  return 'EXECUTION_FAILED';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Best-effort lease renewal; a rejected heartbeat is logged, never thrown. */
async function pulse(queue: AgentWorkerQueue, job: ClaimedJob, extendSeconds: number): Promise<void> {
  try {
    const renewed = await queue.heartbeat(job.id, job.leaseToken, extendSeconds);
    if (!renewed.renewed) {
      log.warn(
        { event: 'agent_worker.heartbeat_rejected', jobId: job.id, jobKind: job.kind },
        'Lease renewal was rejected; the lease may have expired',
      );
    }
  } catch (error) {
    log.warn(
      { event: 'agent_worker.heartbeat_failed', jobId: job.id, jobKind: job.kind, err: error },
      'Lease heartbeat threw; the job lease was not renewed',
    );
  }
}

/** Record a job failure. A write failure is logged loudly and still counted as failed. */
async function recordFailure(
  queue: AgentWorkerQueue,
  job: ClaimedJob,
  error: unknown,
): Promise<void> {
  const code = errorCodeOf(error);
  const message = errorMessageOf(error);
  try {
    const recorded = await queue.fail(job.id, job.leaseToken, code, message, true);
    if (recorded.recorded) {
      log.warn(
        { event: 'agent_worker.job_failed', jobId: job.id, jobKind: job.kind, code, outcome: recorded.outcome },
        'Job execution failed and was recorded on the queue',
      );
    } else {
      log.warn(
        { event: 'agent_worker.fail_rejected', jobId: job.id, jobKind: job.kind, code },
        'Job failure could not be recorded (lease no longer live); the reclaimer will handle it',
      );
    }
  } catch (writeError) {
    log.error(
      { event: 'agent_worker.fail_write_failed', jobId: job.id, jobKind: job.kind, code, err: writeError },
      'Recording the job failure threw; the lease will expire and the job will be reclaimed',
    );
  }
}

const defaultExecutor: AgentJobExecutor = async (job) => {
  throw new AgentJobHandlerMissingError(job.kind);
};

async function defaultCountQueued(): Promise<number> {
  const result = await query(QUEUED_COUNT_SQL);
  const value = Number(result.rows[0]?.remaining ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** Build the drain router. Tests inject the queue/executor/clock; production uses defaults. */
export function createAgentWorkerRoutes(deps: AgentWorkerRouteDeps = {}): Hono {
  const queue = deps.queue ?? agentQueue;
  const execute = deps.execute ?? defaultExecutor;
  const now = deps.now ?? (() => Date.now());
  const countQueued = deps.countQueued ?? defaultCountQueued;
  const baseConfig = resolveConfig(deps.config);
  const routes = new Hono();

  // Cheap liveness probe: NO auth, NO database, NO claim. Safe for uptime monitors.
  routes.get('/drain', (c) =>
    c.json({ status: 'ok', endpoint: '/api/agent/worker/drain', method: 'POST' }),
  );

  routes.post('/drain', drainGuard(), async (c) => {
    const startedAt = now();
    const requestedLimit = await readRequestedLimit(c);
    const config = requestedLimit === null ? baseConfig : { ...baseConfig, limit: requestedLimit };
    const cutAt = startedAt + Math.min(config.deadlineMs, config.responseBudgetMs);
    const summary: AgentWorkerDrainSummary = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      reclaimed: 0,
      remaining: 0,
    };

    // 1. Recover leases left by dead workers BEFORE claiming, so this tick can pick them up.
    try {
      const reclaimed = await queue.reclaimExpiredLeases();
      summary.reclaimed = reclaimed.reclaimed;
    } catch (error) {
      log.error({ event: 'agent_worker.reclaim_failed', err: error }, 'reclaimExpiredLeases threw');
      return c.json({ ...summary, error: 'reclaim_failed' }, 500);
    }

    // 2. One bounded claim. Skipped only when there is not enough budget to execute anything.
    let claimed: ClaimedJob[] = [];
    if (cutAt - now() >= config.minClaimBudgetMs) {
      try {
        claimed = await queue.claimBatch(config.limit, leaseSecondsFor(config));
      } catch (error) {
        log.error({ event: 'agent_worker.claim_failed', err: error }, 'claimBatch threw');
        // Surfaced, never swallowed: the caller sees the failure and zeroes for the batch.
        return c.json({ ...summary, error: 'claim_failed' }, 500);
      }
    }
    summary.claimed = claimed.length;

    // 3. Execute serially inside the remaining budget; heartbeat each running job.
    const extendSeconds = leaseSecondsFor(config);
    for (const job of claimed) {
      const budgetMs = cutAt - now();
      if (budgetMs <= 0) break; // out of budget: leave the rest leased, return now

      await pulse(queue, job, extendSeconds);
      const heartbeat = setInterval(() => {
        void pulse(queue, job, extendSeconds);
      }, config.heartbeatIntervalMs);

      try {
        const outcome = await executeWithinBudget(execute, job, budgetMs);
        if (outcome.kind === 'timeout') {
          log.warn(
            { event: 'agent_worker.job_deadline', jobId: job.id, jobKind: job.kind },
            'Job exceeded the invocation budget; it stays leased for the next tick',
          );
          break; // no budget left for the following jobs either
        }
        if (outcome.kind === 'error') {
          summary.failed += 1;
          await recordFailure(queue, job, outcome.error);
          continue;
        }

        const done = outcome.value ?? {};
        try {
          const completed = await queue.complete(job.id, job.leaseToken, done.result ?? null, done.costTokens ?? 0);
          if (completed.completed) {
            summary.succeeded += 1;
          } else {
            summary.failed += 1;
            log.warn(
              { event: 'agent_worker.complete_rejected', jobId: job.id, jobKind: job.kind },
              'complete() was rejected (lease no longer live); the reclaimer will re-run the job',
            );
          }
        } catch (completeError) {
          summary.failed += 1;
          log.error(
            { event: 'agent_worker.complete_failed', jobId: job.id, jobKind: job.kind, err: completeError },
            'complete() threw; the lease will expire and the job will be reclaimed',
          );
        }
      } finally {
        clearInterval(heartbeat);
      }
    }

    // 4. remaining = queued jobs after the run + this tick's claimed-but-unfinished jobs
    //    (still leased; the next tick reclaims them). Honest on every partial exit.
    const unfinished = Math.max(0, claimed.length - summary.succeeded - summary.failed);
    try {
      summary.remaining = (await countQueued()) + unfinished;
    } catch (error) {
      summary.remaining = unfinished;
      log.error({ event: 'agent_worker.remaining_count_failed', err: error }, 'Counting queued jobs failed');
      return c.json({ ...summary, error: 'remaining_count_failed' }, 500);
    }

    return c.json(summary);
  });

  return routes;
}

/** Production singleton mounted at `/api/agent/worker` (see backend/src/index.ts). */
const agentWorkerRoutes = createAgentWorkerRoutes();

export default agentWorkerRoutes;
