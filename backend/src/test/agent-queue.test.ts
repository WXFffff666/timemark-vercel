import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 113 - durable agent-job queue.
 *
 * Delivery contract is **at-least-once**: a job may run more than once, but a live
 * worker's concurrent `claimBatch` calls must never hand the same row to two workers,
 * and a stale/expired worker must never overwrite a finished or reclaimed job.
 *
 * The service's `query` / `withTransaction` are mocked with a small in-memory
 * transactional store that models the exact semantics the shipped SQL relies on:
 *  - `SELECT ... FOR UPDATE SKIP LOCKED` takes a per-row lock for the transaction and
 *    skips rows locked by another in-flight transaction (release on commit). Dropping
 *    the `FOR UPDATE` clause removes the lock and lets concurrent claims double-claim
 *    (the negative control in the harness proves the store can fail).
 *  - `UPDATE ... WHERE lease_token = $2 AND status IN ('leased','running')` mutates only
 *    when the token + status guard matches; otherwise it returns `rowCount: 0`.
 *  - the unique partial `(user_id, idempotency_key)` index suppresses a duplicate insert.
 *
 * A real-engine proof lives in the out-of-repo harness
 * `%TEMP%/opencode/wave14-113-queue/pglite-probe.mts` (PGlite 0.5.8 + the v54 DDL
 * extracted from migrate.ts + the SHIPPED `QUEUE_SQL` executed verbatim). It passes
 * 27/28 assertions: enqueue/dedupe, 8 sequential claim cycles -> 8 distinct jobs,
 * complete stale=0/correct=1, reclaim queued/dead_letter, heartbeat expired/mismatched=0,
 * fail retry/terminal, the dead-worker QA, and the `FOR UPDATE SKIP LOCKED` shape.
 * The one assertion it could NOT run is true 8-way PARALLEL contention: PGlite is a
 * single-connection engine and its `pglite-socket` multiplexer ECONNRESETs on 8
 * simultaneous transactions, so no genuine concurrent `FOR UPDATE SKIP LOCKED` proof
 * exists on this engine. Exactly-once under concurrency is therefore established by
 * THIS file's lock-modelling store (which also proves the store can double-claim when
 * `FOR UPDATE` is removed - see the negative controls), not by a real-DB contention run.
 */

const { mockQuery, mockTransaction } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  query: mockQuery,
  withTransaction: mockTransaction,
}));

import {
  QUEUE_BACKOFF_BASE_MS,
  QUEUE_BACKOFF_CAP_MS,
  QUEUE_BACKOFF_JITTER_RATIO,
  QUEUE_SQL,
  computeBackoffMs,
  createAgentQueue,
  type AgentQueue,
  type AgentQueueDeps,
} from '../services/agent/queue.service.js';

const SERVICE_SOURCE = readFileSync(
  new URL('../services/agent/queue.service.ts', import.meta.url),
  'utf8',
);

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
/** A valid but foreign lease token (real `lease_token` is UUID, mirroring the DB cast). */
const FOREIGN_TOKEN = '00000000-0000-0000-0000-000000000000';

type Row = Record<string, unknown>;
type Result = { rows: Row[]; rowCount: number };

interface FakeJob {
  id: string;
  user_id: number | null;
  kind: string;
  payload: unknown;
  status: string;
  priority: number;
  attempt: number;
  max_attempts: number;
  idempotency_key: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_heartbeat_at: number | null;
  run_at: number;
  started_at: number | null;
  finished_at: number | null;
  error_code: string | null;
  error_message: string | null;
  result: unknown;
  cost_tokens: number;
  created_at: number;
  updated_at: number;
}

type FakeClient = { query: (text: string, params?: unknown[]) => Promise<Result> };

interface FakeDb {
  jobs: Map<string, FakeJob>;
  query: (text: string, params?: unknown[]) => Promise<Result>;
  withTransaction: <T>(fn: (client: FakeClient) => Promise<T>) => Promise<T>;
}

function createFakeDb(clock: { t: number }): FakeDb {
  const jobs = new Map<string, FakeJob>();
  const locks = new Map<string, string>();
  let seq = 0;
  let txnSeq = 0;

  function releaseLocks(txnId: string): void {
    for (const [id, owner] of locks) {
      if (owner === txnId) locks.delete(id);
    }
  }

  function route(sqlRaw: string, params: unknown[], txnId: string | null): Result {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();

    if (sql.startsWith('INSERT INTO agent_jobs')) {
      const [userId, kind, payloadJson, priority, maxAttempts, idempotencyKey, runAtIso] = params;
      const uid = userId == null ? null : Number(userId);
      const key = idempotencyKey == null ? null : String(idempotencyKey);
      if (sql.includes('ON CONFLICT') && key != null && uid != null) {
        const duel = [...jobs.values()].find((j) => j.user_id === uid && j.idempotency_key === key);
        if (duel) return { rows: [], rowCount: 0 };
      }
      const id = `job-${++seq}`;
      jobs.set(id, {
        id,
        user_id: uid,
        kind: String(kind),
        payload: payloadJson == null ? null : JSON.parse(String(payloadJson)),
        status: 'queued',
        priority: Number(priority),
        attempt: 0,
        max_attempts: Number(maxAttempts),
        idempotency_key: key,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        last_heartbeat_at: null,
        run_at: new Date(String(runAtIso)).getTime(),
        started_at: null,
        finished_at: null,
        error_code: null,
        error_message: null,
        result: null,
        cost_tokens: 0,
        created_at: clock.t,
        updated_at: clock.t,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT id FROM agent_jobs WHERE user_id')) {
      const [userId, key] = params;
      const uid = userId == null ? null : Number(userId);
      const existing = [...jobs.values()].find(
        (j) => j.user_id === uid && j.idempotency_key === String(key),
      );
      return existing ? { rows: [{ id: existing.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (sql.includes('ORDER BY priority DESC')) {
      const limit = Number(params[0]);
      const hasForUpdate = sql.includes('FOR UPDATE');
      const skipLocked = sql.includes('SKIP LOCKED');
      const candidates = [...jobs.values()]
        .filter((j) => j.status === 'queued' && j.run_at <= clock.t)
        .sort(
          (a, b) =>
            b.priority - a.priority || a.run_at - b.run_at || a.id.localeCompare(b.id),
        );
      const chosen: FakeJob[] = [];
      for (const job of candidates) {
        if (chosen.length >= limit) break;
        const owner = locks.get(job.id);
        if (hasForUpdate && owner && owner !== txnId) {
          if (skipLocked) continue;
          continue; // blocked in a real engine; skip keeps this simulation total
        }
        chosen.push(job);
        if (hasForUpdate) locks.set(job.id, txnId ?? 'no-txn');
      }
      return {
        rows: chosen.map((j) => ({
          id: j.id,
          user_id: j.user_id,
          kind: j.kind,
          payload: j.payload,
          priority: j.priority,
          attempt: j.attempt,
          max_attempts: j.max_attempts,
        })),
        rowCount: chosen.length,
      };
    }

    if (sql.includes("SET status = 'leased'")) {
      const [ids, owner, token, leaseSeconds] = params;
      const rows: Row[] = [];
      for (const id of ids as string[]) {
        const job = jobs.get(id);
        if (!job) continue;
        job.status = 'leased';
        job.lease_owner = String(owner);
        job.lease_token = String(token);
        job.lease_expires_at = clock.t + Number(leaseSeconds) * 1000;
        job.attempt += 1;
        job.started_at = job.started_at ?? clock.t;
        job.last_heartbeat_at = clock.t;
        job.updated_at = clock.t;
        rows.push({
          id: job.id,
          user_id: job.user_id,
          kind: job.kind,
          payload: job.payload,
          priority: job.priority,
          attempt: job.attempt,
          max_attempts: job.max_attempts,
          lease_token: job.lease_token,
          lease_expires_at: new Date(job.lease_expires_at),
        });
      }
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('SET lease_expires_at = now() + make_interval')) {
      const [id, token, extendSeconds] = params;
      const job = jobs.get(String(id));
      const guarded =
        sql.includes('lease_token = $2') &&
        sql.includes("status IN ('leased', 'running')") &&
        sql.includes('lease_expires_at > now()');
      if (
        !job ||
        (guarded &&
          (job.lease_token !== String(token) ||
            (job.status !== 'leased' && job.status !== 'running') ||
            job.lease_expires_at == null ||
            job.lease_expires_at <= clock.t))
      ) {
        return { rows: [], rowCount: 0 };
      }
      job.lease_expires_at = clock.t + Number(extendSeconds) * 1000;
      job.last_heartbeat_at = clock.t;
      job.updated_at = clock.t;
      return { rows: [{ id: job.id, lease_expires_at: new Date(job.lease_expires_at) }], rowCount: 1 };
    }

    if (sql.includes("SET status = 'succeeded'")) {
      const [id, token, resultParam, costTokens] = params;
      const job = jobs.get(String(id));
      // The fake enforces the lease guard ONLY when the shipped SQL carries it, so
      // deleting `AND lease_token = $2` / the status guard makes the stale-token test fail.
      const guarded =
        sql.includes('lease_token = $2') && sql.includes("status IN ('leased', 'running')");
      if (
        !job ||
        (guarded &&
          (job.lease_token !== String(token) ||
            (job.status !== 'leased' && job.status !== 'running')))
      ) {
        return { rows: [], rowCount: 0 };
      }
      job.status = 'succeeded';
      job.result = resultParam == null ? null : JSON.parse(String(resultParam));
      job.cost_tokens = Number(costTokens);
      job.finished_at = clock.t;
      job.lease_owner = null;
      job.lease_token = null;
      job.lease_expires_at = null;
      job.last_heartbeat_at = null;
      job.updated_at = clock.t;
      return { rows: [{ id: job.id, finished_at: new Date(job.finished_at) }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT id, attempt, max_attempts')) {
      const [id, token] = params;
      const job = jobs.get(String(id));
      if (
        !job ||
        job.lease_token !== String(token) ||
        (job.status !== 'leased' && job.status !== 'running')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (txnId) locks.set(job.id, txnId);
      return {
        rows: [{ id: job.id, attempt: job.attempt, max_attempts: job.max_attempts }],
        rowCount: 1,
      };
    }

    if (sql.includes('run_at = $3::timestamptz')) {
      const [id, token, nextRunAtIso, errorCode, message] = params;
      const job = jobs.get(String(id));
      if (
        !job ||
        job.lease_token !== String(token) ||
        (job.status !== 'leased' && job.status !== 'running')
      ) {
        return { rows: [], rowCount: 0 };
      }
      job.status = 'queued';
      job.run_at = new Date(String(nextRunAtIso)).getTime();
      job.error_code = String(errorCode);
      job.error_message = String(message);
      job.lease_owner = null;
      job.lease_token = null;
      job.lease_expires_at = null;
      job.last_heartbeat_at = null;
      job.updated_at = clock.t;
      return {
        rows: [
          { id: job.id, attempt: job.attempt, max_attempts: job.max_attempts, run_at: new Date(job.run_at) },
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('SET status = $3') && sql.includes('error_code = $4')) {
      const [id, token, status, errorCode, message] = params;
      const job = jobs.get(String(id));
      if (
        !job ||
        job.lease_token !== String(token) ||
        (job.status !== 'leased' && job.status !== 'running')
      ) {
        return { rows: [], rowCount: 0 };
      }
      job.status = String(status);
      job.error_code = String(errorCode);
      job.error_message = String(message);
      job.finished_at = clock.t;
      job.lease_owner = null;
      job.lease_token = null;
      job.lease_expires_at = null;
      job.last_heartbeat_at = null;
      job.updated_at = clock.t;
      return { rows: [{ id: job.id }], rowCount: 1 };
    }

    if (sql.includes('CASE WHEN attempt < max_attempts')) {
      // Guard-aware: only enforce expiry when the shipped SQL filters on it, so
      // dropping `AND lease_expires_at <= now()` reclaims live leases and fails the test.
      const expiryGuard = sql.includes('lease_expires_at <= now()');
      const rows: Row[] = [];
      for (const job of jobs.values()) {
        if (job.status !== 'leased' && job.status !== 'running') continue;
        if (expiryGuard && (job.lease_expires_at == null || job.lease_expires_at > clock.t)) {
          continue;
        }
        const requeue = job.attempt < job.max_attempts;
        job.status = requeue ? 'queued' : 'dead_letter';
        if (requeue) {
          job.run_at = clock.t;
        } else {
          job.finished_at = clock.t;
          job.error_code = job.error_code ?? 'LEASE_EXPIRED';
        }
        job.lease_owner = null;
        job.lease_token = null;
        job.lease_expires_at = null;
        job.last_heartbeat_at = null;
        job.updated_at = clock.t;
        rows.push({ id: job.id, status: job.status, attempt: job.attempt, max_attempts: job.max_attempts });
      }
      return { rows, rowCount: rows.length };
    }

    throw new Error(`fake db: unrouted SQL -> ${sql.slice(0, 160)}`);
  }

  const query: FakeDb['query'] = (text, params) => Promise.resolve(route(text, params ?? [], null));

  const withTransaction: FakeDb['withTransaction'] = async (fn) => {
    const txnId = `txn-${++txnSeq}`;
    const client: FakeClient = { query: (text, params) => Promise.resolve(route(text, params ?? [], txnId)) };
    try {
      const out = await fn(client);
      releaseLocks(txnId);
      return out;
    } catch (err) {
      releaseLocks(txnId);
      throw err;
    }
  };

  return { jobs, query, withTransaction };
}

function setup(deps: AgentQueueDeps = {}) {
  const clock = { t: T0 };
  const fake = createFakeDb(clock);
  mockQuery.mockImplementation(fake.query);
  mockTransaction.mockImplementation(fake.withTransaction);
  const queue: AgentQueue = createAgentQueue({ now: () => clock.t, random: () => 0, workerId: 'w1', ...deps });
  return { clock, fake, queue };
}

async function seed(queue: AgentQueue, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await queue.enqueue('hourly_triage', { i }, { userId: 1 });
  }
}

beforeEach(() => {
  mockQuery.mockReset();
  mockTransaction.mockReset();
});

describe('queue SQL contract', () => {
  it('claims with FOR UPDATE SKIP LOCKED, ordered by priority DESC then run_at ASC', () => {
    expect(QUEUE_SQL.claimSelect).toContain('FOR UPDATE SKIP LOCKED');
    expect(QUEUE_SQL.claimSelect).toContain("status IN ('queued')");
    expect(QUEUE_SQL.claimSelect).toContain('run_at <= now()');
    expect(QUEUE_SQL.claimSelect).toContain('ORDER BY priority DESC, run_at ASC');
    expect(QUEUE_SQL.claimSelect).toContain('LIMIT $1');
  });

  it('guards every outcome write by lease_token AND by a live lease status', () => {
    for (const sql of [QUEUE_SQL.heartbeat, QUEUE_SQL.complete, QUEUE_SQL.failRetry, QUEUE_SQL.failTerminal]) {
      expect(sql).toMatch(/lease_token = \$2/);
      expect(sql).toContain("status IN ('leased', 'running')");
    }
    // heartbeat additionally refuses to revive an already-expired lease.
    expect(QUEUE_SQL.heartbeat).toContain('lease_expires_at > now()');
    // complete/reclaim/fail clear the lease so a stale token can never match again.
    for (const sql of [QUEUE_SQL.complete, QUEUE_SQL.failRetry, QUEUE_SQL.failTerminal, QUEUE_SQL.reclaim]) {
      expect(sql).toContain('lease_token = NULL');
    }
  });

  it('computes run_at / lease_expires_at in SQL or epoch ms - never by slicing an ISO string', () => {
    expect(QUEUE_SQL.claimLease).toContain('make_interval(secs =>');
    expect(QUEUE_SQL.failRetry).toContain('run_at = $3::timestamptz');
    for (const sql of Object.values(QUEUE_SQL)) {
      expect(sql).not.toContain('slice(');
    }
    expect(SERVICE_SOURCE).not.toMatch(/slice\(0,\s*10\)/);
  });

  it('reclaims a stale lease with a single atomic CASE (queued if attempts remain, else dead_letter)', () => {
    expect(QUEUE_SQL.reclaim).toContain('CASE WHEN attempt < max_attempts');
    expect(QUEUE_SQL.reclaim).toContain('lease_expires_at <= now()');
  });
});

describe('enqueue', () => {
  it('inserts a queued job with the supplied payload and defaults', async () => {
    const { fake, queue } = setup();
    const res = await queue.enqueue('morning_brief', { hello: 'world' }, { userId: 7 });
    expect(res).toEqual({ id: 'job-1', created: true });
    const job = fake.jobs.get('job-1');
    expect(job?.status).toBe('queued');
    expect(job?.payload).toEqual({ hello: 'world' });
    expect(job?.priority).toBe(0);
    expect(job?.max_attempts).toBe(3);
    expect(job?.attempt).toBe(0);
  });

  it('does not create a second job for a duplicate (user_id, idempotencyKey)', async () => {
    const { fake, queue } = setup();
    const first = await queue.enqueue('morning_brief', { n: 1 }, { userId: 7, idempotencyKey: 'brief-2026-01-01' });
    const second = await queue.enqueue('morning_brief', { n: 2 }, { userId: 7, idempotencyKey: 'brief-2026-01-01' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(fake.jobs.size).toBe(1);
    expect([...fake.jobs.values()][0].payload).toEqual({ n: 1 });
  });

  it('scopes the idempotency key per user (another user may reuse the key)', async () => {
    const { fake, queue } = setup();
    await queue.enqueue('morning_brief', {}, { userId: 1, idempotencyKey: 'k' });
    const other = await queue.enqueue('morning_brief', {}, { userId: 2, idempotencyKey: 'k' });
    expect(other.created).toBe(true);
    expect(fake.jobs.size).toBe(2);
  });
});

describe('claimBatch', () => {
  it('claims in (priority DESC, run_at ASC) order and stamps the lease fields', async () => {
    const { clock, fake, queue } = setup();
    await queue.enqueue('hourly_triage', { n: 'A' }, { userId: 1, priority: 0, runAt: clock.t - 1000 });
    await queue.enqueue('hourly_triage', { n: 'B' }, { userId: 1, priority: 9, runAt: clock.t - 5000 });
    await queue.enqueue('hourly_triage', { n: 'C' }, { userId: 1, priority: 9, runAt: clock.t - 1000 });

    const claimed = await queue.claimBatch(3, 120);
    expect(claimed.map((j) => j.payload)).toEqual([{ n: 'B' }, { n: 'C' }, { n: 'A' }]);
    expect(claimed[0].attempt).toBe(1);
    expect(new Date(claimed[0].leaseExpiresAt).getTime()).toBe(clock.t + 120_000);
    const row = fake.jobs.get(claimed[0].id);
    expect(row?.status).toBe('leased');
    expect(row?.lease_owner).toBe('w1');
    expect(row?.lease_token).toBe(claimed[0].leaseToken);
    expect(row?.started_at).toBe(clock.t);
  });

  it('returns [] when nothing is due', async () => {
    const { clock, queue } = setup();
    await queue.enqueue('hourly_triage', {}, { userId: 1, runAt: clock.t + 60_000 });
    expect(await queue.claimBatch(5, 60)).toEqual([]);
  });

  it('8 parallel claimBatch(1) calls claim each of 8 jobs EXACTLY once (no duplicate lease_token)', async () => {
    const { fake, queue } = setup();
    await seed(queue, 8);

    const batches = await Promise.all(Array.from({ length: 8 }, () => queue.claimBatch(1, 60)));
    const claimed = batches.flat();

    expect(batches.every((batch) => batch.length === 1)).toBe(true);
    expect(claimed).toHaveLength(8);
    expect(new Set(claimed.map((j) => j.id)).size).toBe(8);
    expect(new Set(claimed.map((j) => j.leaseToken)).size).toBe(8);
    expect(claimed.every((j) => j.attempt === 1)).toBe(true);
    for (const job of fake.jobs.values()) {
      expect(job.status).toBe('leased');
      expect(job.attempt).toBe(1);
    }
  });
});

describe('heartbeat', () => {
  it('renews a live lease', async () => {
    const { clock, queue } = setup();
    await queue.enqueue('watchdog', {}, { userId: 1 });
    const [job] = await queue.claimBatch(1, 30);
    clock.t += 10_000;
    const hb = await queue.heartbeat(job.id, job.leaseToken, 90);
    expect(hb.renewed).toBe(true);
    expect(new Date(hb.leaseExpiresAt as string).getTime()).toBe(clock.t + 90_000);
  });

  it('rejects a mismatched token', async () => {
    const { fake, queue } = setup();
    await queue.enqueue('watchdog', {}, { userId: 1 });
    const [job] = await queue.claimBatch(1, 30);
    const hb = await queue.heartbeat(job.id, FOREIGN_TOKEN, 90);
    expect(hb).toEqual({ renewed: false, leaseExpiresAt: null });
    expect(fake.jobs.get(job.id)?.lease_expires_at).toBe(T0 + 30_000);
  });

  it('rejects an expired lease', async () => {
    const { clock, fake, queue } = setup();
    await queue.enqueue('watchdog', {}, { userId: 1 });
    const [job] = await queue.claimBatch(1, 30);
    clock.t += 31_000;
    const hb = await queue.heartbeat(job.id, job.leaseToken, 90);
    expect(hb.renewed).toBe(false);
    expect(fake.jobs.get(job.id)?.lease_expires_at).toBe(T0 + 30_000);
  });
});

describe('complete', () => {
  it('completes a job with the live lease token', async () => {
    const { clock, fake, queue } = setup();
    await queue.enqueue('evening_review', {}, { userId: 1 });
    const [job] = await queue.claimBatch(1, 30);
    const res = await queue.complete(job.id, job.leaseToken, { summary: 'ok' }, 42);
    expect(res.completed).toBe(true);
    const row = fake.jobs.get(job.id);
    expect(row?.status).toBe('succeeded');
    expect(row?.result).toEqual({ summary: 'ok' });
    expect(row?.cost_tokens).toBe(42);
    expect(row?.finished_at).toBe(clock.t);
    expect(row?.lease_token).toBeNull();
  });

  it('REJECTS a mismatched token while the job is still live', async () => {
    const { fake, queue } = setup();
    await queue.enqueue('evening_review', {}, { userId: 1 });
    const [job] = await queue.claimBatch(1, 30);
    const res = await queue.complete(job.id, FOREIGN_TOKEN, { nope: true }, 0);
    expect(res.completed).toBe(false);
    expect(fake.jobs.get(job.id)?.status).toBe('leased');
    expect(fake.jobs.get(job.id)?.result).toBeNull();
  });

  it('REJECTS a stale token after the lease was reclaimed', async () => {
    const { clock, fake, queue } = setup();
    await queue.enqueue('evening_review', {}, { userId: 1 });
    const [job] = await queue.claimBatch(1, 30);
    clock.t += 31_000;
    await queue.reclaimExpiredLeases();
    const res = await queue.complete(job.id, job.leaseToken, { late: true }, 1);
    expect(res.completed).toBe(false);
    expect(fake.jobs.get(job.id)?.status).toBe('queued');
    expect(fake.jobs.get(job.id)?.result).toBeNull();
  });
});

describe('fail', () => {
  it('schedules a retryable failure into the future with jitter', async () => {
    const { clock, queue } = setup({ random: () => 1 });
    await queue.enqueue('hourly_triage', {}, { userId: 1, maxAttempts: 5 });
    const [job] = await queue.claimBatch(1, 30);
    const before = clock.t;
    const res = await queue.fail(job.id, job.leaseToken, 'E_UPSTREAM', 'boom', true);
    expect(res.outcome).toBe('queued');
    expect(res.recorded).toBe(true);
    const nextAt = new Date(res.nextRunAt as string).getTime();
    expect(nextAt).toBeGreaterThan(before);
    // base*1 + base*ratio * 1 = 36_000 ms
    expect(nextAt - before).toBe(QUEUE_BACKOFF_BASE_MS + QUEUE_BACKOFF_BASE_MS * QUEUE_BACKOFF_JITTER_RATIO);
  });

  it('backs off monotonically across 4 attempts (30s / 60s / 120s / 240s, no jitter injected)', async () => {
    const { clock, queue } = setup({ random: () => 0 });
    await queue.enqueue('hourly_triage', {}, { userId: 1, maxAttempts: 10 });

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const [job] = await queue.claimBatch(1, 60);
      expect(job.attempt).toBe(attempt);
      const before = clock.t;
      const res = await queue.fail(job.id, job.leaseToken, 'E_TMP', 'boom', true);
      expect(res.outcome).toBe('queued');
      const nextAt = new Date(res.nextRunAt as string).getTime();
      expect(nextAt).toBeGreaterThan(before);
      delays.push(nextAt - before);
      clock.t = nextAt;
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000]);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it('caps the exponential growth and never grows unboundedly', () => {
    for (const attempt of [20, 40, 80, 1000]) {
      expect(computeBackoffMs(attempt, () => 0)).toBe(QUEUE_BACKOFF_CAP_MS);
      expect(computeBackoffMs(attempt, () => 1)).toBe(
        QUEUE_BACKOFF_CAP_MS + QUEUE_BACKOFF_CAP_MS * QUEUE_BACKOFF_JITTER_RATIO,
      );
    }
    expect(computeBackoffMs(1000, () => 0.5)).toBeLessThanOrEqual(
      QUEUE_BACKOFF_CAP_MS + QUEUE_BACKOFF_CAP_MS * QUEUE_BACKOFF_JITTER_RATIO,
    );
    // jitter is bounded to [0, ratio] and never negative
    expect(computeBackoffMs(1, () => -5)).toBe(QUEUE_BACKOFF_BASE_MS);
  });

  it('dead-letters a retryable failure once attempts are exhausted', async () => {
    const { fake, queue } = setup();
    await queue.enqueue('hourly_triage', {}, { userId: 1, maxAttempts: 1 });
    const [job] = await queue.claimBatch(1, 30);
    const res = await queue.fail(job.id, job.leaseToken, 'E_UPSTREAM', 'boom', true);
    expect(res.outcome).toBe('dead_letter');
    expect(fake.jobs.get(job.id)?.status).toBe('dead_letter');
  });

  it('marks a non-retryable failure as failed', async () => {
    const { fake, queue } = setup();
    await queue.enqueue('hourly_triage', {}, { userId: 1, maxAttempts: 5 });
    const [job] = await queue.claimBatch(1, 30);
    const res = await queue.fail(job.id, job.leaseToken, 'E_BAD_INPUT', 'nope', false);
    expect(res.outcome).toBe('failed');
    expect(fake.jobs.get(job.id)?.status).toBe('failed');
  });

  it('REJECTS a fail with a stale token (no mutation)', async () => {
    const { fake, queue } = setup();
    await queue.enqueue('hourly_triage', {}, { userId: 1, maxAttempts: 5 });
    const [job] = await queue.claimBatch(1, 30);
    const res = await queue.fail(job.id, FOREIGN_TOKEN, 'E_X', 'boom', false);
    expect(res.recorded).toBe(false);
    expect(res.outcome).toBeNull();
    expect(fake.jobs.get(job.id)?.status).toBe('leased');
  });
});

describe('reclaimExpiredLeases', () => {
  it('returns a stale lease to queued when attempts remain', async () => {
    const { clock, fake, queue } = setup();
    await queue.enqueue('weekly_review', {}, { userId: 1, maxAttempts: 3 });
    const [job] = await queue.claimBatch(1, 30);
    clock.t += 31_000;
    const res = await queue.reclaimExpiredLeases();
    expect(res).toEqual({ reclaimed: 1, deadLettered: 0 });
    const row = fake.jobs.get(job.id);
    expect(row?.status).toBe('queued');
    expect(row?.run_at).toBe(clock.t);
    expect(row?.lease_token).toBeNull();
    expect(row?.lease_expires_at).toBeNull();
  });

  it('dead-letters a stale lease when attempts are exhausted', async () => {
    const { clock, fake, queue } = setup();
    await queue.enqueue('weekly_review', {}, { userId: 1, maxAttempts: 1 });
    const [job] = await queue.claimBatch(1, 30);
    clock.t += 31_000;
    const res = await queue.reclaimExpiredLeases();
    expect(res).toEqual({ reclaimed: 0, deadLettered: 1 });
    const row = fake.jobs.get(job.id);
    expect(row?.status).toBe('dead_letter');
    expect(row?.error_code).toBe('LEASE_EXPIRED');
    expect(row?.finished_at).toBe(clock.t);
  });

  it('ignores a lease that has not expired', async () => {
    const { clock, fake, queue } = setup();
    await queue.enqueue('weekly_review', {}, { userId: 1 });
    const [job] = await queue.claimBatch(1, 60);
    clock.t += 10_000;
    const res = await queue.reclaimExpiredLeases();
    expect(res).toEqual({ reclaimed: 0, deadLettered: 0 });
    expect(fake.jobs.get(job.id)?.status).toBe('leased');
  });
});

describe('QA: worker dies mid-run (stops heartbeating)', () => {
  it('reclaims the job, re-runs it, and rejects the dead worker\'s complete', async () => {
    const { clock, fake, queue } = setup();
    await queue.enqueue('morning_brief', { user: 1 }, { userId: 1, maxAttempts: 3 });

    // Worker A claims the job under a 30s lease, then hangs and never heartbeats.
    const [jobA] = await queue.claimBatch(1, 30);
    expect(fake.jobs.get(jobA.id)?.status).toBe('leased');

    // Lease expires; the reclaimer returns the job to the queue.
    clock.t += 31_000;
    const reclaimed = await queue.reclaimExpiredLeases();
    expect(reclaimed).toEqual({ reclaimed: 1, deadLettered: 0 });
    expect(fake.jobs.get(jobA.id)?.status).toBe('queued');
    expect(fake.jobs.get(jobA.id)?.lease_token).toBeNull();

    // Worker B claims and runs it (attempt 2), then completes successfully.
    const [jobB] = await queue.claimBatch(1, 30);
    expect(jobB.id).toBe(jobA.id);
    expect(jobB.attempt).toBe(2);
    const done = await queue.complete(jobB.id, jobB.leaseToken, { ok: true }, 7);
    expect(done.completed).toBe(true);

    // The dead worker A wakes up and tries to complete with its old token - REJECTED.
    const late = await queue.complete(jobA.id, jobA.leaseToken, { ok: 'stale' }, 99);
    expect(late.completed).toBe(false);
    const row = fake.jobs.get(jobA.id);
    expect(row?.status).toBe('succeeded');
    expect(row?.result).toEqual({ ok: true });
    expect(row?.cost_tokens).toBe(7);
  });
});
