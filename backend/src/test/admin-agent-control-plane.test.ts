import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Checkbox 119 acceptance: the agent control-plane API (`/api/admin/agent`).
 *
 * The DB is an in-memory store with a SQL router that models exactly the semantics the
 * shipped statements rely on:
 *  - keyset pagination: the `(created_at, id) < ($t, $id)` predicate + `ORDER BY ... DESC`
 *    (and `(name, id) > ($n, $id)` / `w.id > $id` for the ASC orders) - a new row at the
 *    head cannot shift a page, so two pages never duplicate or drop an id;
 *  - the transition UPDATEs are GUARD-AWARE: the fake only enforces `status IN (...)`
 *    when the shipped SQL text actually carries it, so deleting the guard makes the
 *    illegal-transition tests fail (see negative controls);
 *  - `agent_job_events` rows are appended by the route's own INSERT, so "each transition
 *    writes an event" is asserted on state, not on a call count.
 *
 * Index conformance is asserted STRUCTURALLY on the captured SQL (equality/keyset
 * predicates must match the leading index columns named in v54: `(user_id, created_at DESC)`,
 * `(status, run_at)`, `(kind, status)`, plus the workers PK and the routines
 * `UNIQUE(user_id, name)`). A unit-level `EXPLAIN` is deliberately not asserted: with a
 * handful of seeded rows the planner legitimately picks a seq scan, so the EXPLAIN output
 * would be noise rather than evidence.
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery, dbTransaction } = vi.hoisted(() => ({ dbQuery: vi.fn(), dbTransaction: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  withTransaction: dbTransaction,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      if (authState.user) {
        c.set('user', authState.user);
        return next();
      }
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(
        c,
        next,
      );
    },
  };
});

import {
  ADMIN_AGENT_SQL,
  DEFAULT_LIST_LIMIT,
  MAX_JOB_EVENTS_LIMIT,
  MAX_LIST_LIMIT,
  MAX_ROUTINE_CONFIG_BYTES,
  TRANSITION_SQL,
  createAdminAgentRoutes,
  encodeCursor,
} from '../routes/admin/agent.js';

const USER = { id: 7, username: 'alice' };
const T0 = Date.parse('2026-06-01T12:00:00.000Z');
const STALE_AFTER_MS = 120_000;

const clock = { t: T0 };
const captured: { sql: string; params: unknown[] }[] = [];

type Row = Record<string, unknown>;

interface FakeJob {
  id: string;
  user_id: number | null;
  kind: string;
  payload: Record<string, unknown> | null;
  status: string;
  priority: number;
  attempt: number;
  max_attempts: number;
  idempotency_key: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  run_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  result: unknown;
  cost_tokens: number;
  created_at: string;
  updated_at: string;
}

interface FakeEvent {
  id: number;
  job_id: string;
  at: string;
  status: string | null;
  detail: unknown;
}

interface FakeWorker {
  id: string;
  kind: string | null;
  last_seen_at: string | null;
  meta: unknown;
}

interface FakeRoutine {
  id: string;
  user_id: number;
  name: string;
  cron_expr: string | null;
  kind: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  tier: string | null;
  budget_per_day: number | null;
  config: unknown;
}

interface FakeState {
  jobs: FakeJob[];
  events: FakeEvent[];
  workers: FakeWorker[];
  routines: FakeRoutine[];
  now: () => number;
  nextEventId: number;
}

interface Result {
  rows: Row[];
  rowCount: number;
}

type FakeClient = { query: (text: string, params?: unknown[]) => Promise<Result> };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function uuidFor(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function paramPos(s: string, pattern: RegExp): number | null {
  const match = pattern.exec(s);
  return match ? Number(match[1]) - 1 : null;
}

function extractGuardStatuses(guard: string): string[] {
  return [...guard.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

function stateValue(state: FakeState, index: number, values: unknown[]): unknown {
  return values[index];
}

function jobRow(job: FakeJob): Row {
  return { ...job, has_idempotency_key: job.idempotency_key !== null };
}

function applyJobListFilters(state: FakeState, s: string, params: unknown[]): FakeJob[] {
  const userPos = paramPos(s, /j\.user_id = \$(\d+)/);
  const statusPos = paramPos(s, /j\.status = \$(\d+)/);
  const kindPos = paramPos(s, /j\.kind = \$(\d+)/);
  const cursorMatch = /\(j\.created_at, j\.id\) < \(\$(\d+)::timestamptz, \$(\d+)::uuid\)/.exec(s);

  let rows = [...state.jobs];
  if (userPos !== null) rows = rows.filter((job) => job.user_id === Number(stateValue(state, userPos, params)));
  if (statusPos !== null) rows = rows.filter((job) => job.status === String(stateValue(state, statusPos, params)));
  if (kindPos !== null) rows = rows.filter((job) => job.kind === String(stateValue(state, kindPos, params)));
  if (cursorMatch) {
    const cursorAt = String(stateValue(state, Number(cursorMatch[1]) - 1, params));
    const cursorId = String(stateValue(state, Number(cursorMatch[2]) - 1, params));
    rows = rows.filter(
      (job) => job.created_at < cursorAt || (job.created_at === cursorAt && job.id < cursorId),
    );
  }
  rows.sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
  );
  const limit = Number(params[params.length - 1]);
  return rows.slice(0, limit);
}

function applyRoutineListFilters(state: FakeState, s: string, params: unknown[]): FakeRoutine[] {
  const userPos = paramPos(s, /r\.user_id = \$(\d+)/);
  const enabledPos = paramPos(s, /r\.enabled = \$(\d+)/);
  const cursorMatch = /\(r\.name, r\.id\) > \(\$(\d+), \$(\d+)::uuid\)/.exec(s);

  let rows = [...state.routines];
  if (userPos !== null) rows = rows.filter((routine) => routine.user_id === Number(stateValue(state, userPos, params)));
  if (enabledPos !== null) rows = rows.filter((routine) => routine.enabled === Boolean(stateValue(state, enabledPos, params)));
  if (cursorMatch) {
    const cursorName = String(stateValue(state, Number(cursorMatch[1]) - 1, params));
    const cursorId = String(stateValue(state, Number(cursorMatch[2]) - 1, params));
    rows = rows.filter(
      (routine) => routine.name > cursorName || (routine.name === cursorName && routine.id > cursorId),
    );
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const limit = Number(params[params.length - 1]);
  return rows.slice(0, limit);
}

function respond(state: FakeState, s: string, params: unknown[]): Result {
  // --- writes -----------------------------------------------------------------
  if (s.startsWith('INSERT INTO agent_job_events')) {
    const [jobId, status, detailJson] = params;
    state.events.push({
      id: state.nextEventId,
      job_id: String(jobId),
      at: iso(state.now()),
      status: status == null ? null : String(status),
      detail: detailJson == null ? null : JSON.parse(String(detailJson)),
    });
    state.nextEventId += 1;
    return { rows: [], rowCount: 1 };
  }

  if (s.startsWith('INSERT INTO agent_routines')) {
    const [userId, name, kind, cronExpr, enabled, tier, budgetPerDay, configJson] = params;
    if (state.routines.some((routine) => routine.user_id === Number(userId) && routine.name === String(name))) {
      const conflict = new Error('duplicate key value violates unique constraint');
      (conflict as { code?: string }).code = '23505';
      throw conflict;
    }
    const routine: FakeRoutine = {
      id: uuidFor(900 + state.routines.length),
      user_id: Number(userId),
      name: String(name),
      cron_expr: cronExpr == null ? null : String(cronExpr),
      kind: String(kind),
      enabled: Boolean(enabled),
      next_run_at: null,
      last_run_at: null,
      tier: tier == null ? null : String(tier),
      budget_per_day: budgetPerDay == null ? null : Number(budgetPerDay),
      config: configJson == null ? {} : JSON.parse(String(configJson)),
    };
    state.routines.push(routine);
    return { rows: [{ ...routine }], rowCount: 1 };
  }

  if (s.startsWith('UPDATE agent_routines SET')) {
    const idPos = /WHERE id = \$(\d+) AND user_id = \$(\d+)/.exec(s);
    if (!idPos) throw new Error(`unrouted routine update: ${s}`);
    const id = String(params[Number(idPos[1]) - 1]);
    const userId = Number(params[Number(idPos[2]) - 1]);
    const routine = state.routines.find((candidate) => candidate.id === id && candidate.user_id === userId);
    if (!routine) return { rows: [], rowCount: 0 };
    const enabledPos = paramPos(s, /enabled = \$(\d+)/);
    const cronPos = paramPos(s, /cron_expr = \$(\d+)/);
    const tierPos = paramPos(s, /tier = \$(\d+)/);
    const budgetPos = paramPos(s, /budget_per_day = \$(\d+)/);
    const configPos = paramPos(s, /config = \$(\d+)::jsonb/);
    if (enabledPos !== null) routine.enabled = Boolean(params[enabledPos]);
    if (cronPos !== null) routine.cron_expr = params[cronPos] == null ? null : String(params[cronPos]);
    if (tierPos !== null) routine.tier = params[tierPos] == null ? null : String(params[tierPos]);
    if (budgetPos !== null) routine.budget_per_day = params[budgetPos] == null ? null : Number(params[budgetPos]);
    if (configPos !== null) routine.config = params[configPos] == null ? {} : JSON.parse(String(params[configPos]));
    return { rows: [{ ...routine }], rowCount: 1 };
  }

  if (s.startsWith('WITH prev AS')) {
    const id = String(params[0]);
    const job = state.jobs.find((candidate) => candidate.id === id);
    if (!job) return { rows: [], rowCount: 0 };

    const isCancel = s.includes("SET status = 'cancelled'");
    const isRetry = s.includes('max_attempts = GREATEST');
    const guard = isCancel
      ? "j.status IN ('queued', 'leased', 'running')"
      : isRetry
        ? "j.status IN ('failed', 'dead_letter', 'cancelled')"
        : "j.status IN ('leased', 'running')";
    // Guard-aware on purpose: the predicate is only enforced when the shipped SQL text
    // carries it, so removing it from TRANSITION_SQL reproduces the corruption.
    if (s.includes(guard) && !extractGuardStatuses(guard).includes(job.status)) {
      return { rows: [], rowCount: 0 };
    }

    const fromStatus = job.status;
    if (isCancel) {
      job.status = 'cancelled';
      job.finished_at = iso(state.now());
    } else {
      job.status = 'queued';
      job.run_at = iso(state.now());
      job.error_code = null;
      job.error_message = null;
      job.finished_at = null;
      if (isRetry) job.max_attempts = Math.max(job.max_attempts, job.attempt + 1);
    }
    job.lease_owner = null;
    job.lease_token = null;
    job.lease_expires_at = null;
    job.last_heartbeat_at = null;
    job.updated_at = iso(state.now());
    return {
      rows: [
        {
          id: job.id,
          status: job.status,
          attempt: job.attempt,
          max_attempts: job.max_attempts,
          from_status: fromStatus,
        },
      ],
      rowCount: 1,
    };
  }

  // --- job reads ---------------------------------------------------------------
  if (s.startsWith('SELECT id, status FROM agent_jobs WHERE id = $1')) {
    const job = state.jobs.find((candidate) => candidate.id === String(params[0]));
    return job ? { rows: [{ id: job.id, status: job.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  if (s.includes('FROM agent_jobs WHERE id = $1')) {
    const job = state.jobs.find((candidate) => candidate.id === String(params[0]));
    return job ? { rows: [jobRow(job)], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  if (s.includes('COUNT(*)::int AS total FROM agent_job_events')) {
    const total = state.events.filter((event) => event.job_id === String(params[0])).length;
    return { rows: [{ total }], rowCount: 1 };
  }

  if (s.includes('FROM agent_job_events e') && s.includes('ORDER BY e.at ASC')) {
    const jobId = String(params[0]);
    const limit = Number(params[1]);
    const rows = state.events
      .filter((event) => event.job_id === jobId)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id))
      .slice(0, limit)
      .map((event) => ({ ...event }));
    return { rows, rowCount: rows.length };
  }

  // --- routines -----------------------------------------------------------------
  if (s.includes('SELECT r.id FROM agent_routines r WHERE r.user_id = $1 AND r.name = $2')) {
    const found = state.routines.find(
      (routine) => routine.user_id === Number(params[0]) && routine.name === String(params[1]),
    );
    return found ? { rows: [{ id: found.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  if (s.includes('FROM agent_routines r WHERE r.id = $1 AND r.user_id = $2')) {
    const found = state.routines.find(
      (routine) => routine.id === String(params[0]) && routine.user_id === Number(params[1]),
    );
    return found ? { rows: [{ ...found }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  if (s.includes('FROM agent_routines r WHERE r.user_id = $1')) {
    const rows = applyRoutineListFilters(state, s, params).map((routine) => ({ ...routine }));
    return { rows, rowCount: rows.length };
  }

  // --- workers ------------------------------------------------------------------
  if (s.includes('FROM agent_workers w')) {
    const cursorPos = paramPos(s, /w\.id > \$(\d+)/);
    let rows = [...state.workers];
    if (cursorPos !== null) rows = rows.filter((worker) => worker.id > String(params[cursorPos]));
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const limit = Number(params[params.length - 1]);
    const page = rows.slice(0, limit).map((worker) => ({ ...worker }));
    return { rows: page, rowCount: page.length };
  }

  // --- lists --------------------------------------------------------------------
  if (s.includes('LEFT JOIN agent_routines r')) {
    const jobs = applyJobListFilters(state, s, params);
    const rows = jobs.map((job) => {
      const routineId = job.payload && typeof job.payload.routine_id === 'string' ? job.payload.routine_id : null;
      const routine = routineId === null ? undefined : state.routines.find((candidate) => candidate.id === routineId);
      return {
        id: job.id,
        kind: job.kind,
        status: job.status,
        attempt: job.attempt,
        max_attempts: job.max_attempts,
        cost_tokens: job.cost_tokens,
        created_at: job.created_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        error_code: job.error_code,
        routine_id: routineId,
        routine_name: routine ? routine.name : null,
      };
    });
    return { rows, rowCount: rows.length };
  }

  if (s.includes('FROM agent_jobs j')) {
    const rows = applyJobListFilters(state, s, params).map(jobRow);
    return { rows, rowCount: rows.length };
  }

  // --- stats ---------------------------------------------------------------------
  if (s.includes('tokens_total')) {
    const nowMs = state.now();
    const dayAgo = nowMs - 24 * 60 * 60 * 1000;
    const hourAgo = nowMs - 60 * 60 * 1000;
    const finishedWithin = (job: FakeJob, since: number): boolean =>
      job.finished_at !== null && Date.parse(job.finished_at) >= since;
    const jobs = state.jobs;
    return {
      rows: [
        {
          finished_24h: jobs.filter((job) => finishedWithin(job, dayAgo)).length,
          succeeded_24h: jobs.filter((job) => job.status === 'succeeded' && finishedWithin(job, dayAgo)).length,
          failed_24h: jobs.filter((job) => job.status === 'failed' && finishedWithin(job, dayAgo)).length,
          dead_letter_24h: jobs.filter((job) => job.status === 'dead_letter' && finishedWithin(job, dayAgo)).length,
          finished_1h: jobs.filter((job) => finishedWithin(job, hourAgo)).length,
          tokens_total: jobs.reduce((sum, job) => sum + job.cost_tokens, 0),
          tokens_24h: jobs.filter((job) => finishedWithin(job, dayAgo)).reduce((sum, job) => sum + job.cost_tokens, 0),
          suppressed_total: jobs.filter((job) => job.error_code === 'SUPPRESSED').length,
          suppressed_24h: jobs.filter(
            (job) => job.error_code === 'SUPPRESSED' && Date.parse(job.created_at) >= dayAgo,
          ).length,
        },
      ],
      rowCount: 1,
    };
  }

  if (s.includes('GROUP BY status')) {
    const counts = new Map<string, number>();
    for (const job of state.jobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
    const rows = [...counts.entries()].map(([status, count]) => ({ status, count }));
    return { rows, rowCount: rows.length };
  }

  if (s.includes('GROUP BY kind')) {
    const counts = new Map<string, number>();
    for (const job of state.jobs) counts.set(job.kind, (counts.get(job.kind) ?? 0) + 1);
    const rows = [...counts.entries()].map(([kind, count]) => ({ kind, count }));
    return { rows, rowCount: rows.length };
  }

  throw new Error(`fake db: unrouted SQL -> ${s.slice(0, 200)}`);
}

function createEmptyState(): FakeState {
  return {
    jobs: [],
    events: [],
    workers: [],
    routines: [],
    now: () => clock.t,
    nextEventId: 1,
  };
}

/** The active fake store; re-created in `beforeEach` and mutated by the seeds below. */
let state: FakeState;

function installDb(): void {
  captured.length = 0;
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (text: string, params: unknown[] = []) => {
    const sql = normalize(text);
    captured.push({ sql, params });
    return respond(state, sql, params);
  });
  dbTransaction.mockReset();
  dbTransaction.mockImplementation(async (fn: (client: FakeClient) => Promise<unknown>): Promise<unknown> => {
    const client: FakeClient = {
      query: async (text: string, params: unknown[] = []) => {
        const sql = normalize(text);
        captured.push({ sql, params });
        return respond(state, sql, params);
      },
    };
    return fn(client);
  });
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

let jobSeq = 0;

function seedJob(overrides: Partial<FakeJob> = {}): FakeJob {
  jobSeq += 1;
  const job: FakeJob = {
    id: uuidFor(jobSeq),
    user_id: USER.id,
    kind: 'morning_brief',
    payload: {},
    status: 'queued',
    priority: 0,
    attempt: 0,
    max_attempts: 3,
    idempotency_key: null,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    last_heartbeat_at: null,
    run_at: iso(T0 - jobSeq * 60_000),
    started_at: null,
    finished_at: null,
    error_code: null,
    error_message: null,
    result: null,
    cost_tokens: 0,
    created_at: iso(T0 - jobSeq * 60_000),
    updated_at: iso(T0 - jobSeq * 60_000),
    ...overrides,
  };
  state.jobs.push(job);
  return job;
}

function seedWorker(overrides: Partial<FakeWorker> = {}): FakeWorker {
  const worker: FakeWorker = { id: 'worker-1', kind: 'local', last_seen_at: iso(T0), meta: {}, ...overrides };
  state.workers.push(worker);
  return worker;
}

let routineSeq = 0;

function seedRoutine(overrides: Partial<FakeRoutine> = {}): FakeRoutine {
  routineSeq += 1;
  const routine: FakeRoutine = {
    id: uuidFor(800 + routineSeq),
    user_id: USER.id,
    name: `routine-${routineSeq}`,
    cron_expr: '0 7 * * *',
    kind: 'morning_brief',
    enabled: true,
    next_run_at: iso(T0 + 3_600_000),
    last_run_at: null,
    tier: 'medium',
    budget_per_day: 3,
    config: { timezone: 'Asia/Shanghai' },
    ...overrides,
  };
  state.routines.push(routine);
  return routine;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const enqueueSpy = vi.fn();

function buildApp(overrides: { enqueue?: typeof enqueueSpy; staleAfterMs?: number } = {}): Hono {
  const app = new Hono();
  app.route(
    '/api/admin/agent',
    createAdminAgentRoutes({
      now: () => clock.t,
      staleAfterMs: overrides.staleAfterMs ?? STALE_AFTER_MS,
      enqueue: overrides.enqueue ?? (enqueueSpy as never),
    }),
  );
  return app;
}

function request(app: Hono, path: string, init?: RequestInit): Response | Promise<Response> {
  return app.request(`/api/admin/agent${path}`, init);
}

function lastCaptured(): { sql: string; params: unknown[] } {
  return captured[captured.length - 1];
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(() => {
  authState.user = USER;
  clock.t = T0;
  jobSeq = 0;
  routineSeq = 0;
  enqueueSpy.mockReset();
  enqueueSpy.mockResolvedValue({ id: 'job-run-now', created: true });
  state = createEmptyState();
  installDb();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('rejects every route without a session (401)', async () => {
    authState.user = null;
    const app = buildApp();
    const probes: [string, string][] = [
      ['GET', '/jobs'],
      ['GET', `/jobs/${uuidFor(1)}`],
      ['POST', `/jobs/${uuidFor(1)}/retry`],
      ['POST', `/jobs/${uuidFor(1)}/cancel`],
      ['POST', `/jobs/${uuidFor(1)}/requeue`],
      ['GET', '/workers'],
      ['GET', '/stats'],
      ['GET', '/routines'],
      ['POST', '/routines'],
      ['PATCH', `/routines/${uuidFor(1)}`],
      ['POST', `/routines/${uuidFor(1)}/run-now`],
      ['GET', '/runs'],
    ];
    for (const [method, path] of probes) {
      const res = await request(app, path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /jobs
// ---------------------------------------------------------------------------

describe('GET /jobs', () => {
  it('returns a stable envelope and clamps an oversized limit', async () => {
    seedJob({ status: 'queued' });
    seedJob({ status: 'failed' });
    seedJob({ status: 'succeeded' });
    const app = buildApp();

    const res = await request(app, '/jobs?limit=99999');
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: unknown[]; pagination: Record<string, unknown> }>(res);
    expect(body.success).toBe(true);
    expect(body.pagination).toEqual({ limit: MAX_LIST_LIMIT, hasMore: false, nextCursor: null });
    expect(body.data).toHaveLength(3);
    expect(MAX_LIST_LIMIT).toBe(100);
  });

  it('applies the default limit when limit is absent or malformed', async () => {
    const app = buildApp();
    const res = await request(app, '/jobs?limit=abc');
    const body = await json<{ pagination: { limit: number } }>(res);
    expect(body.pagination.limit).toBe(DEFAULT_LIST_LIMIT);
  });

  it('paginates with a keyset cursor and two pages never overlap', async () => {
    const jobs = [1, 2, 3, 4, 5].map((n) =>
      seedJob({ status: 'queued', created_at: iso(T0 - n * 3_600_000), run_at: iso(T0 - n * 3_600_000) }),
    );
    const app = buildApp();

    const first = await json<{ data: { id: string }[]; pagination: { hasMore: boolean; nextCursor: string | null } }>(
      await request(app, '/jobs?limit=2'),
    );
    expect(first.data.map((job) => job.id)).toEqual([jobs[0].id, jobs[1].id]);
    expect(first.pagination.hasMore).toBe(true);
    expect(first.pagination.nextCursor).toBeTypeOf('string');

    const second = await json<{ data: { id: string }[]; pagination: { hasMore: boolean; nextCursor: string | null } }>(
      await request(app, `/jobs?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor as string)}`),
    );
    expect(second.data.map((job) => job.id)).toEqual([jobs[2].id, jobs[3].id]);
    expect(second.pagination.hasMore).toBe(true);

    const third = await json<{ data: { id: string }[]; pagination: { hasMore: boolean } }>(
      await request(app, `/jobs?limit=2&cursor=${encodeURIComponent(second.pagination.nextCursor as string)}`),
    );
    expect(third.data.map((job) => job.id)).toEqual([jobs[4].id]);
    expect(third.pagination.hasMore).toBe(false);

    const seen = [...first.data, ...second.data, ...third.data].map((job) => job.id);
    expect(new Set(seen).size).toBe(5);
  });

  it('stays stable when a newer job is inserted between pages', async () => {
    const jobs = [1, 2, 3, 4].map((n) =>
      seedJob({ status: 'queued', created_at: iso(T0 - n * 3_600_000) }),
    );
    const app = buildApp();

    const first = await json<{ data: { id: string }[]; pagination: { nextCursor: string | null } }>(
      await request(app, '/jobs?limit=2'),
    );
    // A concurrent producer inserts a newer job at the head - offset pagination would
    // shift page 2 and duplicate the last row of page 1.
    const intruder = seedJob({ status: 'queued', created_at: iso(T0 + 60_000) });

    const second = await json<{ data: { id: string }[] }>(
      await request(app, `/jobs?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor as string)}`),
    );
    const page2 = second.data.map((job) => job.id);
    expect(page2).toEqual([jobs[2].id, jobs[3].id]);
    expect(page2).not.toContain(intruder.id);
    expect(new Set([...first.data.map((job) => job.id), ...page2]).size).toBe(4);
  });

  it('returns a valid empty page for an empty queue', async () => {
    const app = buildApp();
    const res = await request(app, '/jobs');
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: unknown[]; pagination: Record<string, unknown> }>(res);
    expect(body).toEqual({
      success: true,
      data: [],
      pagination: { limit: DEFAULT_LIST_LIMIT, hasMore: false, nextCursor: null },
    });
  });

  it('filters by status and kind with bound parameters (never interpolated)', async () => {
    seedJob({ status: 'failed', kind: 'morning_brief' });
    seedJob({ status: 'succeeded', kind: 'morning_brief' });
    seedJob({ status: 'failed', kind: 'watchdog' });
    const app = buildApp();

    const res = await request(app, '/jobs?status=failed&kind=morning_brief');
    const body = await json<{ data: unknown[] }>(res);
    expect(body.data).toHaveLength(1);

    const sql = lastCaptured().sql;
    expect(sql).toContain('j.status = $');
    expect(sql).toContain('j.kind = $');
    expect(sql).not.toContain("'failed'");
    expect(sql).not.toContain('morning_brief');
    expect(lastCaptured().params).toContain('failed');
    expect(lastCaptured().params).toContain('morning_brief');
  });

  it('rejects an unknown status, unknown kind and malformed cursor with 400', async () => {
    const app = buildApp();
    expect((await request(app, '/jobs?status=exploded')).status).toBe(400);
    expect((await request(app, '/jobs?kind=laundry')).status).toBe(400);
    expect((await request(app, '/jobs?cursor=not-a-cursor')).status).toBe(400);
    const validLooking = encodeCursor(iso(T0), uuidFor(1));
    expect((await request(app, `/jobs?cursor=${validLooking}`)).status).toBe(200);
  });

  it('ignores unknown query parameters instead of interpolating them into SQL', async () => {
    seedJob({ status: 'queued' });
    const app = buildApp();

    const baseline = await json<{ data: unknown[] }>(await request(app, '/jobs?limit=10'));
    const before = captured.length;
    const hostile = await json<{ data: unknown[] }>(
      await request(
        app,
        '/jobs?limit=10&sql=DROP%20TABLE%20users&q=secret&where=1%3D1&orderBy=(SELECT%201)',
      ),
    );
    expect(hostile.data).toEqual(baseline.data);

    const issued = captured.slice(before);
    expect(issued.length).toBeGreaterThan(0);
    for (const statement of issued) {
      expect(statement.sql).not.toContain('DROP');
      expect(statement.sql).not.toContain('secret');
      expect(statement.sql).not.toContain('1=1');
      expect(statement.sql.toLowerCase()).not.toContain('orderby');
      expect(statement.sql).toContain('$');
    }
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:id
// ---------------------------------------------------------------------------

describe('GET /jobs/:id', () => {
  it('returns 400 for a non-uuid id and 404 for an unknown job', async () => {
    const app = buildApp();
    expect((await request(app, '/jobs/not-a-uuid')).status).toBe(400);
    const res = await request(app, `/jobs/${uuidFor(1)}`);
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ success: false, error: 'job_not_found' });
  });

  it('returns the job plus a bounded event timeline', async () => {
    const job = seedJob({ status: 'failed', error_code: 'E_UPSTREAM' });
    for (const minutes of [1, 2, 3]) {
      state.events.push({
        id: minutes,
        job_id: job.id,
        at: iso(T0 - (4 - minutes) * 60_000),
        status: 'failed',
        detail: { n: minutes },
      });
    }
    const app = buildApp();

    const res = await request(app, `/jobs/${job.id}?events_limit=2`);
    expect(res.status).toBe(200);
    const body = await json<{
      data: { job: { id: string; status: string }; events: { id: number }[]; eventsLimit: number; eventsHasMore: boolean; eventsTotal: number };
    }>(res);
    expect(body.data.job.id).toBe(job.id);
    expect(body.data.job.status).toBe('failed');
    expect(body.data.eventsLimit).toBe(2);
    expect(body.data.events).toHaveLength(2);
    expect(body.data.eventsHasMore).toBe(true);
    expect(body.data.eventsTotal).toBe(3);

    const clamped = await json<{ data: { eventsLimit: number } }>(
      await request(app, `/jobs/${job.id}?events_limit=99999`),
    );
    expect(clamped.data.eventsLimit).toBe(MAX_JOB_EVENTS_LIMIT);
    expect(jobRow(job).payload).toBe(job.payload);
  });
});

// ---------------------------------------------------------------------------
// POST /jobs/:id/{retry,cancel,requeue}
// ---------------------------------------------------------------------------

describe('job transitions', () => {
  it('retry moves failed -> queued, bumps max_attempts and writes an event', async () => {
    const job = seedJob({ status: 'failed', attempt: 3, max_attempts: 3, error_code: 'E_UPSTREAM', error_message: 'boom' });
    const app = buildApp();

    const res = await request(app, `/jobs/${job.id}/retry`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await json<{ data: { status: string; previous_status: string; max_attempts: number } }>(res);
    expect(body.data.status).toBe('queued');
    expect(body.data.previous_status).toBe('failed');
    expect(body.data.max_attempts).toBe(4);

    const stored = state.jobs.find((candidate) => candidate.id === job.id);
    expect(stored?.status).toBe('queued');
    expect(stored?.error_code).toBeNull();
    expect(Date.parse(stored?.run_at as string)).toBe(T0);
    const event = state.events.find((candidate) => candidate.job_id === job.id);
    expect(event?.status).toBe('queued');
    expect(event?.detail).toEqual({ action: 'retry', actor: 'admin', from: 'failed' });
  });

  it('retry refuses a succeeded job with 409 illegal_transition', async () => {
    const job = seedJob({ status: 'succeeded', finished_at: iso(T0 - 60_000) });
    const app = buildApp();

    const res = await request(app, `/jobs/${job.id}/retry`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await json<{ success: boolean; error: string; status: string }>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe('illegal_transition');
    expect(body.status).toBe('succeeded');
    expect(state.jobs.find((candidate) => candidate.id === job.id)?.status).toBe('succeeded');
    expect(state.events).toHaveLength(0);
  });

  it('cancel refuses a succeeded job and moves an active job to cancelled with an event', async () => {
    const succeeded = seedJob({ status: 'succeeded', finished_at: iso(T0 - 60_000) });
    const queued = seedJob({ status: 'queued' });
    const app = buildApp();

    const refused = await request(app, `/jobs/${succeeded.id}/cancel`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect((await json<{ error: string }>(refused)).error).toBe('illegal_transition');

    const res = await request(app, `/jobs/${queued.id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    const stored = state.jobs.find((candidate) => candidate.id === queued.id);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.finished_at).toBe(iso(T0));
    const event = state.events.find((candidate) => candidate.job_id === queued.id);
    expect(event?.detail).toEqual({ action: 'cancel', actor: 'admin', from: 'queued' });
  });

  it('requeue releases a leased job and refuses a queued one', async () => {
    const leased = seedJob({ status: 'leased', lease_owner: 'w1', lease_token: uuidFor(999) });
    const queued = seedJob({ status: 'queued' });
    const app = buildApp();

    const refused = await request(app, `/jobs/${queued.id}/requeue`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect((await json<{ error: string }>(refused)).error).toBe('illegal_transition');

    const res = await request(app, `/jobs/${leased.id}/requeue`, { method: 'POST' });
    expect(res.status).toBe(200);
    const stored = state.jobs.find((candidate) => candidate.id === leased.id);
    expect(stored?.status).toBe('queued');
    expect(stored?.lease_owner).toBeNull();
    expect(stored?.lease_token).toBeNull();
    const event = state.events.find((candidate) => candidate.job_id === leased.id);
    expect(event?.detail).toEqual({ action: 'requeue', actor: 'admin', from: 'leased' });
  });

  it('returns 404 for an unknown job and 400 for a non-uuid id on every verb', async () => {
    const app = buildApp();
    for (const verb of ['retry', 'cancel', 'requeue']) {
      const missing = await request(app, `/jobs/${uuidFor(404)}/${verb}`, { method: 'POST' });
      expect(missing.status, verb).toBe(404);
      expect((await json<{ error: string }>(missing)).error).toBe('job_not_found');
      const bad = await request(app, `/jobs/nope/${verb}`, { method: 'POST' });
      expect(bad.status, verb).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /workers
// ---------------------------------------------------------------------------

describe('GET /workers', () => {
  it('derives online and stale from last_seen_at against the injected clock', async () => {
    seedWorker({ id: 'fresh', last_seen_at: iso(T0 - 30_000) });
    seedWorker({ id: 'stale', last_seen_at: iso(T0 - STALE_AFTER_MS - 1) });
    seedWorker({ id: 'boundary', last_seen_at: iso(T0 - STALE_AFTER_MS) });
    seedWorker({ id: 'never', last_seen_at: null });
    const app = buildApp();

    const res = await request(app, '/workers');
    expect(res.status).toBe(200);
    const body = await json<{
      data: { id: string; online: boolean; status: string; lastSeenAgoMs: number | null }[];
      stale_after_ms: number;
    }>(res);
    const byId = new Map(body.data.map((worker) => [worker.id, worker]));
    expect(byId.get('fresh')?.online).toBe(true);
    expect(byId.get('fresh')?.status).toBe('online');
    expect(byId.get('fresh')?.lastSeenAgoMs).toBe(30_000);
    expect(byId.get('stale')?.online).toBe(false);
    expect(byId.get('stale')?.status).toBe('stale');
    expect(byId.get('boundary')?.online).toBe(true);
    expect(byId.get('never')?.status).toBe('stale');
    expect(byId.get('never')?.lastSeenAgoMs).toBeNull();
    expect(body.stale_after_ms).toBe(STALE_AFTER_MS);

    // The injected clock moves the same row across the threshold.
    clock.t = T0 + 10 * 60_000;
    const later = await json<{ data: { id: string; online: boolean }[] }>(await request(app, '/workers'));
    expect(later.data.find((worker) => worker.id === 'fresh')?.online).toBe(false);
  });

  it('paginates workers by id with a keyset cursor', async () => {
    seedWorker({ id: 'a' });
    seedWorker({ id: 'b' });
    seedWorker({ id: 'c' });
    const app = buildApp();
    const first = await json<{ data: { id: string }[]; pagination: { hasMore: boolean; nextCursor: string | null } }>(
      await request(app, '/workers?limit=2'),
    );
    expect(first.data.map((worker) => worker.id)).toEqual(['a', 'b']);
    expect(first.pagination.hasMore).toBe(true);
    const second = await json<{ data: { id: string }[] }>(
      await request(app, `/workers?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor as string)}`),
    );
    expect(second.data.map((worker) => worker.id)).toEqual(['c']);
  });
});

// ---------------------------------------------------------------------------
// GET /stats
// ---------------------------------------------------------------------------

describe('GET /stats', () => {
  function seedStatsFixture(): void {
    seedJob({ kind: 'morning_brief', status: 'queued', created_at: iso(T0 - 3_600_000) });
    seedJob({ kind: 'evening_review', status: 'succeeded', finished_at: iso(T0 - 5_400_000), cost_tokens: 100 });
    seedJob({ kind: 'watchdog', status: 'failed', finished_at: iso(T0 - 7_200_000), cost_tokens: 50 });
    seedJob({ kind: 'watchdog', status: 'succeeded', finished_at: iso(T0 - 10_800_000), cost_tokens: 25 });
    seedJob({ kind: 'morning_brief', status: 'dead_letter', finished_at: iso(T0 - 14_400_000), cost_tokens: 0 });
    seedJob({ kind: 'hourly_triage', status: 'failed', finished_at: iso(T0 - 30 * 3_600_000), cost_tokens: 7 });
    seedJob({ kind: 'hourly_triage', status: 'cancelled', finished_at: iso(T0 - 1_800_000), cost_tokens: 3 });
    seedJob({
      kind: 'morning_brief',
      status: 'queued',
      error_code: 'SUPPRESSED',
      created_at: iso(T0 - 3_600_000),
    });
  }

  it('computes queue depth, throughput, failure rate, tokens and suppressed from real rows', async () => {
    seedStatsFixture();
    const app = buildApp();

    const res = await request(app, '/stats');
    expect(res.status).toBe(200);
    const body = await json<{
      data: {
        byStatus: Record<string, number>;
        byKind: Record<string, number>;
        throughput: Record<string, number>;
        failureRate: number;
        tokens: { spentTotal: number; spentLast24h: number };
        suppressed: { total: number; last24h: number };
      };
    }>(res);

    expect(body.data.byStatus).toEqual({
      queued: 2,
      leased: 0,
      running: 0,
      succeeded: 2,
      failed: 2,
      dead_letter: 1,
      cancelled: 1,
    });
    expect(body.data.byKind).toEqual({
      morning_brief: 3,
      evening_review: 1,
      weekly_review: 0,
      hourly_triage: 2,
      watchdog: 2,
    });
    expect(body.data.throughput).toEqual({
      finishedLast24h: 5,
      succeededLast24h: 2,
      failedLast24h: 1,
      deadLetterLast24h: 1,
      finishedLastHour: 1,
    });
    expect(body.data.failureRate).toBe(0.5);
    expect(body.data.tokens).toEqual({ spentTotal: 185, spentLast24h: 178 });
    expect(body.data.suppressed).toEqual({ total: 1, last24h: 1 });
  });

  it('reports a zero failure rate on an empty queue and documents the SUPPRESSED seam', async () => {
    const app = buildApp();
    const body = await json<{ data: { failureRate: number; byStatus: Record<string, number>; tokens: Record<string, number> } }>(
      await request(app, '/stats'),
    );
    expect(body.data.failureRate).toBe(0);
    expect(body.data.byStatus.queued).toBe(0);
    expect(body.data.tokens).toEqual({ spentTotal: 0, spentLast24h: 0 });
    expect(ADMIN_AGENT_SQL.statsAggregates).toContain("error_code = 'SUPPRESSED'");
  });
});

// ---------------------------------------------------------------------------
// routines
// ---------------------------------------------------------------------------

describe('routines', () => {
  it('lists the session user routines cursor-paginated', async () => {
    seedRoutine({ name: 'alpha' });
    seedRoutine({ name: 'beta', enabled: false });
    seedRoutine({ name: 'gamma' });
    seedRoutine({ name: 'foreign', user_id: 99 });
    const app = buildApp();

    const first = await json<{ data: { name: string }[]; pagination: { hasMore: boolean; nextCursor: string | null } }>(
      await request(app, '/routines?limit=2'),
    );
    expect(first.data.map((routine) => routine.name)).toEqual(['alpha', 'beta']);
    expect(first.pagination.hasMore).toBe(true);
    const second = await json<{ data: { name: string }[] }>(
      await request(app, `/routines?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor as string)}`),
    );
    expect(second.data.map((routine) => routine.name)).toEqual(['gamma']);

    const disabled = await json<{ data: { name: string }[] }>(await request(app, '/routines?enabled=false'));
    expect(disabled.data.map((routine) => routine.name)).toEqual(['beta']);
    expect((await request(app, '/routines?enabled=maybe')).status).toBe(400);
  });

  it('creates a routine through a strict validated body', async () => {
    const app = buildApp();
    const res = await request(app, '/routines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'weekly',
        kind: 'weekly_review',
        cron_expr: '0 9 * * 1',
        enabled: true,
        tier: 'high',
        budget_per_day: 2,
        config: { tone: 'brief' },
      }),
    });
    expect(res.status).toBe(201);
    const body = await json<{ data: { id: string; name: string; enabled: boolean; tier: string; config: unknown } }>(res);
    expect(body.data.name).toBe('weekly');
    expect(body.data.enabled).toBe(true);
    expect(body.data.tier).toBe('high');
    expect(body.data.config).toEqual({ tone: 'brief' });

    // Duplicate (user_id, name) -> 409, no second row.
    const duplicate = await request(app, '/routines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'weekly', kind: 'weekly_review' }),
    });
    expect(duplicate.status).toBe(409);
    expect(state.routines).toHaveLength(1);

    // Unknown key, unknown kind, bad cron and oversized config are all rejected.
    const strict = await request(app, '/routines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', kind: 'weekly_review', sql: 'DROP TABLE users' }),
    });
    expect(strict.status).toBe(400);
    const badKind = await request(app, '/routines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x2', kind: 'laundry' }),
    });
    expect(badKind.status).toBe(400);
    const badCron = await request(app, '/routines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x3', kind: 'weekly_review', cron_expr: 'not a cron' }),
    });
    expect(badCron.status).toBe(400);
    const hugeConfig = await request(app, '/routines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x4', kind: 'weekly_review', config: { blob: 'a'.repeat(MAX_ROUTINE_CONFIG_BYTES + 1) } }),
    });
    expect(hugeConfig.status).toBe(400);
    expect(state.routines).toHaveLength(1);
  });

  it('patches enable/disable, cron, tier, budget and config; enforces strict bodies', async () => {
    const routine = seedRoutine({});
    const app = buildApp();

    const res = await request(app, `/routines/${routine.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, cron_expr: '30 6 * * *', tier: 'lite', budget_per_day: 1, config: { x: 1 } }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ data: { enabled: boolean; cron_expr: string; tier: string; budget_per_day: number; config: unknown } }>(res);
    expect(body.data).toMatchObject({ enabled: false, cron_expr: '30 6 * * *', tier: 'lite', budget_per_day: 1 });
    expect(body.data.config).toEqual({ x: 1 });

    const unknownKey = await request(app, `/routines/${routine.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, rawSql: 'SELECT 1' }),
    });
    expect(unknownKey.status).toBe(400);
    const empty = await request(app, `/routines/${routine.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    const missing = await request(app, `/routines/${uuidFor(404)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);
  });

  it('run-now enqueues exactly one job with the routine kind and config', async () => {
    const routine = seedRoutine({ kind: 'evening_review', config: { timezone: 'Asia/Shanghai' } });
    const app = buildApp();

    const res = await request(app, `/routines/${routine.id}/run-now`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await json<{ data: { job_id: string; created: boolean } }>(res);
    expect(body.data).toEqual({ job_id: 'job-run-now', created: true });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      'evening_review',
      { routine_id: routine.id, config: { timezone: 'Asia/Shanghai' } },
      { userId: USER.id },
    );
  });

  it('run-now does nothing when the routine is disabled', async () => {
    const routine = seedRoutine({ enabled: false });
    const app = buildApp();

    const res = await request(app, `/routines/${routine.id}/run-now`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ success: false, error: 'routine_disabled' });
    expect(enqueueSpy).not.toHaveBeenCalled();

    const missing = await request(app, `/routines/${uuidFor(404)}/run-now`, { method: 'POST' });
    expect(missing.status).toBe(404);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /runs
// ---------------------------------------------------------------------------

describe('GET /runs', () => {
  it('returns the unified history with duration, token cost and the routine link', async () => {
    const routine = seedRoutine({ name: 'weekly' });
    const linked = seedJob({
      kind: 'weekly_review',
      status: 'succeeded',
      payload: { routine_id: routine.id },
      started_at: iso(T0 - 120_000),
      finished_at: iso(T0 - 60_000),
      cost_tokens: 42,
    });
    // A junk payload must NOT explode the ::text join (a ::uuid cast would raise 22P02).
    const junk = seedJob({ status: 'failed', payload: { routine_id: 'not-a-uuid' } });
    const app = buildApp();

    const res = await request(app, '/runs');
    expect(res.status).toBe(200);
    const body = await json<{
      data: { id: string; routine_id: string | null; routine_name: string | null; durationMs: number | null; costTokens: number }[];
      pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
    }>(res);
    expect(body.pagination.limit).toBe(DEFAULT_LIST_LIMIT);
    const byId = new Map(body.data.map((run) => [run.id, run]));
    expect(byId.get(linked.id)?.routine_id).toBe(routine.id);
    expect(byId.get(linked.id)?.routine_name).toBe('weekly');
    expect(byId.get(linked.id)?.durationMs).toBe(60_000);
    expect(byId.get(linked.id)?.costTokens).toBe(42);
    expect(byId.get(junk.id)?.routine_name).toBeNull();

    const filtered = await json<{ data: { id: string }[] }>(await request(app, '/runs?kind=weekly_review'));
    expect(filtered.data.map((run) => run.id)).toEqual([linked.id]);
  });
});

// ---------------------------------------------------------------------------
// No arbitrary-SQL / arbitrary-payload surface
// ---------------------------------------------------------------------------

describe('no arbitrary surface', () => {
  it('never interpolates request values into SQL (only bound parameters)', async () => {
    seedJob({ status: 'queued' });
    const app = buildApp();
    const hostilePayload = "x'; DROP TABLE users; --";
    const res = await request(app, `/jobs?status=queued&limit=1&note=${encodeURIComponent(hostilePayload)}`);
    expect(res.status).toBe(200);
    for (const statement of captured) {
      expect(statement.sql).not.toContain('DROP');
      expect(statement.sql).not.toContain(hostilePayload);
    }
    expect(captured.every((statement) => statement.sql.includes('$'))).toBe(true);
  });

  it('ships transition guards and no raw-SQL statement in the exported SQL surface', () => {
    expect(TRANSITION_SQL.retry).toContain("j.status IN ('failed', 'dead_letter', 'cancelled')");
    expect(TRANSITION_SQL.requeue).toContain("j.status IN ('leased', 'running')");
    expect(TRANSITION_SQL.cancel).toContain("j.status IN ('queued', 'leased', 'running')");
    for (const sql of Object.values(ADMIN_AGENT_SQL)) {
      expect(sql).not.toMatch(/\(\$\{/);
    }
    // The routine link compares as text, never casts the payload to uuid.
    expect(ADMIN_AGENT_SQL.jobById).toContain('FROM agent_jobs WHERE id = $1');
  });
});

// ---------------------------------------------------------------------------
// Index conformance (structural; a tiny-fixture EXPLAIN would be misleading)
// ---------------------------------------------------------------------------

describe('index conformance', () => {
  it('aligns keyset predicates and orders with the shipped indexes', async () => {
    seedJob({ status: 'queued' });
    seedWorker({ id: 'w1' });
    seedRoutine({});
    const app = buildApp();

    await request(app, '/jobs?user_id=7&limit=5');
    const jobsUserSql = lastCaptured().sql;
    expect(jobsUserSql).toContain('j.user_id = $1');
    expect(jobsUserSql).toContain('ORDER BY j.created_at DESC, j.id DESC');
    expect(jobsUserSql).toMatch(/LIMIT \$\d+/);
    expect(jobsUserSql).not.toMatch(/LIMIT \d+/);

    await request(app, '/jobs?status=queued');
    const jobsStatusSql = lastCaptured().sql;
    expect(jobsStatusSql).toContain('j.status = $');

    await request(app, '/jobs?kind=morning_brief&status=queued');
    const jobsKindStatusSql = lastCaptured().sql;
    expect(jobsKindStatusSql).toContain('j.kind = $');
    expect(jobsKindStatusSql).toContain('j.status = $');

    await request(app, `/jobs?cursor=${encodeCursor(iso(T0), uuidFor(1))}`);
    const jobsCursorSql = lastCaptured().sql;
    expect(jobsCursorSql).toContain('(j.created_at, j.id) < ($');
    expect(jobsCursorSql).toContain('::timestamptz');
    expect(jobsCursorSql).toContain('::uuid');

    await request(app, '/routines');
    const routinesSql = lastCaptured().sql;
    expect(routinesSql).toContain('r.user_id = $1');
    expect(routinesSql).toContain('ORDER BY r.name ASC, r.id ASC');

    await request(app, '/workers');
    const workersSql = lastCaptured().sql;
    expect(workersSql).toContain('ORDER BY w.id ASC');
    await request(app, '/workers?cursor=' + encodeCursor('w1', 'w1'));
    expect(lastCaptured().sql).toContain('w.id > $');
    expect(captured.some((statement) => statement.sql.includes('FROM agent_workers w'))).toBe(true);
  });
});
