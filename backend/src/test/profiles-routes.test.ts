import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 69 acceptance, part 1: `/api/profiles` CRUD.
 *
 * - every verb is auth-guarded (401 without a token)
 * - validation: empty name, kind='nonsense', kind='self' -> 400
 * - the self profile (`我`) cannot be deleted and its kind cannot be changed
 * - another user's profile is 404 on every verb (never a leak)
 * - hostile names stay SQL parameters, never interpolated
 *
 * The DB is mocked (no reachable Postgres here); the real schema behaviour
 * (SET NULL on delete, one self profile per user) is proven against PGlite.
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
  relation: string | null;
  kind: string;
  birth_date: string | null;
  lunar_birthday: unknown;
  avatar_emoji: string | null;
  timezone: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

let captured: Array<{ sql: string; params: unknown[] }>;
let profilesTable: ProfileRow[];
let nextId: number;

function profile(overrides: Partial<ProfileRow> & { id: number; user_id: number; name: string; kind: string }): ProfileRow {
  return {
    relation: null,
    birth_date: null,
    lunar_birthday: null,
    avatar_emoji: null,
    timezone: null,
    sort_order: 0,
    is_active: true,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function installDb(): void {
  captured = [];
  nextId = 900;
  profilesTable = [
    profile({ id: SELF_ID, user_id: 1, name: '我', kind: 'self' }),
    profile({ id: FAMILY_ID, user_id: 1, name: '小明', kind: 'family', relation: '儿子' }),
    profile({ id: FOREIGN_ID, user_id: 2, name: '我', kind: 'self' }),
  ];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT * FROM profiles WHERE id = $1 AND user_id = $2')) {
      const row = profilesTable.find((p) => p.id === Number(params[0]) && p.user_id === Number(params[1]));
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT kind FROM profiles WHERE id = $1 AND user_id = $2')) {
      const row = profilesTable.find((p) => p.id === Number(params[0]) && p.user_id === Number(params[1]));
      return row ? { rows: [{ kind: row.kind }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2 AND is_active = TRUE')) {
      const row = profilesTable.find(
        (p) => p.id === Number(params[0]) && p.user_id === Number(params[1]) && p.is_active === true,
      );
      return row ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT * FROM profiles WHERE user_id = $1')) {
      let rows = profilesTable.filter((p) => p.user_id === Number(params[0]));
      if (s.includes('is_active = TRUE')) rows = rows.filter((p) => p.is_active);
      if (s.includes('is_active = FALSE')) rows = rows.filter((p) => !p.is_active);
      rows = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('INSERT INTO profiles')) {
      const row = profile({
        id: nextId++,
        user_id: Number(params[0]),
        name: String(params[1]),
        relation: params[2] == null ? null : String(params[2]),
        kind: String(params[3]),
        birth_date: params[4] == null ? null : String(params[4]),
        lunar_birthday: params[5] == null ? null : JSON.parse(String(params[5])),
        avatar_emoji: params[6] == null ? null : String(params[6]),
        timezone: params[7] == null ? null : String(params[7]),
        sort_order: Number(params[8] ?? 0),
        is_active: params[9] == null ? true : Boolean(params[9]),
      });
      profilesTable.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('UPDATE profiles SET')) {
      const setPart = s.slice('UPDATE profiles SET '.length, s.indexOf(' WHERE '));
      const assignments = setPart.split(', ');
      const id = Number(params[params.length - 2]);
      const userId = Number(params[params.length - 1]);
      const row = profilesTable.find((p) => p.id === id && p.user_id === userId);
      if (!row) return { rows: [], rowCount: 0 };
      for (const assignment of assignments) {
        const m = assignment.match(/^(\w+) = \$(\d+)$/);
        if (!m) continue;
        const [, column, index] = m;
        if (column === 'updated_at') continue;
        (row as unknown as Record<string, unknown>)[column] = params[Number(index) - 1];
      }
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM profiles WHERE id = $1 AND user_id = $2')) {
      const before = profilesTable.length;
      profilesTable = profilesTable.filter(
        (p) => !(p.id === Number(params[0]) && p.user_id === Number(params[1])),
      );
      return { rows: [], rowCount: before - profilesTable.length };
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

describe('/api/profiles CRUD (checkbox 69)', () => {
  it('is auth-guarded on every verb (401 without a token)', async () => {
    authState.user = null;
    for (const [method, path] of [
      ['GET', '/'],
      ['POST', '/'],
      ['GET', '/11'],
      ['PATCH', '/11'],
      ['DELETE', '/11'],
    ] as const) {
      const res = await profilesRoutes.request(`http://localhost${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('GET / lists only the current user profiles ordered by sort_order', async () => {
    const { status, json } = await request('GET', '/');
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    const data = json.data as Array<Record<string, unknown>>;
    expect(data.map((p) => p.id)).toEqual([SELF_ID, FAMILY_ID]);
    expect(data.every((p) => p.user_id === 1)).toBe(true);
    expect(data.some((p) => p.id === FOREIGN_ID)).toBe(false);
  });

  it('POST / creates a family profile (201) and returns the mapped record', async () => {
    const { status, json } = await request('POST', '/', {
      name: '花花',
      kind: 'pet',
      avatarEmoji: '🐱',
      birthDate: '2021-05-01',
      lunarBirthday: { month: 3, day: 20, isLeap: false },
      timezone: 'Asia/Tokyo',
    });
    expect(status).toBe(201);
    const data = json.data as Record<string, unknown>;
    expect(data.name).toBe('花花');
    expect(data.kind).toBe('pet');
    expect(data.timezone).toBe('Asia/Tokyo');
    expect(data.lunar_birthday).toEqual({ month: 3, day: 20, isLeap: false });
  });

  it('POST / rejects an empty name, kind=nonsense and kind=self (400)', async () => {
    expect((await request('POST', '/', { name: '   ' })).status).toBe(400);
    expect((await request('POST', '/', { name: 'x', kind: 'nonsense' })).status).toBe(400);
    expect((await request('POST', '/', { name: 'x', kind: 'self' })).status).toBe(400);
  });

  it('GET /:id returns own profiles and 404s foreign/unknown ids', async () => {
    expect((await request('GET', `/${SELF_ID}`)).json.data).toMatchObject({ id: SELF_ID, kind: 'self' });
    expect((await request('GET', `/${FOREIGN_ID}`)).status).toBe(404);
    expect((await request('GET', '/9999')).status).toBe(404);
    expect((await request('GET', '/abc')).status).toBe(400);
  });

  it('PATCH /:id updates fields and rejects a kind change on the self profile', async () => {
    const updated = await request('PATCH', `/${FAMILY_ID}`, { name: '明明', kind: 'pet' });
    expect(updated.status).toBe(200);
    expect(updated.json.data).toMatchObject({ name: '明明', kind: 'pet' });

    const selfKind = await request('PATCH', `/${SELF_ID}`, { kind: 'family' });
    expect(selfKind.status).toBe(400);
    // Renaming the self profile is allowed.
    const renamed = await request('PATCH', `/${SELF_ID}`, { name: '阿明' });
    expect(renamed.status).toBe(200);
    expect(renamed.json.data).toMatchObject({ name: '阿明', kind: 'self' });

    expect((await request('PATCH', `/${FOREIGN_ID}`, { name: 'hax' })).status).toBe(404);
    expect((await request('PATCH', `/${FAMILY_ID}`, { name: '' })).status).toBe(400);
  });

  it('DELETE /:id deletes family profiles but refuses to delete the self profile', async () => {
    const deleted = await request('DELETE', `/${FAMILY_ID}`);
    expect(deleted.status).toBe(200);
    expect(profilesTable.some((p) => p.id === FAMILY_ID)).toBe(false);

    const selfDelete = await request('DELETE', `/${SELF_ID}`);
    expect(selfDelete.status).toBe(400);
    expect(profilesTable.some((p) => p.id === SELF_ID)).toBe(true);

    expect((await request('DELETE', `/${FOREIGN_ID}`)).status).toBe(404);
    expect((await request('DELETE', '/abc')).status).toBe(400);
  });

  it('keeps hostile names as SQL parameters, never interpolated into the statement', async () => {
    const payload = "Robert'); DROP TABLE profiles;--";
    const res = await request('POST', '/', { name: payload });
    expect(res.status).toBe(201);
    expect((res.json.data as Record<string, unknown>).name).toBe(payload);

    const insert = captured.find((q) => q.sql.includes('INSERT INTO profiles'));
    expect(insert).toBeDefined();
    expect(insert!.sql).not.toContain('DROP TABLE');
    expect(insert!.params).toContain(payload);

    // HTML payload is stored verbatim too (no server-side rendering).
    const html = '<script>alert(1)</script>';
    const created = await request('POST', '/', { name: html });
    expect(created.status).toBe(201);
    expect((created.json.data as Record<string, unknown>).name).toBe(html);
  });
});
