import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 81 acceptance: /api/goals CRUD + progress + milestones.
 *
 * - every verb is auth-guarded (401 without a token)
 * - every query is user-scoped; another user's goal/milestone is 404 (not 403)
 * - `progress` CLAMPS at 100% while the RAW current_value is stored as sent
 * - completing ALL milestones does NOT auto-close the goal (explicit PATCH status)
 * - deleting a goal cascades its milestones but leaves linked events untouched
 * - `?profileId=` reuses the checkbox-69 contract: omitted = all profiles,
 *   foreign/archived/invalid -> 404, and no profile predicate when omitted
 * - malformed input: target_value=0, negative current_value, unknown status,
 *   target_date before start_date, another user's goal, foreign event link
 * - prompt injection: an SQL/HTML goal title is stored as a bound parameter,
 *   never interpolated into the SQL text
 *
 * The DB layer is mocked with an in-memory fake that emulates the FKs
 * (goal delete cascades milestones; events are untouched). The real SQL runs
 * against a live PGlite engine in `.omo/evidence/task-81-*`.
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
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

import goalsRoutes from '../routes/goals.js';

const USER = { id: 7, username: 'alice' };
const OTHER_USER = { id: 99, username: 'bob' };

interface Captured {
  sql: string;
  params: unknown[];
}

type Row = Record<string, unknown>;

let captured: Captured[];
let goals: Row[];
let milestones: Row[];
let events: Row[];
let profiles: Row[];
let nextGoalId: number;
let nextMilestoneId: number;

const NOW_ISO = '2026-06-01T00:00:00.000Z';

function installDb(): void {
  captured = [];
  nextGoalId = 1;
  nextMilestoneId = 1;
  goals = [];
  milestones = [];
  events = [
    { id: 501, user_id: USER.id, name: '考试', date: '2026-06-20', type: 'exam' },
    { id: 502, user_id: OTHER_USER.id, name: '别人的事', date: '2026-06-20', type: 'other' },
  ];
  profiles = [
    { id: 11, user_id: USER.id, kind: 'self', name: '我', is_active: true },
    { id: 12, user_id: USER.id, kind: 'family', name: '小明', is_active: true },
    { id: 13, user_id: USER.id, kind: 'family', name: '归档', is_active: false },
    { id: 21, user_id: OTHER_USER.id, kind: 'self', name: '我', is_active: true },
  ];

  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    return respond(sql.replace(/\s+/g, ' ').trim(), params);
  });
}

function respond(s: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
  // --- profiles probes (checkbox 69 filter + create validation) ---
  if (s.startsWith('SELECT 1 FROM profiles')) {
    const [id, userId] = params as number[];
    const found = profiles.some((p) => p.id === id && p.user_id === userId && p.is_active === true);
    return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
  }

  // --- events ownership probe ---
  if (s.startsWith('SELECT 1 FROM events WHERE id = $1 AND user_id = $2')) {
    const [id, userId] = params as number[];
    const found = events.some((e) => e.id === id && e.user_id === userId);
    return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
  }

  // --- goals ---
  if (s.startsWith('SELECT * FROM goals WHERE user_id = $1')) {
    let rows = goals.filter((g) => g.user_id === params[0]);
    let pi = 1;
    if (s.includes('status = $')) {
      rows = rows.filter((g) => g.status === params[pi]);
      pi += 1;
    }
    if (s.includes('profile_id = $')) {
      rows = rows.filter((g) => g.profile_id === params[pi]);
    }
    rows = [...rows].sort(
      (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.id) - Number(b.id),
    );
    return { rows, rowCount: rows.length };
  }
  if (s.startsWith('SELECT * FROM goals WHERE id = $1 AND user_id = $2')) {
    const [id, userId] = params as number[];
    const row = goals.find((g) => g.id === id && g.user_id === userId);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (s.startsWith('SELECT id FROM goals WHERE id = $1 AND user_id = $2')) {
    const [id, userId] = params as number[];
    const row = goals.find((g) => g.id === id && g.user_id === userId);
    return { rows: row ? [{ id }] : [], rowCount: row ? 1 : 0 };
  }
  if (s.startsWith('INSERT INTO goals')) {
    const [userId, profileId, title, description, category, targetValue, currentValue, unit, startDate, targetDate, status] =
      params as unknown[];
    const row: Row = {
      id: nextGoalId++,
      user_id: userId,
      profile_id: profileId,
      title,
      description,
      category,
      target_value: targetValue,
      current_value: currentValue ?? 0,
      unit,
      start_date: startDate ?? '2026-06-01',
      target_date: targetDate,
      status: status ?? 'active',
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    };
    goals.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (s.startsWith('UPDATE goals SET')) {
    const values = params as unknown[];
    const userId = values[values.length - 1];
    const id = values[values.length - 2];
    const row = goals.find((g) => g.id === id && g.user_id === userId);
    if (!row) return { rows: [], rowCount: 0 };
    const assignments = s.slice(s.indexOf('SET ') + 4, s.indexOf(' WHERE ')).split(', ');
    let valueIndex = 0;
    for (const assignment of assignments) {
      if (assignment.includes('CURRENT_TIMESTAMP')) {
        row.updated_at = new Date().toISOString();
        continue;
      }
      const match = /^(\w+) = \$(\d+)$/.exec(assignment);
      if (!match) continue;
      row[match[1]] = values[valueIndex];
      valueIndex += 1;
    }
    return { rows: [{ id }], rowCount: 1 };
  }
  if (s.startsWith('DELETE FROM goals')) {
    const [id, userId] = params as number[];
    const index = goals.findIndex((g) => g.id === id && g.user_id === userId);
    if (index === -1) return { rows: [], rowCount: 0 };
    goals.splice(index, 1);
    // FK emulation: milestones.goal_id ON DELETE CASCADE; events are NOT touched.
    milestones = milestones.filter((m) => m.goal_id !== id);
    return { rows: [{ id }], rowCount: 1 };
  }

  // --- milestones ---
  if (s.startsWith('SELECT * FROM milestones WHERE goal_id = ANY($1::int[])')) {
    const ids = params[0] as number[];
    const rows = milestones
      .filter((m) => ids.includes(Number(m.goal_id)))
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id));
    return { rows, rowCount: rows.length };
  }
  if (s.startsWith('SELECT * FROM milestones WHERE goal_id = $1')) {
    const rows = milestones
      .filter((m) => m.goal_id === params[0])
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id));
    return { rows, rowCount: rows.length };
  }
  if (s.startsWith('SELECT * FROM milestones WHERE id = $1 AND goal_id = $2')) {
    const [id, goalId] = params as number[];
    const row = milestones.find((m) => m.id === id && m.goal_id === goalId);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (s.startsWith('INSERT INTO milestones')) {
    const [goalId, title, dueAt, sortOrder, eventId] = params as unknown[];
    const row: Row = {
      id: nextMilestoneId++,
      goal_id: goalId,
      title,
      due_at: dueAt,
      done_at: null,
      sort_order: sortOrder ?? 0,
      event_id: eventId,
    };
    milestones.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (s.startsWith('UPDATE milestones SET')) {
    const values = params as unknown[];
    const goalId = values[values.length - 1];
    const id = values[values.length - 2];
    const row = milestones.find((m) => m.id === id && m.goal_id === goalId);
    if (!row) return { rows: [], rowCount: 0 };
    const assignments = s.slice(s.indexOf('SET ') + 4, s.indexOf(' WHERE ')).split(', ');
    let valueIndex = 0;
    for (const assignment of assignments) {
      const match = /^(\w+) = \$(\d+)$/.exec(assignment);
      if (!match) continue;
      row[match[1]] = values[valueIndex];
      valueIndex += 1;
    }
    return { rows: [row], rowCount: 1 };
  }
  if (s.startsWith('DELETE FROM milestones')) {
    const [id, goalId] = params as number[];
    const index = milestones.findIndex((m) => m.id === id && m.goal_id === goalId);
    if (index === -1) return { rows: [], rowCount: 0 };
    milestones.splice(index, 1);
    return { rows: [{ id }], rowCount: 1 };
  }

  // --- events (only if some implementation mistakenly writes here) ---
  if (s.startsWith('DELETE FROM events')) {
    const [id, userId] = params as number[];
    const index = events.findIndex(
      (e) => e.id === id && (userId === undefined || e.user_id === userId),
    );
    if (index === -1) return { rows: [], rowCount: 0 };
    events.splice(index, 1);
    return { rows: [{ id }], rowCount: 1 };
  }

  // Fail closed: an unrecognised query is a bug in the fake (or a mutant that
  // changed the SQL shape) - never silently return empty rows.
  throw new Error(`goals test fake: unexpected query: ${s}`);
}

async function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await goalsRoutes.request(path, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

function data(body: Record<string, unknown>): Record<string, unknown> {
  return (body.data ?? {}) as Record<string, unknown>;
}

function queriesMatching(pattern: RegExp): Captured[] {
  return captured.filter((q) => pattern.test(q.sql.replace(/\s+/g, ' ')));
}

function writesToEvents(): Captured[] {
  return captured.filter((q) =>
    /^(?:INSERT INTO|UPDATE|DELETE FROM)\s+events\b/i.test(q.sql.replace(/\s+/g, ' ').trim()),
  );
}

beforeEach(() => {
  authState.user = { ...USER };
  installDb();
});

describe('GET/POST /api/goals — auth guard and CRUD', () => {
  it('returns 401 for every goals verb without a token', async () => {
    authState.user = null;
    const cases: Array<[string, string]> = [
      ['GET', '/'],
      ['POST', '/'],
      ['GET', '/1'],
      ['PATCH', '/1'],
      ['DELETE', '/1'],
      ['POST', '/1/progress'],
      ['POST', '/1/milestones'],
      ['PATCH', '/1/milestones/2'],
      ['POST', '/1/milestones/2/toggle'],
      ['DELETE', '/1/milestones/2'],
    ];
    for (const [method, path] of cases) {
      const { status, body } = await request(method, path, method === 'GET' ? undefined : {});
      expect(status, `${method} ${path}`).toBe(401);
      expect(body.error).toBe('Unauthorized');
    }
    // Nothing reached the DB before auth.
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('creates a goal (201), binds every column as a parameter and validates profile ownership', async () => {
    const { status, body } = await request('POST', '/', {
      title: '读完 12 本书',
      description: '每月一本',
      category: 'reading',
      targetValue: 12,
      unit: '本',
      startDate: '2026-01-01',
      targetDate: '2026-12-31',
      profileId: 11,
    });

    expect(status).toBe(201);
    const goal = data(body);
    expect(goal.title).toBe('读完 12 本书');
    expect(goal.target_value).toBe(12);
    expect(goal.current_value).toBe(0);
    expect(goal.progress).toBe(0);
    expect(goal.status).toBe('active');
    expect(goal.profile_id).toBe(11);
    expect(goal.milestone_count).toBe(0);
    expect(goal.milestones).toEqual([]);

    const insert = queriesMatching(/^INSERT INTO goals/)[0];
    expect(insert).toBeDefined();
    expect(insert.params).toEqual([
      USER.id,
      11,
      '读完 12 本书',
      '每月一本',
      'reading',
      12,
      null,
      '本',
      '2026-01-01',
      '2026-12-31',
      null,
    ]);
    // Ownership probe is user-scoped.
    const probe = queriesMatching(/^SELECT 1 FROM profiles/)[0];
    expect(probe.params).toEqual([11, USER.id]);

    // A foreign or archived profile is a 404, not a leak.
    expect((await request('POST', '/', { title: 'x', profileId: 21 })).status).toBe(404);
    expect((await request('POST', '/', { title: 'x', profileId: 13 })).status).toBe(404);
    expect((await request('POST', '/', { title: 'x', profileId: 999 })).status).toBe(404);
  });

  it('lists only the user goals; ?profileId= filters with the checkbox-69 contract', async () => {
    await request('POST', '/', { title: 'self goal', profileId: 11, targetValue: 10 });
    await request('POST', '/', { title: 'family goal', profileId: 12 });
    goals.push({
      id: 777,
      user_id: OTHER_USER.id,
      profile_id: 21,
      title: 'foreign',
      description: null,
      category: null,
      target_value: 1,
      current_value: 0,
      unit: null,
      start_date: '2026-01-01',
      target_date: null,
      status: 'active',
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    });

    captured = [];
    const all = await request('GET', '/');
    expect(all.status).toBe(200);
    expect((all.body.data as unknown[]).length).toBe(2);
    // REGRESSION (checkbox 69): omitting profileId emits NO profile predicate/probe.
    expect(queriesMatching(/FROM profiles/)).toHaveLength(0);
    const listSql = queriesMatching(/^SELECT \* FROM goals WHERE user_id/)[0]?.sql.replace(/\s+/g, ' ');
    expect(listSql).not.toContain('profile_id =');

    const self = await request('GET', '/?profileId=11');
    expect(self.status).toBe(200);
    const selfRows = self.body.data as Row[];
    expect(selfRows.length).toBe(1);
    expect(selfRows[0].profile_id).toBe(11);

    // Foreign / archived / malformed profiles are all 404 (existence not leaked).
    for (const profileId of ['21', '13', 'abc', '-1', '0']) {
      const res = await request('GET', `/?profileId=${profileId}`);
      expect(res.status, `profileId=${profileId}`).toBe(404);
    }

    // Unknown status is a 400.
    expect((await request('GET', '/?status=weird')).status).toBe(400);
  });

  it('GET /:id returns the milestone checklist; another user goal is 404', async () => {
    await request('POST', '/', { title: 'g', targetValue: 4 });
    await request('POST', '/1/milestones', { title: 'one', sortOrder: 2 });
    await request('POST', '/1/milestones', { title: 'two', sortOrder: 1 });

    captured = [];
    const { status, body } = await request('GET', '/1');
    expect(status).toBe(200);
    const goal = data(body);
    expect(goal.milestone_count).toBe(2);
    expect(goal.milestone_done_count).toBe(0);
    expect((goal.milestones as Row[]).map((m) => m.title)).toEqual(['two', 'one']);

    // Foreign user's goal / non-existent / malformed id.
    goals.push({ id: 900, user_id: OTHER_USER.id, title: 'foreign', status: 'active', created_at: NOW_ISO });
    expect((await request('GET', '/900')).status).toBe(404);
    expect((await request('GET', '/123456')).status).toBe(404);
    expect((await request('GET', '/abc')).status).toBe(400);
  });

  it('PATCH updates fields, enforces target_date >= stored start_date, and is 404-scoped', async () => {
    await request('POST', '/', { title: 'g', startDate: '2026-01-01' });

    // target_date alone (before stored start_date) must be rejected with 400.
    const bad = await request('PATCH', '/1', { targetDate: '2025-12-31' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('target_date 不能早于 start_date');
    expect(queriesMatching(/^UPDATE goals/)).toHaveLength(0);

    const ok = await request('PATCH', '/1', { targetDate: '2026-06-30', category: 'health' });
    expect(ok.status).toBe(200);
    expect(data(ok.body).target_date).toBe('2026-06-30');
    expect(data(ok.body).category).toBe('health');

    // Explicit close (the only auto-close-free path): PATCH status.
    const closed = await request('PATCH', '/1', { status: 'done' });
    expect(closed.status).toBe(200);
    expect(data(closed.body).status).toBe('done');

    goals.push({ id: 901, user_id: OTHER_USER.id, title: 'foreign', status: 'active', created_at: NOW_ISO });
    expect((await request('PATCH', '/901', { title: 'hax' })).status).toBe(404);
  });
});

describe('POST /api/goals/:id/progress — clamp the percentage, store the raw value', () => {
  it('stores current_value raw (150/100) while progress clamps at 100', async () => {
    await request('POST', '/', { title: '读书', targetValue: 100, unit: '页' });

    const { status, body } = await request('POST', '/1/progress', { currentValue: 150 });
    expect(status).toBe(200);
    expect(data(body).current_value).toBe(150);
    expect(data(body).progress).toBe(100);

    // The raw value is what actually persists.
    const stored = goals.find((g) => g.id === 1);
    expect(stored?.current_value).toBe(150);
    const update = queriesMatching(/^UPDATE goals SET current_value/)[0];
    expect(update.params[0]).toBe(150);

    // A partial value keeps its exact percentage.
    const partial = await request('POST', '/1/progress', { currentValue: 40 });
    expect(data(partial.body).progress).toBe(40);
    expect(data(partial.body).current_value).toBe(40);

    // Re-read through GET: same derived contract.
    const reread = await request('GET', '/1');
    expect(data(reread.body).current_value).toBe(40);
    expect(data(reread.body).progress).toBe(40);

    // Another user's goal is 404.
    goals.push({ id: 902, user_id: OTHER_USER.id, title: 'foreign', status: 'active', created_at: NOW_ISO });
    expect((await request('POST', '/902/progress', { currentValue: 1 })).status).toBe(404);
  });

  it('reports progress=null for a goal without a target_value but still stores raw value', async () => {
    await request('POST', '/', { title: '里程碑型目标' });
    const { status, body } = await request('POST', '/1/progress', { currentValue: 5 });
    expect(status).toBe(200);
    expect(data(body).progress).toBeNull();
    expect(data(body).current_value).toBe(5);
  });
});

describe('milestone toggle and goal close semantics', () => {
  it('completing ALL milestones does NOT auto-close the goal; an explicit action is required', async () => {
    await request('POST', '/', { title: 'g', targetValue: 2 });
    await request('POST', '/1/milestones', { title: 'm1' });
    await request('POST', '/1/milestones', { title: 'm2' });

    captured = [];
    const t1 = await request('POST', '/1/milestones/1/toggle', {});
    expect(t1.status).toBe(200);
    expect(data(t1.body).done_at).not.toBeNull();
    const t2 = await request('PATCH', '/1/milestones/2', { done: true });
    expect(t2.status).toBe(200);
    expect(data(t2.body).done_at).not.toBeNull();

    // The toggles must not have issued ANY goals write.
    expect(queriesMatching(/^UPDATE goals/)).toHaveLength(0);
    expect(queriesMatching(/^INSERT INTO goals/)).toHaveLength(0);

    const after = await request('GET', '/1');
    expect(data(after.body).status).toBe('active');
    expect(data(after.body).milestone_done_count).toBe(2);
    expect(data(after.body).milestone_count).toBe(2);
    expect(data(after.body).current_value).toBe(0);

    // Only the explicit action closes it.
    const closed = await request('PATCH', '/1', { status: 'done' });
    expect(data(closed.body).status).toBe('done');
  });

  it('toggle flips state, explicit done is idempotent (done_at preserved)', async () => {
    await request('POST', '/', { title: 'g' });
    await request('POST', '/1/milestones', { title: 'm1' });

    const on = await request('POST', '/1/milestones/1/toggle', {});
    expect(data(on.body).done_at).not.toBeNull();
    const firstDoneAt = data(on.body).done_at;

    // Explicit done again keeps the FIRST completion time.
    const again = await request('POST', '/1/milestones/1/toggle', { done: true });
    expect(data(again.body).done_at).toBe(firstDoneAt);

    // Flip off.
    const off = await request('POST', '/1/milestones/1/toggle', {});
    expect(data(off.body).done_at).toBeNull();

    // PATCH done:false is a no-op-but-explicit; PATCH done:true sets it.
    const patchOff = await request('PATCH', '/1/milestones/1', { done: false });
    expect(data(patchOff.body).done_at).toBeNull();
    const patchOn = await request('PATCH', '/1/milestones/1', { done: true, title: 'm1 renamed' });
    expect(data(patchOn.body).done_at).not.toBeNull();
    expect(data(patchOn.body).title).toBe('m1 renamed');

    // Another user's goal -> 404 on every milestone verb.
    expect((await request('PATCH', '/99/milestones/1', { done: true })).status).toBe(404);
    expect((await request('POST', '/99/milestones/1/toggle', {})).status).toBe(404);
    expect((await request('DELETE', '/99/milestones/1')).status).toBe(404);
    expect((await request('POST', '/99/milestones', { title: 'x' })).status).toBe(404);
  });
});

describe('milestone <-> event link (rides the existing reminder engine)', () => {
  it('links a milestone to an owned event and rejects foreign/unknown events', async () => {
    await request('POST', '/', { title: '备考' });

    const linked = await request('POST', '/1/milestones', { title: '通过考试', eventId: 501 });
    expect(linked.status).toBe(201);
    expect(data(linked.body).event_id).toBe(501);

    const probe = queriesMatching(/^SELECT 1 FROM events/)[0];
    expect(probe.params).toEqual([501, USER.id]);

    expect((await request('POST', '/1/milestones', { title: 'x', eventId: 502 })).status).toBe(404);
    expect((await request('POST', '/1/milestones', { title: 'x', eventId: 999 })).status).toBe(404);
    expect((await request('PATCH', '/1/milestones/1', { eventId: 502 })).status).toBe(404);

    // The link round-trips through GET (the reminder engine reads the event row).
    const reread = await request('GET', '/1');
    expect(((data(reread.body).milestones as Row[])[0]).event_id).toBe(501);

    // The event itself must still exist untouched.
    expect(events.some((e) => e.id === 501 && e.user_id === USER.id)).toBe(true);
    expect(writesToEvents()).toHaveLength(0);
  });

  it('deleting a goal cascades its milestones but leaves the linked event untouched', async () => {
    await request('POST', '/', { title: '备考' });
    await request('POST', '/1/milestones', { title: 'm1', eventId: 501 });
    await request('POST', '/1/milestones', { title: 'm2' });
    expect(milestones).toHaveLength(2);

    captured = [];
    const deleted = await request('DELETE', '/1');
    expect(deleted.status).toBe(200);

    // Cascade: the checklist rows are gone in the fake DB (FK emulation).
    expect(goals).toHaveLength(0);
    expect(milestones).toHaveLength(0);
    // Event survival: the event row still exists, unmodified.
    expect(events.some((e) => e.id === 501)).toBe(true);
    expect(writesToEvents()).toHaveLength(0);
    // The delete only ever targeted the goals table.
    const deletes = queriesMatching(/^DELETE FROM/);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toContain('DELETE FROM goals');
    expect(deletes[0].params).toEqual([1, USER.id]);

    // Deleting a foreign user's goal is 404 and touches nothing.
    goals.push({ id: 903, user_id: OTHER_USER.id, title: 'foreign', status: 'active', created_at: NOW_ISO });
    expect((await request('DELETE', '/903')).status).toBe(404);
  });
});

describe('malformed input and injection safety', () => {
  it('rejects target_value=0, negative current_value, unknown status and inverted dates', async () => {
    const zeroTarget = await request('POST', '/', { title: 'x', targetValue: 0 });
    expect(zeroTarget.status).toBe(400);

    const negative = await request('POST', '/', { title: 'x', currentValue: -1 });
    expect(negative.status).toBe(400);

    const status = await request('POST', '/', { title: 'x', status: 'weird' });
    expect(status.status).toBe(400);

    const inverted = await request('POST', '/', { title: 'x', startDate: '2026-06-01', targetDate: '2026-05-01' });
    expect(inverted.status).toBe(400);
    expect(String(inverted.body.error)).toContain('target_date 不能早于 start_date');

    await request('POST', '/', { title: 'ok' });
    expect((await request('PATCH', '/1', { status: 'weird' })).status).toBe(400);
    expect((await request('POST', '/1/progress', { currentValue: -5 })).status).toBe(400);
    expect((await request('POST', '/1/progress', { currentValue: 0 })).status).toBe(200);
  });

  it('binds an SQL/HTML goal title as a parameter instead of interpolating it', async () => {
    const payload = "'; DROP TABLE goals;--<script>alert(1)</script>";
    const { status, body } = await request('POST', '/', { title: payload });
    expect(status).toBe(201);
    expect(data(body).title).toBe(payload);

    const insert = queriesMatching(/^INSERT INTO goals/)[0];
    // The payload is a bound value...
    expect(insert.params[2]).toBe(payload);
    // ...and never lands in the SQL text itself.
    expect(insert.sql).not.toContain('DROP TABLE');
    expect(insert.sql).not.toContain('<script>');

    // The table is intact and the title round-trips verbatim.
    const reread = await request('GET', '/1');
    expect(data(reread.body).title).toBe(payload);
    expect(goals).toHaveLength(1);
  });
});
