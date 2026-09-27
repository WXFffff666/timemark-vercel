import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 70 acceptance, part 2: `/api/profiles/:id/accounts` routing CRUD.
 *
 * - auth-guarded (401 without a token);
 * - GET returns the profile's explicit account ids (empty = fall back to all);
 * - PUT replaces the set (deduped), empty array clears it;
 * - foreign / unknown / archived profile -> 404 on both verbs;
 * - an account id that is unknown or belongs to another user -> 400 (no leak);
 * - malformed bodies (0 / negative / non-integer accountIds) -> 400.
 *
 * The DB is mocked (no reachable Postgres). The live FK semantics (CASCADE on
 * profile/account delete) are covered by the migration test and PGlite evidence.
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

import profilesRoutes from '../routes/profiles.js';

const USER = { id: 1, username: 'alice' };
const SELF_ID = 11;
const FAMILY_ID = 12;
const FOREIGN_ID = 21;

interface ProfileRow {
  id: number;
  user_id: number;
  name: string;
  kind: string;
  is_active: boolean;
}

let profilesTable: ProfileRow[];
let accountsTable: Array<{ id: number; user_id: number }>;
let routing: Set<string>; // `${profileId}:${accountId}`
let captured: Array<{ sql: string; params: unknown[] }>;

function installDb(): void {
  captured = [];
  routing = new Set();
  profilesTable = [
    { id: SELF_ID, user_id: 1, name: '我', kind: 'self', is_active: true },
    { id: FAMILY_ID, user_id: 1, name: '小明', kind: 'family', is_active: true },
    { id: FOREIGN_ID, user_id: 2, name: '我', kind: 'self', is_active: true },
  ];
  accountsTable = [
    { id: 1, user_id: 1 },
    { id: 2, user_id: 1 },
    { id: 3, user_id: 2 }, // another user's account
  ];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT * FROM profiles WHERE id = $1 AND user_id = $2')) {
      const row = profilesTable.find((p) => p.id === Number(params[0]) && p.user_id === Number(params[1]));
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2 AND is_active = TRUE')) {
      const row = profilesTable.find(
        (p) => p.id === Number(params[0]) && p.user_id === Number(params[1]) && p.is_active,
      );
      return row ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT pca.account_id FROM profile_channel_accounts pca')) {
      const profileId = Number(params[0]);
      const userId = Number(params[1]);
      const owned = profilesTable.some((p) => p.id === profileId && p.user_id === userId);
      if (!owned) return { rows: [], rowCount: 0 };
      const rows = [...routing]
        .map((key) => key.split(':').map(Number))
        .filter(([pid]) => pid === profileId)
        .map(([, accountId]) => ({ account_id: accountId }))
        .sort((a, b) => a.account_id - b.account_id);
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT id FROM notification_accounts WHERE user_id = $1 AND id = ANY')) {
      const userId = Number(params[0]);
      const ids = params[1] as number[];
      const rows = accountsTable
        .filter((a) => a.user_id === userId && ids.includes(a.id))
        .map((a) => ({ id: a.id }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('DELETE FROM profile_channel_accounts WHERE profile_id = $1')) {
      const profileId = Number(params[0]);
      const before = routing.size;
      routing = new Set([...routing].filter((key) => Number(key.split(':')[0]) !== profileId));
      return { rows: [], rowCount: before - routing.size };
    }
    if (s.startsWith('INSERT INTO profile_channel_accounts')) {
      const profileId = Number(params[0]);
      const ids = params[1] as number[];
      for (const accountId of ids) routing.add(`${profileId}:${accountId}`);
      return { rows: [], rowCount: ids.length };
    }
    throw new Error(`unexpected SQL: ${s}`);
  });
}

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await profilesRoutes.request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  installDb();
  authState.user = { ...USER };
});

describe('/api/profiles/:id/accounts routing (checkbox 70)', () => {
  it('is auth-guarded on both verbs (401 without a token)', async () => {
    authState.user = null;
    for (const [method, path] of [
      ['GET', `/${FAMILY_ID}/accounts`],
      ['PUT', `/${FAMILY_ID}/accounts`],
    ] as const) {
      const res = await profilesRoutes.request(`http://localhost${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('GET returns an empty set when the profile has no explicit routing (fall back to all)', async () => {
    const { status, json } = await request('GET', `/${FAMILY_ID}/accounts`);
    expect(status).toBe(200);
    expect(json.data).toEqual({ profile_id: FAMILY_ID, account_ids: [] });
  });

  it('PUT replaces the routing set (deduped) and GET reflects it', async () => {
    const put = await request('PUT', `/${FAMILY_ID}/accounts`, { accountIds: [2, 1, 2] });
    expect(put.status).toBe(200);
    expect(put.json.data).toEqual({ profile_id: FAMILY_ID, account_ids: [1, 2] });

    const get = await request('GET', `/${FAMILY_ID}/accounts`);
    expect(get.json.data).toEqual({ profile_id: FAMILY_ID, account_ids: [1, 2] });

    // A second PUT clears it (empty array = explicit fall back to all).
    const cleared = await request('PUT', `/${FAMILY_ID}/accounts`, { accountIds: [] });
    expect(cleared.status).toBe(200);
    expect((await request('GET', `/${FAMILY_ID}/accounts`)).json.data).toEqual({
      profile_id: FAMILY_ID,
      account_ids: [],
    });
  });

  it('rejects an account that is unknown or belongs to another user (400, no leak)', async () => {
    const foreign = await request('PUT', `/${FAMILY_ID}/accounts`, { accountIds: [3] });
    expect(foreign.status).toBe(400);
    expect(String(foreign.json.error)).toContain('通知账户');

    const unknown = await request('PUT', `/${FAMILY_ID}/accounts`, { accountIds: [999] });
    expect(unknown.status).toBe(400);

    // Rejected writes must not touch the existing routing rows at all.
    expect([...routing]).toEqual([]);
  });

  it('404s a foreign / unknown / archived profile on both verbs', async () => {
    profilesTable.find((p) => p.id === FAMILY_ID)!.is_active = false;
    expect((await request('GET', `/${FAMILY_ID}/accounts`)).status).toBe(404);
    expect((await request('PUT', `/${FAMILY_ID}/accounts`, { accountIds: [1] })).status).toBe(404);
    expect((await request('GET', `/${FOREIGN_ID}/accounts`)).status).toBe(404);
    expect((await request('PUT', `/${FOREIGN_ID}/accounts`, { accountIds: [1] })).status).toBe(404);
    expect((await request('GET', '/9999/accounts')).status).toBe(404);
  });

  it('400s malformed profile ids and malformed bodies', async () => {
    expect((await request('GET', '/abc/accounts')).status).toBe(400);
    expect((await request('PUT', '/abc/accounts', { accountIds: [] })).status).toBe(400);

    for (const body of [
      {},
      { accountIds: 'nope' },
      { accountIds: [0] },
      { accountIds: [-1] },
      { accountIds: [1.5] },
      { accountIds: ['1'] },
    ]) {
      const res = await request('PUT', `/${FAMILY_ID}/accounts`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('keeps account ids as SQL parameters, never interpolated', async () => {
    await request('PUT', `/${FAMILY_ID}/accounts`, { accountIds: [1] });
    const deleteCall = captured.find((q) => q.sql.includes('DELETE FROM profile_channel_accounts'));
    const insertCall = captured.find((q) => q.sql.includes('INSERT INTO profile_channel_accounts'));
    expect(deleteCall!.params).toEqual([FAMILY_ID]);
    expect(insertCall!.params[0]).toBe(FAMILY_ID);
    expect(insertCall!.params[1]).toEqual([1]);
    // The account id is a bound parameter, not string-interpolated into the SQL.
    expect(insertCall!.sql).toContain('$2');
  });
});
