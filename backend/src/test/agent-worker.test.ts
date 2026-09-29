import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AgentJobKind, ClaimedJob, FailOutcome } from '../services/agent/queue.service.js';
import {
  DEFAULT_DRAIN_LIMIT,
  MAX_DRAIN_LIMIT,
  createAgentWorkerRoutes,
  type AgentJobExecutor,
  type AgentWorkerDrainConfig,
  type AgentWorkerQueue,
} from '../routes/agent-worker.js';

/**
 * Checkbox 114 acceptance: the bounded worker drain + liveness probe.
 *
 * The queue is a small in-memory fake with the REAL contract (claim -> lease token ->
 * heartbeat/complete/fail/reclaim), so the tests drive the shipped route logic, not a
 * re-implementation: claim caps, lease-token echo, the deadline race, partial-run summaries
 * and the exact `{claimed, succeeded, failed, reclaimed, remaining}` shape.
 *
 * `hasValidWorkerCredential` + `pulse`/`executeWithinBudget` are exercised through the
 * mounted Hono app with `app.request`, exactly like the production call path (minus the
 * global middleware stack, which the route cannot change).
 */

const { mockQuery, mockTransaction } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  query: mockQuery,
  withTransaction: mockTransaction,
}));

const CRON_SECRET = 'test-cron-secret';
const AUTH = { Authorization: `Bearer ${CRON_SECRET}` };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A handler that succeeds with no result - the seam later checkboxes replace. */
const completeOk: AgentJobExecutor = async () => ({});

interface FakeJob {
  id: string;
  kind: AgentJobKind;
  payload: unknown;
  status: 'queued' | 'leased' | 'succeeded' | 'failed' | 'dead_letter';
  leaseToken: string | null;
}

interface FakeQueueState {
  jobs: FakeJob[];
  claimCalls: number[];
  heartbeatCalls: { id: string; token: string; extendSeconds: number }[];
  completeCalls: { id: string; token: string; result: unknown; costTokens: number }[];
  failCalls: { id: string; token: string; code: string; message: string; retryable: boolean }[];
  reclaimCount: number;
  order: string[];
  claimThrows: boolean;
  reclaimThrows: boolean;
}

function uuidFor(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function createFakeQueue(seedCount: number): { queue: AgentWorkerQueue; state: FakeQueueState } {
  const jobs: FakeJob[] = Array.from({ length: seedCount }, (_, i) => ({
    id: `job-${i + 1}`,
    kind: 'hourly_triage' as AgentJobKind,
    payload: { i },
    status: 'queued' as const,
    leaseToken: null,
  }));
  const state: FakeQueueState = {
    jobs,
    claimCalls: [],
    heartbeatCalls: [],
    completeCalls: [],
    failCalls: [],
    reclaimCount: 0,
    order: [],
    claimThrows: false,
    reclaimThrows: false,
  };
  let tokens = 0;

  const queue: AgentWorkerQueue = {
    async claimBatch(limit, leaseSeconds): Promise<ClaimedJob[]> {
      state.order.push('claim');
      state.claimCalls.push(limit);
      if (state.claimThrows) throw new Error('claim unavailable');
      return jobs
        .filter((job) => job.status === 'queued')
        .slice(0, limit)
        .map((job) => {
          tokens += 1;
          job.status = 'leased';
          job.leaseToken = uuidFor(tokens);
          return {
            id: job.id,
            userId: 1,
            kind: job.kind,
            payload: job.payload,
            priority: 0,
            attempt: 1,
            maxAttempts: 3,
            leaseToken: job.leaseToken,
            leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
          };
        });
    },

    async heartbeat(id, leaseToken, extendSeconds) {
      state.heartbeatCalls.push({ id, token: leaseToken, extendSeconds });
      const job = jobs.find((candidate) => candidate.id === id);
      const renewed = Boolean(job && job.leaseToken === leaseToken);
      return {
        renewed,
        leaseExpiresAt: renewed ? new Date(Date.now() + extendSeconds * 1000).toISOString() : null,
      };
    },

    async complete(id, leaseToken, result, costTokens = 0) {
      state.completeCalls.push({ id, token: leaseToken, result, costTokens });
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job || job.leaseToken !== leaseToken) return { completed: false };
      job.status = 'succeeded';
      job.leaseToken = null;
      return { completed: true };
    },

    async fail(id, leaseToken, errorCode, errorMessage, retryable) {
      state.failCalls.push({ id, token: leaseToken, code: errorCode, message: errorMessage, retryable });
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job || job.leaseToken !== leaseToken) return { recorded: false, outcome: null, nextRunAt: null };
      const outcome: FailOutcome = retryable ? 'queued' : 'failed';
      job.status = outcome;
      job.leaseToken = null;
      return { recorded: true, outcome, nextRunAt: null };
    },

    async reclaimExpiredLeases() {
      state.order.push('reclaim');
      if (state.reclaimThrows) throw new Error('reclaim unavailable');
      return { reclaimed: state.reclaimCount, deadLettered: 0 };
    },
  };

  return { queue, state };
}

/** Wire the DEFAULT `countQueued` source (mocked db) to the fake queue's live rows. */
function wireQueuedCount(state: FakeQueueState): void {
  mockQuery.mockImplementation(async (text: string) => {
    if (text.replace(/\s+/g, ' ').includes("FROM agent_jobs WHERE status = 'queued'")) {
      return {
        rows: [{ remaining: state.jobs.filter((job) => job.status === 'queued').length }],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected SQL in test: ${text}`);
  });
}

function buildApp(options: {
  queue: AgentWorkerQueue;
  execute?: AgentJobExecutor;
  now?: () => number;
  config?: Partial<AgentWorkerDrainConfig>;
  countQueued?: () => Promise<number>;
}): Hono {
  const app = new Hono();
  app.route('/api/agent/worker', createAgentWorkerRoutes(options));
  return app;
}

function post(app: Hono, path = '/api/agent/worker/drain', init?: RequestInit): Response | Promise<Response> {
  return app.request(path, { method: 'POST', headers: AUTH, ...init });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockTransaction.mockReset();
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  vi.stubEnv('CRONSECRET', '');
  vi.stubEnv('AGENT_WORKER_TOKEN', '');
  vi.stubEnv('AGENT_DRAIN_LIMIT', '');
  vi.stubEnv('AGENT_DRAIN_DEADLINE_MS', '');
  vi.stubEnv('AGENT_DRAIN_RESPONSE_BUDGET_MS', '');
  vi.stubEnv('AGENT_DRAIN_HEARTBEAT_MS', '');
  vi.stubEnv('AGENT_DRAIN_MIN_CLAIM_MS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/agent/worker/drain - guard', () => {
  it('rejects a missing Authorization header with 401 and never claims', async () => {
    const { queue, state } = createFakeQueue(3);
    wireQueuedCount(state);
    const app = buildApp({ queue });

    const res = await app.request('/api/agent/worker/drain', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(state.claimCalls).toEqual([]);
  });

  it('rejects a wrong secret with 401 and never claims', async () => {
    const { queue, state } = createFakeQueue(3);
    wireQueuedCount(state);
    const app = buildApp({ queue });

    const res = await app.request('/api/agent/worker/drain', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-secret' },
    });
    expect(res.status).toBe(401);
    expect(state.claimCalls).toEqual([]);
  });

  it('stays closed (500) when neither CRON_SECRET nor AGENT_WORKER_TOKEN is configured', async () => {
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('CRONSECRET', '');
    vi.stubEnv('AGENT_WORKER_TOKEN', '');
    const { queue, state } = createFakeQueue(1);
    wireQueuedCount(state);
    const app = buildApp({ queue });

    const res = await post(app);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'CRON_SECRET / AGENT_WORKER_TOKEN not configured' });
    expect(state.claimCalls).toEqual([]);
  });

  it('accepts the dedicated AGENT_WORKER_TOKEN without echoing it', async () => {
    const workerToken = 'worker-token-abc';
    vi.stubEnv('AGENT_WORKER_TOKEN', workerToken);
    const { queue, state } = createFakeQueue(1);
    wireQueuedCount(state);
    const app = buildApp({ queue });

    const res = await app.request('/api/agent/worker/drain', {
      method: 'POST',
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(workerToken);
    expect(JSON.stringify(body)).not.toContain(CRON_SECRET);
  });
});

describe('GET /api/agent/worker/drain - liveness probe', () => {
  it('returns 200 ok without auth, without claiming and without touching the DB', async () => {
    const { queue, state } = createFakeQueue(2);
    wireQueuedCount(state);
    const app = buildApp({ queue });

    const res = await app.request('/api/agent/worker/drain', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      endpoint: '/api/agent/worker/drain',
      method: 'POST',
    });
    expect(state.order).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('POST /api/agent/worker/drain - bounded batch', () => {
  it('claims at most the default limit (3) out of 10 jobs and reports remaining', async () => {
    const { queue, state } = createFakeQueue(10);
    wireQueuedCount(state);
    const app = buildApp({ queue, execute: completeOk });

    const res = await post(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body).toEqual({ claimed: 3, succeeded: 3, failed: 0, reclaimed: 0, remaining: 7 });
    expect(state.claimCalls).toEqual([DEFAULT_DRAIN_LIMIT]);
    expect(state.jobs.slice(0, 3).map((job) => job.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(state.jobs.slice(3).every((job) => job.status === 'queued')).toBe(true);
  });

  it('a second drain claims the NEXT batch, not the same jobs again', async () => {
    const { queue, state } = createFakeQueue(10);
    wireQueuedCount(state);
    const app = buildApp({ queue, execute: completeOk });

    const first = (await (await post(app)).json()) as Record<string, number>;
    const second = (await (await post(app)).json()) as Record<string, number>;
    expect(first.remaining).toBe(7);
    expect(second.claimed).toBe(3);
    expect(second.remaining).toBe(4);
    const completedIds = state.completeCalls.map((call) => call.id);
    expect(completedIds).toEqual(['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']);
    expect(new Set(completedIds).size).toBe(6);
  });

  it('honours ?limit=2 and a JSON body limit', async () => {
    const queryRun = createFakeQueue(5);
    wireQueuedCount(queryRun.state);
    const queryApp = buildApp({ queue: queryRun.queue });
    const queryBody = (await (await post(queryApp, '/api/agent/worker/drain?limit=2')).json()) as Record<string, number>;
    expect(queryBody.claimed).toBe(2);
    expect(queryRun.state.claimCalls).toEqual([2]);

    const bodyRun = createFakeQueue(5);
    wireQueuedCount(bodyRun.state);
    const bodyApp = buildApp({ queue: bodyRun.queue });
    const bodyRes = await post(bodyApp, '/api/agent/worker/drain', {
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2 }),
    });
    expect(((await bodyRes.json()) as Record<string, number>).claimed).toBe(2);
    expect(bodyRun.state.claimCalls).toEqual([2]);
  });

  it('clamps an oversized limit to MAX_DRAIN_LIMIT', async () => {
    const { queue, state } = createFakeQueue(5);
    wireQueuedCount(state);
    const app = buildApp({ queue });

    const res = await post(app, '/api/agent/worker/drain?limit=99999');
    expect(((await res.json()) as Record<string, number>).claimed).toBe(5);
    expect(state.claimCalls).toEqual([MAX_DRAIN_LIMIT]);
  });
});

describe('POST /api/agent/worker/drain - heartbeat, deadline, failures', () => {
  it('heartbeats a claimed job with the exact uuid lease token it was given', async () => {
    const { queue, state } = createFakeQueue(1);
    wireQueuedCount(state);
    const app = buildApp({ queue, execute: completeOk, config: { heartbeatIntervalMs: 10_000 } });

    const res = await post(app);
    expect(res.status).toBe(200);
    expect(state.heartbeatCalls).toHaveLength(1);
    const beat = state.heartbeatCalls[0];
    expect(beat.id).toBe('job-1');
    expect(beat.token).toMatch(UUID_RE);
    expect(beat.token).toBe(state.completeCalls[0].token);
    expect(beat.extendSeconds).toBeGreaterThan(0);
  });

  it('keeps heartbeating a slow job while it runs, then completes it', async () => {
    const { queue, state } = createFakeQueue(1);
    wireQueuedCount(state);
    const slowButFinishing: AgentJobExecutor = async (job) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { result: { id: job.id }, costTokens: 3 };
    };
    const app = buildApp({
      queue,
      execute: slowButFinishing,
      config: { heartbeatIntervalMs: 15, deadlineMs: 1_000, responseBudgetMs: 900, minClaimBudgetMs: 1 },
    });

    const res = await post(app);
    const body = (await res.json()) as Record<string, number>;
    expect(body.succeeded).toBe(1);
    expect(state.heartbeatCalls.length).toBeGreaterThanOrEqual(2);
    expect(state.completeCalls[0]).toMatchObject({ id: 'job-1', result: { id: 'job-1' }, costTokens: 3 });
  });

  it('DEADLINE: a never-finishing handler cannot hold the response; jobs stay leased', async () => {
    const { queue, state } = createFakeQueue(10);
    wireQueuedCount(state);
    const neverFinishes: AgentJobExecutor = () => new Promise<void>(() => {});
    const config = { deadlineMs: 1_000, responseBudgetMs: 150, heartbeatIntervalMs: 10_000, minClaimBudgetMs: 1 };
    const app = buildApp({ queue, execute: neverFinishes, config });

    const startedAt = Date.now();
    const res = await post(app);
    const elapsed = Date.now() - startedAt;
    const body = (await res.json()) as Record<string, number>;

    expect(res.status).toBe(200);
    // Effective cut = min(deadline 1000ms, responseBudget 150ms) => well under the 700ms bound,
    // and nowhere near the unbounded handler (which never resolves).
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(700);
    expect(body).toEqual({ claimed: 3, succeeded: 0, failed: 0, reclaimed: 0, remaining: 10 });
    expect(state.claimCalls).toEqual([3]);
    // Unfinished work is NOT failed and NOT completed: it stays `leased` for the next tick.
    expect(state.completeCalls).toEqual([]);
    expect(state.failCalls).toEqual([]);
    expect(state.jobs.slice(0, 3).every((job) => job.status === 'leased')).toBe(true);
    expect(state.jobs.slice(3).every((job) => job.status === 'queued')).toBe(true);
  });

  it('a throwing job increments failed, is re-queued for retry, and the run still returns', async () => {
    const { queue, state } = createFakeQueue(2);
    wireQueuedCount(state);
    const throws: AgentJobExecutor = async () => {
      throw new Error('boom');
    };
    const app = buildApp({ queue, execute: throws });

    const res = await post(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body).toEqual({ claimed: 2, succeeded: 0, failed: 2, reclaimed: 0, remaining: 2 });
    expect(state.failCalls).toHaveLength(2);
    expect(state.failCalls.every((call) => call.code === 'EXECUTION_FAILED' && call.retryable)).toBe(true);
    expect(state.completeCalls).toEqual([]);
    expect(state.jobs.every((job) => job.status === 'queued')).toBe(true);
  });

  it('the default executor fails with NO_HANDLER instead of silently completing', async () => {
    const { queue, state } = createFakeQueue(1);
    wireQueuedCount(state);
    const app = buildApp({ queue });

    const res = await post(app);
    const body = (await res.json()) as Record<string, number>;
    expect(body.failed).toBe(1);
    expect(state.failCalls[0].code).toBe('NO_HANDLER');
    expect(state.completeCalls).toEqual([]);
  });

  it('surfaces a claim failure instead of swallowing it', async () => {
    const { queue, state } = createFakeQueue(3);
    wireQueuedCount(state);
    state.claimThrows = true;
    const app = buildApp({ queue });

    const res = await post(app);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
      reclaimed: 0,
      remaining: 0,
      error: 'claim_failed',
    });
  });

  it('surfaces a reclaim failure instead of swallowing it', async () => {
    const { queue, state } = createFakeQueue(0);
    wireQueuedCount(state);
    state.reclaimThrows = true;
    const app = buildApp({ queue });

    const res = await post(app);
    expect(res.status).toBe(500);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('reclaim_failed');
  });
});

describe('POST /api/agent/worker/drain - summary contract', () => {
  it('zero jobs: all zeros, no error', async () => {
    const { queue, state } = createFakeQueue(0);
    wireQueuedCount(state);
    const app = buildApp({ queue });

    const res = await post(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: 0, succeeded: 0, failed: 0, reclaimed: 0, remaining: 0 });
    expect(state.claimCalls).toEqual([3]);
  });

  it('runs reclaimExpiredLeases FIRST and surfaces its count in reclaimed', async () => {
    const { queue, state } = createFakeQueue(2);
    wireQueuedCount(state);
    state.reclaimCount = 4;
    const app = buildApp({ queue });

    const body = (await (await post(app)).json()) as Record<string, number>;
    expect(body.reclaimed).toBe(4);
    expect(state.order).toEqual(['reclaim', 'claim']);
  });

  it('summary shape is exactly the five numeric keys on a partial run', async () => {
    const { queue, state } = createFakeQueue(10);
    wireQueuedCount(state);
    const halfFail: AgentJobExecutor = async (job) => {
      if (job.id === 'job-2') throw new Error('nope');
      return {};
    };
    const app = buildApp({ queue, execute: halfFail });

    const body = (await (await post(app)).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['claimed', 'failed', 'reclaimed', 'remaining', 'succeeded']);
    for (const value of Object.values(body)) expect(typeof value).toBe('number');
    expect(body).toEqual({ claimed: 3, succeeded: 2, failed: 1, reclaimed: 0, remaining: 8 });
  });

  it('counts remaining through the shipped queued-jobs SQL when no counter is injected', async () => {
    const { queue, state } = createFakeQueue(3);
    wireQueuedCount(state);
    const app = buildApp({ queue, execute: completeOk });

    const body = (await (await post(app)).json()) as Record<string, number>;
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("FROM agent_jobs WHERE status = 'queued'"));
    expect(body.remaining).toBe(0);
  });
});
