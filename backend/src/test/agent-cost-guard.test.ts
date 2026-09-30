import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Checkbox 117 acceptance (part 2): the per-job cost guard.
 *
 * Three layers are exercised against the REAL shipped code:
 *  1. `budget.service.ts` - the pure monthly budget decision + the shipped usage SQL;
 *  2. `job-runner.service.ts` - the executor that ENFORCES the guard on a claimed job
 *     (tier resolution, skip/defer/allow, recorded reason, cost_tokens pass-through);
 *  3. the real drain route (`routes/agent-worker.ts`, imported read-only) - one mixed
 *     batch proves the guard is enforced on the real path (not only in a helper), and
 *     the QA failure case proves an `AiDisabledError` from a provider does not abort
 *     the batch: the affected job is retried and the remaining jobs still complete.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: mockQuery,
  withTransaction: vi.fn(),
}));

import {
  MONTHLY_BUDGET_ENV,
  MONTHLY_USAGE_SQL,
  evaluateMonthlyBudget,
  getMonthlyUsage,
  isBudgetExhausted,
  readMonthlyBudget,
  type MonthlyBudget,
} from '../services/agent/budget.service.js';
import {
  AGENT_JOB_TIER_BY_KIND,
  AgentJobHandlerMissingError,
  JOB_EVENT_INSERT_SQL,
  ROUTINE_TIER_SQL,
  chatCostTokens,
  createAgentJobExecutor,
  type AgentJobHandlerContext,
  type AgentJobRunnerDeps,
} from '../services/agent/job-runner.service.js';
import { AiDisabledError, createAiGateway, type AiChatOptions } from '../services/ai/gateway.js';
import type { AgentJobKind, ClaimedJob } from '../services/agent/queue.service.js';
import {
  createAgentWorkerRoutes,
  type AgentJobExecutor,
  type AgentWorkerQueue,
} from '../routes/agent-worker.js';

const CRON_SECRET = 'test-cron-secret';
const AUTH = { Authorization: `Bearer ${CRON_SECRET}` };
const ROUTINE_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A configured AI env (routing only needs the slot to resolve; no call is made here). */
function aiEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    AI_BASE_URL: 'https://primary.example/v1',
    AI_API_KEY: 'sk-test',
    AI_MODEL: 'primary-model',
    ...extra,
  };
}

const EXHAUSTED: MonthlyBudget = { tokens: 100, calls: 10 };
const USAGE_AT_CAP = { tokens: 100, calls: 4 };
const USAGE_BELOW = { tokens: 99, calls: 4 };
const NOW_MS = Date.parse('2026-01-15T00:00:00.000Z');
const NEXT_MONTH = '2026-02-01T00:00:00.000Z';

let jobSeq = 0;
function claimedJob(kind: AgentJobKind, overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  jobSeq += 1;
  const n = String(jobSeq).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${n}`,
    userId: 1,
    kind,
    payload: {},
    priority: 0,
    attempt: 1,
    maxAttempts: 3,
    leaseToken: `10000000-0000-4000-8000-${n}`,
    leaseExpiresAt: '2026-01-15T01:00:00.000Z',
    ...overrides,
  };
}

interface EnqueueCall {
  kind: AgentJobKind;
  payload: unknown;
  options: { runAt?: Date | number | null; idempotencyKey?: string | null };
}

/** Runner harness: every dependency observable, no real DB and no real queue. */
function makeRunner(overrides: AgentJobRunnerDeps = {}) {
  const state = {
    enqueued: [] as EnqueueCall[],
    events: [] as { jobId: string; status: string; detail: Record<string, unknown> }[],
    usageReads: [] as number[],
    routineTierReads: [] as { routineId: string; userId: number }[],
  };
  const byKey = new Map<string, string>();
  const deps: AgentJobRunnerDeps = {
    env: aiEnv({ [MONTHLY_BUDGET_ENV.tokens]: '100', [MONTHLY_BUDGET_ENV.calls]: '10' }),
    now: () => NOW_MS,
    readUsage: async (userId) => {
      state.usageReads.push(userId);
      return USAGE_AT_CAP;
    },
    resolveRoutineTier: async (routineId, userId) => {
      state.routineTierReads.push({ routineId, userId });
      return null;
    },
    recordEvent: async (jobId, status, detail) => {
      state.events.push({ jobId, status, detail });
    },
    enqueue: async (kind, payload, options = {}) => {
      state.enqueued.push({ kind, payload, options });
      const key = options.idempotencyKey ?? `nokey-${state.enqueued.length}`;
      const existing = byKey.get(key);
      if (existing) return { id: existing, created: false };
      const id = `follow-up-${byKey.size + 1}`;
      byKey.set(key, id);
      return { id, created: true };
    },
    ...overrides,
  };
  return { execute: createAgentJobExecutor(deps), state };
}

// --- Layer 3 fakes: a queue with the real claim/lease/complete/fail contract --------

interface FakeQueueState {
  completeCalls: { id: string; token: string; result: unknown; costTokens: number }[];
  failCalls: { id: string; token: string; code: string; message: string; retryable: boolean }[];
  claimedIds: string[];
}

function createFakeQueue(claims: ClaimedJob[]): { queue: AgentWorkerQueue; state: FakeQueueState } {
  const state: FakeQueueState = { completeCalls: [], failCalls: [], claimedIds: [] };
  const queue: AgentWorkerQueue = {
    async claimBatch(limit) {
      const batch = claims.splice(0, limit);
      state.claimedIds.push(...batch.map((job) => job.id));
      return batch;
    },
    async heartbeat() {
      return { renewed: true, leaseExpiresAt: '2026-01-15T01:00:00.000Z' };
    },
    async complete(id, leaseToken, result, costTokens = 0) {
      state.completeCalls.push({ id, token: leaseToken, result, costTokens });
      return { completed: true };
    },
    async fail(id, leaseToken, code, message, retryable) {
      state.failCalls.push({ id, token: leaseToken, code, message, retryable });
      return { recorded: true, outcome: retryable ? 'queued' : 'failed', nextRunAt: null };
    },
    async reclaimExpiredLeases() {
      return { reclaimed: 0, deadLettered: 0 };
    },
  };
  return { queue, state };
}

function buildDrainApp(queue: AgentWorkerQueue, execute: AgentJobExecutor): Hono {
  const app = new Hono();
  app.route(
    '/api/agent/worker',
    createAgentWorkerRoutes({ queue, execute, countQueued: async () => 0 }),
  );
  return app;
}

async function postDrain(app: Hono): Promise<Response> {
  return app.request('/api/agent/worker/drain', { method: 'POST', headers: AUTH });
}

beforeEach(() => {
  mockQuery.mockReset();
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
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

describe('monthly budget configuration + usage', () => {
  it('parses the ceilings: unset/malformed/negative are unlimited, an explicit 0 blocks', () => {
    expect(readMonthlyBudget({})).toEqual({ tokens: null, calls: null });
    expect(readMonthlyBudget({ [MONTHLY_BUDGET_ENV.tokens]: ' 250 ', [MONTHLY_BUDGET_ENV.calls]: '10' })).toEqual({
      tokens: 250,
      calls: 10,
    });
    expect(readMonthlyBudget({ [MONTHLY_BUDGET_ENV.tokens]: '0' })).toEqual({ tokens: 0, calls: null });
    expect(readMonthlyBudget({ [MONTHLY_BUDGET_ENV.tokens]: '-5' })).toEqual({ tokens: null, calls: null });
    expect(readMonthlyBudget({ [MONTHLY_BUDGET_ENV.tokens]: 'lots' })).toEqual({ tokens: null, calls: null });
  });

  it('reads the current month of agent_jobs with the DB-computed boundary (no UTC slice)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tokens: '42', calls: '3' }], rowCount: 1 });
    expect(await getMonthlyUsage(7)).toEqual({ tokens: 42, calls: 3 });
    expect(mockQuery).toHaveBeenCalledWith(MONTHLY_USAGE_SQL, [7]);

    expect(MONTHLY_USAGE_SQL).toContain("date_trunc('month', now())");
    expect(MONTHLY_USAGE_SQL).toContain('SUM(cost_tokens)');
    expect(MONTHLY_USAGE_SQL).toContain('COUNT(*) FILTER (WHERE cost_tokens > 0)');

    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await getMonthlyUsage(7)).toEqual({ tokens: 0, calls: 0 });
  });

  it('a configured ceiling is exhausted at the boundary (usage >= budget)', () => {
    expect(isBudgetExhausted(EXHAUSTED, USAGE_BELOW)).toBe(false);
    expect(isBudgetExhausted(EXHAUSTED, USAGE_AT_CAP)).toBe(true);
    expect(isBudgetExhausted({ tokens: null, calls: null }, USAGE_AT_CAP)).toBe(false);
  });
});

describe('evaluateMonthlyBudget', () => {
  it('allows a job comfortably inside the ceilings with no reason', () => {
    const decision = evaluateMonthlyBudget({
      tier: 'lite',
      aiConfigured: true,
      budget: EXHAUSTED,
      usage: USAGE_BELOW,
    });
    expect(decision).toMatchObject({ action: 'allow', reason: null, overBudget: false });
  });

  it('exhausted: lite skips, medium defers, high drains over budget (reason recorded)', () => {
    const base = { aiConfigured: true, budget: EXHAUSTED, usage: USAGE_AT_CAP };
    expect(evaluateMonthlyBudget({ ...base, tier: 'lite' })).toMatchObject({
      action: 'skip',
      reason: 'BUDGET_EXHAUSTED_TOKENS',
      overBudget: true,
    });
    expect(evaluateMonthlyBudget({ ...base, tier: 'medium' })).toMatchObject({
      action: 'defer',
      reason: 'BUDGET_EXHAUSTED_TOKENS',
      overBudget: true,
    });
    expect(evaluateMonthlyBudget({ ...base, tier: 'high' })).toMatchObject({
      action: 'allow',
      reason: 'BUDGET_EXHAUSTED_TOKENS',
      overBudget: true,
    });
  });

  it('the call ceiling exhausts independently and is reported as the reason', () => {
    const base = { aiConfigured: true, budget: { tokens: null, calls: 10 }, usage: { tokens: 5, calls: 10 } };
    expect(evaluateMonthlyBudget({ ...base, tier: 'lite' })).toMatchObject({
      action: 'skip',
      reason: 'BUDGET_EXHAUSTED_CALLS',
    });
    expect(evaluateMonthlyBudget({ ...base, tier: 'medium' }).action).toBe('defer');
  });

  it('a zero budget blocks lite/medium immediately while high still drains', () => {
    const base = { aiConfigured: true, budget: { tokens: 0, calls: null }, usage: { tokens: 0, calls: 0 } };
    expect(evaluateMonthlyBudget({ ...base, tier: 'lite' }).action).toBe('skip');
    expect(evaluateMonthlyBudget({ ...base, tier: 'medium' }).action).toBe('defer');
    expect(evaluateMonthlyBudget({ ...base, tier: 'high' }).action).toBe('allow');
  });

  it('AI OFF is never blocked by a budget check, even at a zero budget (criterion 14)', () => {
    for (const tier of ['lite', 'medium', 'high'] as const) {
      expect(
        evaluateMonthlyBudget({
          tier,
          aiConfigured: false,
          budget: { tokens: 0, calls: 0 },
          usage: { tokens: 999, calls: 999 },
        }),
      ).toMatchObject({ action: 'allow', reason: null, overBudget: false });
    }
  });
});

describe('job runner: tier resolution + guard enforcement', () => {
  it('skips a lite job when exhausted: no handler call, marker + job event with the reason', async () => {
    const { execute, state } = makeRunner({ handlers: { hourly_triage: async () => ({ result: { ran: true } }) } });
    const job = claimedJob('hourly_triage');

    const outcome = await execute(job);

    expect(outcome).toEqual({
      result: {
        degraded: true,
        action: 'skipped',
        tier: 'lite',
        reason: 'BUDGET_EXHAUSTED_TOKENS',
        usage: USAGE_AT_CAP,
        budget: EXHAUSTED,
      },
      costTokens: 0,
    });
    expect(state.usageReads).toEqual([1]);
    expect(state.events).toEqual([
      {
        jobId: job.id,
        status: 'skipped',
        detail: {
          action: 'budget_skip',
          actor: 'cost_guard',
          tier: 'lite',
          reason: 'BUDGET_EXHAUSTED_TOKENS',
          usage: USAGE_AT_CAP,
          budget: EXHAUSTED,
        },
      },
    ]);
  });

  it('defers a medium job to the next UTC month, enqueued once per month (idempotent)', async () => {
    const ran = vi.fn(async () => ({ result: { ran: true } }));
    const { execute, state } = makeRunner({ handlers: { morning_brief: ran } });
    const job = claimedJob('morning_brief');

    const first = await execute(job);
    const second = await execute(job); // at-least-once duplicate delivery

    expect(first.result).toMatchObject({
      degraded: true,
      action: 'deferred',
      tier: 'medium',
      reason: 'BUDGET_EXHAUSTED_TOKENS',
      resumeAt: NEXT_MONTH,
    });
    expect(second.result).toEqual(first.result);
    expect(ran).not.toHaveBeenCalled();
    expect(state.enqueued).toHaveLength(2);
    for (const call of state.enqueued) {
      expect(call.kind).toBe('morning_brief');
      expect(call.payload).toMatchObject({ deferred_from: job.id });
      expect(call.options.idempotencyKey).toBe(`budget-defer:${job.id}:2026-02`);
      expect(new Date(call.options.runAt as Date).toISOString()).toBe(NEXT_MONTH);
    }
    expect(state.events.map((event) => event.status)).toEqual(['deferred', 'deferred']);
  });

  it('high still drains when exhausted, and deterministic kinds are never gated', async () => {
    const seen: { kind: string; tier: string | null }[] = [];
    const handler = async (job: ClaimedJob, context: { tier: string | null }) => {
      seen.push({ kind: job.kind, tier: context.tier });
      return { result: { drained: true }, costTokens: 4 };
    };
    const { execute, state } = makeRunner({
      handlers: { weekly_review: handler, watchdog: handler },
    });

    const high = await execute(claimedJob('weekly_review'));
    expect(high).toMatchObject({ result: { drained: true }, costTokens: 4 });

    const watchdog = await execute(claimedJob('watchdog'));
    expect(watchdog).toMatchObject({ result: { drained: true } });

    expect(seen).toEqual([
      { kind: 'weekly_review', tier: 'high' },
      { kind: 'watchdog', tier: null },
    ]);
    // One usage read (the high job); the deterministic job never touched the budget.
    expect(state.usageReads).toEqual([1]);
    expect(state.events).toEqual([]);
  });

  it('resolves the tier payload.tier > agent_routines.tier > kind default', async () => {
    const seen: (string | null)[] = [];
    const { execute } = makeRunner({
      handlers: {
        hourly_triage: async (_job, context) => {
          seen.push(context.tier);
          return {};
        },
        morning_brief: async (_job, context) => {
          seen.push(context.tier);
          return {};
        },
      },
      resolveRoutineTier: async () => 'high',
      readUsage: async () => USAGE_BELOW,
    });

    await execute(claimedJob('hourly_triage', { payload: { tier: 'lite', routine_id: ROUTINE_UUID } }));
    await execute(claimedJob('hourly_triage', { payload: { routine_id: ROUTINE_UUID } }));
    await execute(claimedJob('morning_brief', { payload: { routine_id: 'not-a-uuid' } }));
    await execute(claimedJob('morning_brief', { payload: { tier: 'extreme' } }));

    expect(seen).toEqual(['lite', 'high', 'medium', 'medium']);
  });

  it('the shipped routine-tier lookup never casts an untrusted payload id to uuid', async () => {
    expect(ROUTINE_TIER_SQL).toContain('id::text = $1');
    expect(ROUTINE_TIER_SQL).not.toContain('::uuid');

    const seen: (string | null)[] = [];
    const execute = createAgentJobExecutor({
      env: aiEnv(),
      now: () => NOW_MS,
      handlers: {
        hourly_triage: async (_job, context) => {
          seen.push(context.tier);
          return {};
        },
      },
    });

    mockQuery.mockResolvedValueOnce({ rows: [{ tier: 'high' }], rowCount: 1 });
    await execute(claimedJob('hourly_triage', { payload: { routine_id: ROUTINE_UUID } }));
    expect(mockQuery).toHaveBeenCalledWith(ROUTINE_TIER_SQL, [ROUTINE_UUID, 1]);
    expect(seen).toEqual(['high']);

    // A missing / malformed stored tier falls back to the kind default, never to a bogus tier.
    mockQuery.mockResolvedValueOnce({ rows: [{ tier: 'extreme' }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await execute(claimedJob('hourly_triage', { payload: { routine_id: ROUTINE_UUID } }));
    await execute(claimedJob('hourly_triage', { payload: { routine_id: ROUTINE_UUID } }));
    expect(seen).toEqual(['high', 'lite', 'lite']);
  });

  it('records cost_tokens from the provider usage of a real gateway call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: 'stub',
          choices: [{ message: { role: 'assistant', content: 'brief' } }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        }),
    });
    const handler = async (_job: ClaimedJob, context: AgentJobHandlerContext) => {
      const options: AiChatOptions = context.tier ? { tier: context.tier } : {};
      const result = await createAiGateway({
        fetchImpl: fetchMock as unknown as typeof fetch,
        env: aiEnv(),
        random: () => 0,
      }).chat([{ role: 'user', content: 'hi' }], options);
      return { result: { content: result.content }, costTokens: chatCostTokens(result) };
    };
    const { execute } = makeRunner({
      handlers: { morning_brief: handler },
      env: aiEnv(), // no budget configured -> the call runs
    });

    const outcome = await execute(claimedJob('morning_brief'));
    expect(outcome).toMatchObject({ result: { content: 'brief' }, costTokens: 8 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never silently completes a job whose kind has no handler (NO_HANDLER)', async () => {
    const { execute } = makeRunner({ handlers: {}, env: aiEnv() });
    await expect(execute(claimedJob('hourly_triage'))).rejects.toBeInstanceOf(AgentJobHandlerMissingError);
    await expect(execute(claimedJob('hourly_triage'))).rejects.toMatchObject({ code: 'NO_HANDLER' });
  });

  it('AI OFF plus an exhausted budget never blocks the job (criterion 14)', async () => {
    const ran = vi.fn(async () => ({ result: { deterministic: true } }));
    const { execute, state } = makeRunner({
      handlers: { hourly_triage: ran, evening_review: ran, weekly_review: ran },
      // Every AI variable empty, and a zero budget that would block a configured setup.
      env: { [MONTHLY_BUDGET_ENV.tokens]: '0', [MONTHLY_BUDGET_ENV.calls]: '0' },
    });

    for (const kind of ['hourly_triage', 'evening_review', 'weekly_review'] as const) {
      const outcome = await execute(claimedJob(kind));
      expect(outcome).toMatchObject({ result: { deterministic: true } });
    }
    expect(ran).toHaveBeenCalledTimes(3);
    // The guard short-circuits before any usage read, and records no degradation.
    expect(state.usageReads).toEqual([]);
    expect(state.events).toEqual([]);
  });
});

describe('drain route integration: the guard on the real path', () => {
  it('one mixed batch: lite skipped, medium deferred, high drains - reasons recorded', async () => {
    const liteJob = claimedJob('hourly_triage');
    const mediumJob = claimedJob('morning_brief');
    const highJob = claimedJob('weekly_review');
    const { queue, state } = createFakeQueue([liteJob, mediumJob, highJob]);

    const liteHandler = vi.fn(async () => ({ result: { ran: 'lite' } }));
    const mediumHandler = vi.fn(async () => ({ result: { ran: 'medium' } }));
    const highHandler = vi.fn(async () => ({ result: { ran: 'high' } }));
    const { execute, state: runnerState } = makeRunner({
      handlers: {
        hourly_triage: liteHandler,
        morning_brief: mediumHandler,
        weekly_review: highHandler,
      },
    });

    const res = await postDrain(buildDrainApp(queue, execute));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: 3, succeeded: 3, failed: 0, reclaimed: 0, remaining: 0 });

    expect(liteHandler).not.toHaveBeenCalled();
    expect(mediumHandler).not.toHaveBeenCalled();
    expect(highHandler).toHaveBeenCalledTimes(1);

    const byId = new Map(state.completeCalls.map((call) => [call.id, call]));
    const liteResult = byId.get(liteJob.id)?.result as Record<string, unknown>;
    const mediumResult = byId.get(mediumJob.id)?.result as Record<string, unknown>;
    expect(liteResult).toMatchObject({ degraded: true, action: 'skipped', tier: 'lite' });
    expect(mediumResult).toMatchObject({ degraded: true, action: 'deferred', tier: 'medium' });
    expect(byId.get(highJob.id)?.result).toEqual({ ran: 'high' });

    expect(runnerState.enqueued).toHaveLength(1);
    expect(runnerState.enqueued[0].options.idempotencyKey).toBe(`budget-defer:${mediumJob.id}:2026-02`);
    expect(runnerState.events.map((event) => [event.jobId, event.status])).toEqual([
      [liteJob.id, 'skipped'],
      [mediumJob.id, 'deferred'],
    ]);
  });

  it('QA failure: an AiDisabledError provider does not abort the batch; the job is retried', async () => {
    const jobs = [claimedJob('hourly_triage'), claimedJob('morning_brief'), claimedJob('evening_review')];
    const { queue, state } = createFakeQueue([...jobs]);

    const providerDown = async () => {
      const gateway = createAiGateway({ env: {}, fetchImpl: vi.fn() as unknown as typeof fetch });
      await gateway.chat([{ role: 'user', content: 'hi' }]);
    };
    const succeeds = async () => ({ result: { ok: true }, costTokens: 2 });
    const { execute, state: runnerState } = makeRunner({
      handlers: { hourly_triage: providerDown, morning_brief: succeeds, evening_review: succeeds },
      env: {}, // every AI variable empty -> the guard must NOT block these jobs
    });

    const res = await postDrain(buildDrainApp(queue, execute));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: 3, succeeded: 2, failed: 1, reclaimed: 0, remaining: 0 });

    expect(state.failCalls).toEqual([
      {
        id: jobs[0].id,
        token: jobs[0].leaseToken,
        code: 'AI_DISABLED',
        message: expect.stringContaining('AI is not configured'),
        retryable: true,
      },
    ]);
    expect(state.completeCalls.map((call) => call.id)).toEqual([jobs[1].id, jobs[2].id]);
    // The guard allowed (AI off), nothing was skipped/deferred, and usage was never read.
    expect(runnerState.events).toEqual([]);
    expect(runnerState.usageReads).toEqual([]);
  });

  it('records the provider usage as the job cost_tokens on completion', async () => {
    const job = claimedJob('morning_brief');
    const { queue, state } = createFakeQueue([job]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: 'stub',
          choices: [{ message: { role: 'assistant', content: 'narrative' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
    });
    const handler = async (_job: ClaimedJob, context: AgentJobHandlerContext) => {
      const options: AiChatOptions = context.tier ? { tier: context.tier } : {};
      const result = await createAiGateway({
        fetchImpl: fetchMock as unknown as typeof fetch,
        env: aiEnv(),
        random: () => 0,
      }).chat([{ role: 'user', content: 'hi' }], options);
      return { result: { content: result.content }, costTokens: chatCostTokens(result) };
    };
    const { execute } = makeRunner({
      handlers: { morning_brief: handler },
      env: aiEnv(),
      readUsage: async () => ({ tokens: 0, calls: 0 }),
    });

    const res = await postDrain(buildDrainApp(queue, execute));
    expect(await res.json()).toEqual({ claimed: 1, succeeded: 1, failed: 0, reclaimed: 0, remaining: 0 });
    expect(state.completeCalls).toEqual([
      { id: job.id, token: job.leaseToken, result: { content: 'narrative' }, costTokens: 18 },
    ]);
  });

  it('the kind -> tier map covers the AI jobs and leaves watchdog deterministic', () => {
    expect(AGENT_JOB_TIER_BY_KIND).toEqual({
      hourly_triage: 'lite',
      morning_brief: 'medium',
      evening_review: 'medium',
      weekly_review: 'high',
    });
    expect(AGENT_JOB_TIER_BY_KIND.watchdog).toBeUndefined();
  });

  it('the default event writer uses the shipped agent_job_events insert', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text === MONTHLY_USAGE_SQL) return { rows: [{ tokens: 100, calls: 4 }], rowCount: 1 };
      if (text === JOB_EVENT_INSERT_SQL) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL: ${text}`);
    });
    // No injected reader/writer: the shipped usage SQL and event INSERT are exercised.
    const execute = createAgentJobExecutor({
      env: aiEnv({ [MONTHLY_BUDGET_ENV.tokens]: '100' }),
      now: () => NOW_MS,
      handlers: {},
    });

    const job = claimedJob('hourly_triage');
    await execute(job);

    const insert = mockQuery.mock.calls.find((call) => call[0] === JOB_EVENT_INSERT_SQL);
    expect(insert?.[1]?.[0]).toBe(job.id);
    expect(insert?.[1]?.[1]).toBe('skipped');
    expect(JSON.parse(String(insert?.[1]?.[2]))).toMatchObject({
      action: 'budget_skip',
      actor: 'cost_guard',
      reason: 'BUDGET_EXHAUSTED_TOKENS',
    });
  });

  it('an AiDisabledError thrown by a provider is still typed as a machine-readable code', () => {
    expect(new AiDisabledError().code).toBe('AI_DISABLED');
  });
});
