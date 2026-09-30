import { Hono, type Context, type Next } from 'hono';
import { timingSafeEqual } from 'crypto';
import { getCronSecret } from '../utils/heartbeat.js';
import { query } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { agentQueue, type AgentQueue, type ClaimedJob } from '../services/agent/queue.service.js';
import { touchAgentWorker } from '../services/agent/run-observability.service.js';
import { runAgentWatchdog } from '../services/agent/agent-watchdog.service.js';

/**
 * Checkbox 114: the bounded worker-drain endpoint + trigger topology.
 *
 *   GET  /api/agent/worker/drain  -> cheap liveness probe (no auth, no DB, no claim)
 *   POST /api/agent/worker/drain  -> CRON_SECRET / AGENT_WORKER_TOKEN guarded drain
 *   GET  /api/agent/worker/me     -> worker-contract capability discovery (checkbox 129)
 *
 * Checkbox 129 adds the outbound-only worker contract (docs/WORKER.md): `POST /drain` accepts
 * `?mode=claim` to hand the raw leased jobs to an optional local process that polls OUT (no
 * inbound port, no tunnel), and {@link createAgentJobWorkerRoutes} exposes the matching
 * `/api/agent/jobs/:id/{heartbeat,complete,fail}` lifecycle. Both reuse the SAME lease logic
 * as the in-process drain below - there is exactly one implementation of the queue protocol.
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
/** Checkbox 129: worker-contract version advertised by `GET /api/agent/worker/me`. */
export const WORKER_PROTOCOL_VERSION = '1';
/** Header naming the calling worker so it appears as its own `agent_workers` row. */
export const WORKER_ID_HEADER = 'X-Agent-Worker-Id';
/** Header describing the calling worker's kind (e.g. `local-ollama`). */
export const WORKER_KIND_HEADER = 'X-Agent-Worker-Kind';

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
  /**
   * Checkbox 130: best-effort worker-registry heartbeat (`agent_workers.last_seen_at`).
   * Defaults to the shipped upsert; skipped under the test runner.
   */
  touchWorker?: () => Promise<unknown> | unknown;
  /**
   * Checkbox 129: best-effort registry heartbeat for a NAMED outbound worker
   * (`X-Agent-Worker-Id` / `X-Agent-Worker-Kind`), so the local process shows up as its own
   * row in `/workers`. Defaults to {@link touchAgentWorker}; skipped under the test runner.
   */
  touchWorkerById?: (id: string, kind: string) => Promise<unknown> | unknown;
  /**
   * Checkbox 130: best-effort self-watchdog evaluation after each drain. Defaults to
   * {@link runAgentWatchdog}; skipped under the test runner.
   */
  runWatchdog?: () => Promise<unknown> | unknown;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Trimmed non-empty string, else null. */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Integer inside [min, max], else null (numbers or numeric strings both accepted). */
function readBoundedInt(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** `{ id, kind }` from the worker headers, or null when neither is present. */
function readWorkerIdentity(c: Context): { id: string; kind: string } | null {
  const id = readString(c.req.header(WORKER_ID_HEADER));
  const kind = readString(c.req.header(WORKER_KIND_HEADER));
  if (!id && !kind) return null;
  return { id: (id ?? 'local-worker').slice(0, 128), kind: (kind ?? 'local').slice(0, 64) };
}

export type WorkerDrainMode = 'execute' | 'claim';

interface DrainRequest {
  limit: number | null;
  mode: WorkerDrainMode;
}

/**
 * Read a drain request once (query first, then JSON body). `?limit=` / `{"limit":n}` bound the
 * batch; `?mode=claim` / `{"mode":"claim"}` / `{"claim":true}` ask for the raw claimed jobs
 * (with their lease tokens) instead of in-process execution. Invalid/absent -> defaults.
 */
async function readDrainRequest(c: Context): Promise<DrainRequest> {
  const queryLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
  const body = asRecord(await c.req.json().catch(() => null));

  let limit: number | null = null;
  if (Number.isInteger(queryLimit) && queryLimit > 0) {
    limit = clamp(queryLimit, 1, MAX_DRAIN_LIMIT);
  } else {
    limit = readBoundedInt(body.limit, 1, MAX_DRAIN_LIMIT);
  }

  const claim = c.req.query('mode') === 'claim' || body.mode === 'claim' || body.claim === true;
  return { limit, mode: claim ? 'claim' : 'execute' };
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

/** Worker-registry heartbeat default; skipped under the test runner (no DB writes in tests). */
function defaultTouchWorker(): void | Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  return touchAgentWorker().then(() => undefined);
}

/** Named-worker registry heartbeat default; skipped under the test runner. */
function defaultTouchWorkerById(id: string, kind: string): void | Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  return touchAgentWorker(id, kind).then(() => undefined);
}

/** Self-watchdog default; skipped under the test runner (no alerts in tests). */
function defaultRunWatchdogTick(): void | Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  return runAgentWatchdog().then(() => undefined);
}

/** Best-effort wrapper: observability hooks must never fail a drain (checkbox 130). */
async function bestEffort(hook: () => Promise<unknown> | unknown, event: string): Promise<void> {
  try {
    await hook();
  } catch (error) {
    log.warn({ event, err: error }, 'Observability hook failed; the drain result is unaffected');
  }
}

/**
 * Checkbox 129: the outbound-only worker's job-lifecycle contract, mounted by the integrator at
 * `/api/agent/jobs` (see docs/WORKER.md). A local worker that claimed a batch from
 * `POST /api/agent/worker/drain?mode=claim` drives each job with these three calls - the SAME
 * `agentQueue` lease logic the in-process drain uses, never a second copy.
 *
 *   POST /api/agent/jobs/:id/heartbeat  { leaseToken, extendSeconds? }
 *   POST /api/agent/jobs/:id/complete   { leaseToken, result?, costTokens? }
 *   POST /api/agent/jobs/:id/fail       { leaseToken, errorCode?, errorMessage?, retryable? }
 *
 * Every call carries `Authorization: Bearer <AGENT_WORKER_TOKEN>`; a 200 with `renewed:false`
 * / `completed:false` / `recorded:false` means the lease was already gone (stale worker) and is
 * never an error. All three are idempotent against the queue's lease-token guard.
 */
export function createAgentJobWorkerRoutes(deps: AgentWorkerRouteDeps = {}): Hono {
  const queue = deps.queue ?? agentQueue;
  const baseConfig = resolveConfig(deps.config);
  const touchWorkerById = deps.touchWorkerById ?? defaultTouchWorkerById;
  const routes = new Hono();
  const guard = drainGuard();

  const touch = (c: Context): Promise<void> => {
    const identity = readWorkerIdentity(c);
    return identity
      ? bestEffort(() => touchWorkerById(identity.id, identity.kind), 'agent_worker.touch_by_id_failed')
      : Promise.resolve();
  };

  routes.post('/:id/heartbeat', guard, async (c) => {
    const id = c.req.param('id') ?? '';
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid_job_id' }, 400);
    const body = asRecord(await c.req.json().catch(() => null));
    const leaseToken = readString(body.leaseToken);
    if (!leaseToken) return c.json({ error: 'leaseToken is required' }, 400);
    const extend = readBoundedInt(body.extendSeconds, 1, 86_400) ?? leaseSecondsFor(baseConfig);
    await touch(c);
    return c.json(await queue.heartbeat(id, leaseToken, extend));
  });

  routes.post('/:id/complete', guard, async (c) => {
    const id = c.req.param('id') ?? '';
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid_job_id' }, 400);
    const body = asRecord(await c.req.json().catch(() => null));
    const leaseToken = readString(body.leaseToken);
    if (!leaseToken) return c.json({ error: 'leaseToken is required' }, 400);
    const costTokens = readBoundedInt(body.costTokens, 0, 10_000_000) ?? 0;
    await touch(c);
    const result = await queue.complete(id, leaseToken, body.result ?? null, costTokens);
    return c.json({ completed: result.completed });
  });

  routes.post('/:id/fail', guard, async (c) => {
    const id = c.req.param('id') ?? '';
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid_job_id' }, 400);
    const body = asRecord(await c.req.json().catch(() => null));
    const leaseToken = readString(body.leaseToken);
    if (!leaseToken) return c.json({ error: 'leaseToken is required' }, 400);
    const errorCode = (readString(body.errorCode) ?? 'EXECUTION_FAILED').slice(0, 64);
    const errorMessage = readString(body.errorMessage) ?? '';
    const retryable = typeof body.retryable === 'boolean' ? body.retryable : true;
    await touch(c);
    return c.json(await queue.fail(id, leaseToken, errorCode, errorMessage, retryable));
  });

  return routes;
}

/** Build the drain router. Tests inject the queue/executor/clock; production uses defaults. */
export function createAgentWorkerRoutes(deps: AgentWorkerRouteDeps = {}): Hono {
  const queue = deps.queue ?? agentQueue;
  const execute = deps.execute ?? defaultExecutor;
  const now = deps.now ?? (() => Date.now());
  const countQueued = deps.countQueued ?? defaultCountQueued;
  const touchWorker = deps.touchWorker ?? defaultTouchWorker;
  const touchWorkerById = deps.touchWorkerById ?? defaultTouchWorkerById;
  const runWatchdogTick = deps.runWatchdog ?? defaultRunWatchdogTick;
  const baseConfig = resolveConfig(deps.config);
  const routes = new Hono();

  // Cheap liveness probe: NO auth, NO database, NO claim. Safe for uptime monitors.
  routes.get('/drain', (c) =>
    c.json({ status: 'ok', endpoint: '/api/agent/worker/drain', method: 'POST' }),
  );

  // Checkbox 129: capability discovery for an optional outbound-only local worker. Authenticated
  // (worker token) but DB-free and side-effect free, so a worker can self-configure on startup.
  routes.get('/me', drainGuard(), (c) =>
    c.json({
      protocol: 'timemark-agent-worker',
      version: WORKER_PROTOCOL_VERSION,
      queue: { claimModes: ['execute', 'claim'], maxBatch: MAX_DRAIN_LIMIT, defaultBatch: baseConfig.limit },
      leases: {
        defaultSeconds: leaseSecondsFor(baseConfig),
        heartbeatIntervalMs: baseConfig.heartbeatIntervalMs,
      },
      endpoints: {
        me: { method: 'GET', path: '/api/agent/worker/me' },
        drain: { method: 'POST', path: '/api/agent/worker/drain', claimMode: '?mode=claim' },
        heartbeat: { method: 'POST', path: '/api/agent/jobs/:id/heartbeat' },
        complete: { method: 'POST', path: '/api/agent/jobs/:id/complete' },
        fail: { method: 'POST', path: '/api/agent/jobs/:id/fail' },
      },
      headers: {
        authorization: 'Bearer <AGENT_WORKER_TOKEN>',
        workerId: WORKER_ID_HEADER,
        workerKind: WORKER_KIND_HEADER,
        csrfMarker: 'X-Requested-With: XMLHttpRequest',
      },
    }),
  );

  routes.post('/drain', drainGuard(), async (c) => {
    const startedAt = now();
    const drainRequest = await readDrainRequest(c);
    const config = drainRequest.limit === null ? baseConfig : { ...baseConfig, limit: drainRequest.limit };
    const cutAt = startedAt + Math.min(config.deadlineMs, config.responseBudgetMs);
    const summary: AgentWorkerDrainSummary = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      reclaimed: 0,
      remaining: 0,
    };

    // checkbox 130: keep this worker's registry heartbeat fresh for `/api/agent/health`.
    await bestEffort(touchWorker, 'agent_worker.touch_failed');

    // checkbox 129: register a NAMED outbound worker so it appears as its own `/workers` row.
    const identity = readWorkerIdentity(c);
    if (identity) {
      await bestEffort(() => touchWorkerById(identity.id, identity.kind), 'agent_worker.touch_by_id_failed');
    }

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

    // checkbox 129: claim-only mode returns the raw leased jobs (with their lease tokens) to an
    // optional OUTBOUND-ONLY local worker. The server does not execute them here; the worker
    // renews the lease via `/heartbeat` and finishes via `/complete` or `/fail`. Unfinished jobs
    // stay leased and are reclaimed by the next tick if the worker dies.
    if (drainRequest.mode === 'claim') {
      let remaining: number;
      try {
        remaining = await countQueued();
      } catch (error) {
        log.error({ event: 'agent_worker.remaining_count_failed', err: error }, 'Counting queued jobs failed');
        return c.json(
          { ...summary, mode: 'claim', claimed, claimedCount: claimed.length, error: 'remaining_count_failed' },
          500,
        );
      }
      return c.json({
        mode: 'claim',
        protocol: WORKER_PROTOCOL_VERSION,
        reclaimed: summary.reclaimed,
        claimed,
        claimedCount: claimed.length,
        remaining,
      });
    }

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

    // checkbox 130: one self-watchdog tick per drain (queue stall / routine failures /
    // provider errors); alert dedupe + budget live in the persisted watchdog state.
    await bestEffort(runWatchdogTick, 'agent_watchdog.tick_failed');

    return c.json(summary);
  });

  // Out-of-the-box alias so the reference worker runs before the integrator mounts the canonical
  // `/api/agent/jobs` route (see docs/WORKER.md): `/api/agent/worker/jobs/:id/*`.
  routes.route('/jobs', createAgentJobWorkerRoutes(deps));

  return routes;
}

/** Production singleton mounted at `/api/agent/worker` (see backend/src/index.ts). */
const agentWorkerRoutes = createAgentWorkerRoutes();

/** Production singleton the integrator mounts at `/api/agent/jobs` (see docs/WORKER.md). */
export const agentJobWorkerRoutes: Hono = createAgentJobWorkerRoutes();

export default agentWorkerRoutes;
