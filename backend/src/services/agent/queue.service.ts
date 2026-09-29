import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../../db/index.js';

/**
 * Durable agent-job queue (Wave 14, checkbox 113) over the `agent_jobs` schema
 * landed in migration 54.
 *
 * Delivery contract: **at-least-once, never exactly-once**. A worker claims a job
 * under a renewable lease (`lease_token` + `lease_expires_at`) and may run it more
 * than once (lease expiry, crash after side effects, duplicate delivery), so every
 * handler MUST be idempotent. The queue only guarantees that (a) a live worker's
 * concurrent claims never return the same row twice, and (b) a stale or expired
 * worker can never overwrite a finished/reclaimed job.
 *
 * Every outcome write is guarded by BOTH `lease_token = $token` AND
 * `status IN ('leased','running')`. Reclaiming a lease clears the token and returns
 * the row to `queued`, so an old worker's `complete`/`fail`/`heartbeat` matches no
 * row and is silently rejected (reported as a `false` result, never a mutation).
 */

export const AGENT_JOB_KINDS = [
  'morning_brief',
  'evening_review',
  'weekly_review',
  'hourly_triage',
  'watchdog',
] as const;

export type AgentJobKind = (typeof AGENT_JOB_KINDS)[number];

/** Capped exponential backoff: base 30s, doubling, capped at 6h (+ <=20% jitter). */
export const QUEUE_BACKOFF_BASE_MS = 30_000;
export const QUEUE_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
export const QUEUE_BACKOFF_JITTER_RATIO = 0.2;

export interface EnqueueOptions {
  /** Owner of the job; `null` for a future system-scope job. */
  userId?: number | null;
  /** Unique per `(user_id, idempotency_key)` - a duplicate enqueue is a no-op. */
  idempotencyKey?: string | null;
  /** Earliest eligible run time. Defaults to the injected clock's now. */
  runAt?: Date | number | null;
  /** Higher is claimed first. Default 0. */
  priority?: number;
  /** Claim attempts before dead-lettering. Default 3. */
  maxAttempts?: number;
}

export interface EnqueueResult {
  id: string | null;
  created: boolean;
}

export interface ClaimedJob {
  id: string;
  userId: number | null;
  kind: AgentJobKind;
  payload: unknown;
  priority: number;
  /** attempt AFTER this claim incremented it (first claim => 1). */
  attempt: number;
  maxAttempts: number;
  /**
   * Lease token for this batch. All jobs claimed by one `claimBatch` call share the
   * batch token; `heartbeat`/`complete`/`fail` must echo it back verbatim.
   */
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface HeartbeatResult {
  renewed: boolean;
  leaseExpiresAt: string | null;
}

export interface CompleteResult {
  completed: boolean;
}

export type FailOutcome = 'queued' | 'failed' | 'dead_letter';

export interface FailResult {
  /** false => the lease guard rejected the write (stale/expired/mismatched token). */
  recorded: boolean;
  outcome: FailOutcome | null;
  /** Set only when `outcome === 'queued'`. */
  nextRunAt: string | null;
}

export interface ReclaimResult {
  reclaimed: number;
  deadLettered: number;
}

export interface AgentQueueDeps {
  /** Clock in epoch ms; injectable so lease expiry / backoff are deterministic in tests. */
  now?: () => number;
  /** Jitter source in [0,1); injectable, defaults to Math.random (mirrors the AI gateway). */
  random?: () => number;
  /** Recorded in `lease_owner`; identifies which worker holds the lease. */
  workerId?: string;
}

export interface AgentQueue {
  enqueue(kind: AgentJobKind, payload: unknown, options?: EnqueueOptions): Promise<EnqueueResult>;
  claimBatch(limit: number, leaseSeconds: number): Promise<ClaimedJob[]>;
  heartbeat(jobId: string, leaseToken: string, extendSeconds: number): Promise<HeartbeatResult>;
  complete(jobId: string, leaseToken: string, result: unknown, costTokens?: number): Promise<CompleteResult>;
  fail(
    jobId: string,
    leaseToken: string,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
  ): Promise<FailResult>;
  reclaimExpiredLeases(): Promise<ReclaimResult>;
}

/**
 * Every statement the service emits. Exported so the shipped SQL-shape assertions
 * and the out-of-repo PGlite harness execute the exact shipped text.
 */
export const QUEUE_SQL = {
  enqueue: `
INSERT INTO agent_jobs (user_id, kind, payload, priority, max_attempts, idempotency_key, run_at, status, updated_at)
VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::timestamptz, 'queued', now())
ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
RETURNING id`,
  enqueueLookup: `SELECT id FROM agent_jobs WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1`,
  claimSelect: `
SELECT id, user_id, kind, payload, priority, attempt, max_attempts
FROM agent_jobs
WHERE status IN ('queued') AND run_at <= now()
ORDER BY priority DESC, run_at ASC
LIMIT $1
FOR UPDATE SKIP LOCKED`,
  claimLease: `
UPDATE agent_jobs
SET status = 'leased',
    lease_owner = $2,
    lease_token = $3,
    lease_expires_at = now() + make_interval(secs => $4::double precision),
    attempt = attempt + 1,
    started_at = COALESCE(started_at, now()),
    last_heartbeat_at = now(),
    updated_at = now()
WHERE id = ANY($1::uuid[])
RETURNING id, user_id, kind, payload, priority, attempt, max_attempts, lease_token, lease_expires_at`,
  heartbeat: `
UPDATE agent_jobs
SET lease_expires_at = now() + make_interval(secs => $3::double precision),
    last_heartbeat_at = now(),
    updated_at = now()
WHERE id = $1
  AND lease_token = $2
  AND status IN ('leased', 'running')
  AND lease_expires_at > now()
RETURNING id, lease_expires_at`,
  complete: `
UPDATE agent_jobs
SET status = 'succeeded',
    result = $3::jsonb,
    cost_tokens = $4,
    finished_at = now(),
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    updated_at = now()
WHERE id = $1
  AND lease_token = $2
  AND status IN ('leased', 'running')
RETURNING id, finished_at`,
  failLookup: `
SELECT id, attempt, max_attempts
FROM agent_jobs
WHERE id = $1 AND lease_token = $2 AND status IN ('leased', 'running')
FOR UPDATE`,
  failRetry: `
UPDATE agent_jobs
SET status = 'queued',
    run_at = $3::timestamptz,
    error_code = $4,
    error_message = $5,
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    updated_at = now()
WHERE id = $1 AND lease_token = $2 AND status IN ('leased', 'running')
RETURNING id, attempt, max_attempts, run_at`,
  failTerminal: `
UPDATE agent_jobs
SET status = $3,
    error_code = $4,
    error_message = $5,
    finished_at = now(),
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    updated_at = now()
WHERE id = $1 AND lease_token = $2 AND status IN ('leased', 'running')
RETURNING id`,
  reclaim: `
UPDATE agent_jobs
SET status = CASE WHEN attempt < max_attempts THEN 'queued' ELSE 'dead_letter' END,
    run_at = CASE WHEN attempt < max_attempts THEN now() ELSE run_at END,
    error_code = CASE WHEN attempt < max_attempts THEN error_code ELSE COALESCE(error_code, 'LEASE_EXPIRED') END,
    finished_at = CASE WHEN attempt < max_attempts THEN finished_at ELSE now() END,
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    updated_at = now()
WHERE status IN ('leased', 'running')
  AND lease_expires_at IS NOT NULL
  AND lease_expires_at <= now()
RETURNING id, status, attempt, max_attempts`,
} as const;

const ERROR_MESSAGE_MAX = 2000;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Delay before the next attempt, in epoch-ms arithmetic (never an ISO-string slice).
 * `attempt` is the attempt that just failed (1-based, matching `agent_jobs.attempt`).
 */
export function computeBackoffMs(attempt: number, random: () => number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const capped = Math.min(QUEUE_BACKOFF_CAP_MS, QUEUE_BACKOFF_BASE_MS * 2 ** exponent);
  const jitter = Math.floor(capped * QUEUE_BACKOFF_JITTER_RATIO * clamp01(random()));
  return capped + jitter;
}

function defaultWorkerId(): string {
  const explicit = (process.env.AGENT_WORKER_ID ?? '').trim();
  return explicit || `worker-${process.pid}`;
}

/** Build a queue bound to a clock / RNG / worker id. Production uses {@link agentQueue}. */
export function createAgentQueue(deps: AgentQueueDeps = {}): AgentQueue {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? (() => Math.random());
  const workerId = deps.workerId ?? defaultWorkerId();

  return {
    async enqueue(kind, payload, options = {}) {
      const runAt = options.runAt == null ? new Date(now()) : new Date(options.runAt);
      const inserted = await query(QUEUE_SQL.enqueue, [
        options.userId ?? null,
        kind,
        JSON.stringify(payload ?? {}),
        options.priority ?? 0,
        options.maxAttempts ?? 3,
        options.idempotencyKey ?? null,
        runAt.toISOString(),
      ]);
      if (inserted.rows.length > 0) {
        return { id: String(inserted.rows[0].id), created: true };
      }
      // The unique partial index suppressed the insert: resolve the existing job id.
      const existing = await query(QUEUE_SQL.enqueueLookup, [
        options.userId ?? null,
        options.idempotencyKey ?? null,
      ]);
      return { id: existing.rows.length > 0 ? String(existing.rows[0].id) : null, created: false };
    },

    async claimBatch(limit, leaseSeconds) {
      const batchLimit = Number.isInteger(limit) && limit > 0 ? limit : 1;
      const lease = Number.isFinite(leaseSeconds) && leaseSeconds > 0 ? leaseSeconds : 60;
      return withTransaction(async (client) => {
        const candidates = await client.query(QUEUE_SQL.claimSelect, [batchLimit]);
        if (candidates.rows.length === 0) return [];
        const ids = candidates.rows.map((row) => String(row.id));
        const leaseToken = randomUUID();
        const leased = await client.query(QUEUE_SQL.claimLease, [ids, workerId, leaseToken, lease]);
        return leased.rows.map((row) => ({
          id: String(row.id),
          userId: row.user_id == null ? null : Number(row.user_id),
          kind: row.kind as AgentJobKind,
          payload: row.payload,
          priority: Number(row.priority),
          attempt: Number(row.attempt),
          maxAttempts: Number(row.max_attempts),
          leaseToken: String(row.lease_token),
          leaseExpiresAt: new Date(row.lease_expires_at as string | Date).toISOString(),
        }));
      });
    },

    async heartbeat(jobId, leaseToken, extendSeconds) {
      const extend = Number.isFinite(extendSeconds) && extendSeconds > 0 ? extendSeconds : 60;
      const result = await query(QUEUE_SQL.heartbeat, [jobId, leaseToken, extend]);
      if (result.rowCount === 0 || result.rows.length === 0) {
        return { renewed: false, leaseExpiresAt: null };
      }
      return {
        renewed: true,
        leaseExpiresAt: new Date(result.rows[0].lease_expires_at as string | Date).toISOString(),
      };
    },

    async complete(jobId, leaseToken, result, costTokens = 0) {
      const resultParam = result === undefined ? null : JSON.stringify(result);
      const updated = await query(QUEUE_SQL.complete, [jobId, leaseToken, resultParam, costTokens]);
      return { completed: updated.rowCount > 0 };
    },

    async fail(jobId, leaseToken, errorCode, errorMessage, retryable) {
      const message = (errorMessage ?? '').slice(0, ERROR_MESSAGE_MAX);
      return withTransaction(async (client) => {
        const found = await client.query(QUEUE_SQL.failLookup, [jobId, leaseToken]);
        if (found.rows.length === 0) {
          return { recorded: false, outcome: null, nextRunAt: null };
        }
        const attempt = Number(found.rows[0].attempt);
        const maxAttempts = Number(found.rows[0].max_attempts);
        if (retryable && attempt < maxAttempts) {
          const delayMs = computeBackoffMs(attempt, random);
          const nextRunAt = new Date(now() + delayMs);
          const requeued = await client.query(QUEUE_SQL.failRetry, [
            jobId,
            leaseToken,
            nextRunAt.toISOString(),
            errorCode,
            message,
          ]);
          // `rowCount === 0` means the lease-token guard matched nothing (stale lease).
          const requeuedRows = requeued.rowCount ?? 0;
          return {
            recorded: requeuedRows > 0,
            outcome: requeuedRows > 0 ? 'queued' : null,
            nextRunAt: requeuedRows > 0 ? nextRunAt.toISOString() : null,
          };
        }
        const terminal: FailOutcome = retryable ? 'dead_letter' : 'failed';
        const written = await client.query(QUEUE_SQL.failTerminal, [
          jobId,
          leaseToken,
          terminal,
          errorCode,
          message,
        ]);
        // `rowCount === 0` means the lease-token guard matched nothing (stale lease).
        const writtenRows = written.rowCount ?? 0;
        return { recorded: writtenRows > 0, outcome: writtenRows > 0 ? terminal : null, nextRunAt: null };
      });
    },

    async reclaimExpiredLeases() {
      const result = await query(QUEUE_SQL.reclaim);
      let reclaimed = 0;
      let deadLettered = 0;
      for (const row of result.rows) {
        if (row.status === 'dead_letter') deadLettered += 1;
        else reclaimed += 1;
      }
      return { reclaimed, deadLettered };
    },
  };
}

/** Process-wide queue bound to the real DB pool, wall clock and Math.random. */
export const agentQueue: AgentQueue = createAgentQueue();

export const enqueue: AgentQueue['enqueue'] = (kind, payload, options) =>
  agentQueue.enqueue(kind, payload, options);
export const claimBatch: AgentQueue['claimBatch'] = (limit, leaseSeconds) =>
  agentQueue.claimBatch(limit, leaseSeconds);
export const heartbeat: AgentQueue['heartbeat'] = (jobId, leaseToken, extendSeconds) =>
  agentQueue.heartbeat(jobId, leaseToken, extendSeconds);
export const complete: AgentQueue['complete'] = (jobId, leaseToken, result, costTokens) =>
  agentQueue.complete(jobId, leaseToken, result, costTokens);
export const fail: AgentQueue['fail'] = (jobId, leaseToken, errorCode, errorMessage, retryable) =>
  agentQueue.fail(jobId, leaseToken, errorCode, errorMessage, retryable);
export const reclaimExpiredLeases: AgentQueue['reclaimExpiredLeases'] = () =>
  agentQueue.reclaimExpiredLeases();

export default {
  enqueue,
  claimBatch,
  heartbeat,
  complete,
  fail,
  reclaimExpiredLeases,
};
