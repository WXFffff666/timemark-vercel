import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

/**
 * Checkbox 89 - ICS feed management contract (`/api/calendar/ics-feeds`).
 *
 * - the list response never contains the token or its hash
 * - create stores ONLY the SHA-256 hash of the token; the raw token is returned
 *   exactly once in the creation response
 * - malformed filters are rejected before any INSERT
 * - revoke is a user-scoped soft delete (`revoked_at IS NULL` guard)
 */

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  authState: { user: { id: 7, username: 'admin' } as { id: number; username: string } | null },
  feeds: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ sql: string; params: unknown[] }>,
}));

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

vi.mock('../db/index.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    mocks.calls.push({ sql: norm(sql), params });
    const s = norm(sql);

    if (s.startsWith('INSERT INTO ics_feeds')) {
      const row = {
        id: mocks.feeds.length + 1,
        user_id: params[0],
        name: params[1],
        filter: JSON.parse(String(params[2])),
        token_hash: params[3],
        created_at: '2026-09-28T00:00:00.000Z',
        last_access_at: null,
        revoked_at: null,
      };
      mocks.feeds.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('UPDATE ics_feeds SET revoked_at')) {
      if (!s.includes('user_id = $2 AND revoked_at IS NULL')) return { rows: [], rowCount: 0 };
      const row = mocks.feeds.find((f) => f.id === params[0] && f.user_id === params[1] && f.revoked_at == null);
      if (row) row.revoked_at = '2026-09-28T00:00:00.000Z';
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.includes('FROM ics_feeds')) {
      const rows = mocks.feeds.filter((f) => f.user_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }),
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  return {
    authMiddleware: async (
      c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => Response },
      next: () => Promise<void>,
    ) => {
      if (mocks.authState.user) {
        c.set('user', mocks.authState.user);
        return next();
      }
      return actual.authMiddleware(c as never, next as never);
    },
  };
});

import calendarRoutes from '../routes/calendar.js';

const TOKEN_HASH_1 = createHash('sha256').update('tok-one').digest('hex');
const TOKEN_HASH_2 = createHash('sha256').update('tok-two').digest('hex');

beforeEach(() => {
  mocks.authState.user = { id: 7, username: 'admin' };
  mocks.feeds.length = 0;
  mocks.calls.length = 0;
  mocks.dbQuery.mockClear();
});

describe('GET/POST/DELETE /api/calendar/ics-feeds', () => {
  it('requires authentication for list, create and revoke', async () => {
    mocks.authState.user = null;

    expect((await calendarRoutes.request('/ics-feeds')).status).toBe(401);
    expect(
      (
        await calendarRoutes.request('/ics-feeds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter: { type: 'category', value: 'birthday' } }),
        })
      ).status,
    ).toBe(401);
    expect((await calendarRoutes.request('/ics-feeds/1', { method: 'DELETE' })).status).toBe(401);
    expect(mocks.calls.filter((c) => c.sql.includes('ics_feeds'))).toHaveLength(0);
  });

  it('lists feeds without ever exposing the token or its hash', async () => {
    mocks.feeds.push(
      {
        id: 1,
        user_id: 7,
        name: '生日日历',
        filter: { type: 'category', value: 'birthday' },
        token_hash: TOKEN_HASH_1,
        created_at: '2026-09-01T00:00:00.000Z',
        last_access_at: '2026-09-20T00:00:00.000Z',
        revoked_at: null,
      },
      {
        id: 2,
        user_id: 7,
        name: '妈妈',
        filter: { type: 'contact', value: '妈妈' },
        token_hash: TOKEN_HASH_2,
        created_at: '2026-09-02T00:00:00.000Z',
        last_access_at: null,
        revoked_at: '2026-09-10T00:00:00.000Z',
      },
    );
    mocks.feeds.push({
      id: 3,
      user_id: 8,
      name: '别人的',
      filter: { type: 'category', value: 'birthday' },
      token_hash: 'other',
      revoked_at: null,
    });

    const res = await calendarRoutes.request('/ics-feeds');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { feeds: Array<Record<string, unknown>> } };
    expect(json.success).toBe(true);
    expect(json.data.feeds).toHaveLength(2);
    expect(json.data.feeds[0].filter).toEqual({ type: 'category', value: 'birthday' });
    expect(json.data.feeds[1].revokedAt).toBe('2026-09-10T00:00:00.000Z');

    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(TOKEN_HASH_1);
    expect(serialized).not.toContain(TOKEN_HASH_2);
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toMatch(/"token"/);
  });

  it('creates a feed and stores only the SHA-256 hash of the returned token', async () => {
    const filter = { type: 'category', value: 'birthday' };
    const res = await calendarRoutes.request('/ics-feeds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '生日订阅', filter }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      success: boolean;
      data: { id: number; name: string; filter: unknown; url: string; webcalUrl: string };
    };
    expect(json.success).toBe(true);
    expect(json.data.name).toBe('生日订阅');
    expect(json.data.filter).toEqual(filter);

    const match = json.data.url.match(/\/api\/public\/ics\/([A-Za-z0-9_-]+)\.ics$/);
    expect(match).not.toBeNull();
    const rawToken = match![1];
    expect(json.data.webcalUrl.startsWith('webcal://')).toBe(true);

    const insert = mocks.calls.find((c) => c.sql.startsWith('INSERT INTO ics_feeds'));
    expect(insert).toBeDefined();
    const storedHash = String(insert!.params[3]);
    expect(storedHash).toBe(createHash('sha256').update(rawToken).digest('hex'));
    expect(storedHash).not.toBe(rawToken);
    // The raw token never appears anywhere in the persisted parameters.
    expect(JSON.stringify(insert!.params)).not.toContain(rawToken);
    expect(String(insert!.params[2])).toBe(JSON.stringify(filter));
  });

  it('defaults the feed name from the filter when omitted', async () => {
    const res = await calendarRoutes.request('/ics-feeds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { type: 'contact', value: '妈妈' } }),
    });

    expect(res.status).toBe(201);
    const insert = mocks.calls.find((c) => c.sql.startsWith('INSERT INTO ics_feeds'));
    expect(insert!.params[1]).toBe('联系人 妈妈');
  });

  it('rejects malformed filters with 400 and never inserts', async () => {
    const badFilters: unknown[] = [
      undefined,
      {},
      { type: 'nope', value: 'x' },
      { type: 'profile', value: 'abc' },
      { type: 'profile', value: 0 },
      { type: 'category', value: '' },
      { type: 'category', value: 'x'.repeat(129) },
      { type: 'contact', value: 42 },
      ['category', 'birthday'],
    ];

    for (const filter of badFilters) {
      const res = await calendarRoutes.request('/ics-feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter }),
      });
      expect(res.status).toBe(400);
    }
    expect(mocks.calls.filter((c) => c.sql.startsWith('INSERT INTO ics_feeds'))).toHaveLength(0);
  });

  it('revokes a feed with a user-scoped soft delete and reports unknown ids as 404', async () => {
    mocks.feeds.push({
      id: 5,
      user_id: 7,
      name: '待撤销',
      filter: { type: 'category', value: 'birthday' },
      token_hash: TOKEN_HASH_1,
      created_at: '2026-09-01T00:00:00.000Z',
      last_access_at: null,
      revoked_at: null,
    });

    const res = await calendarRoutes.request('/ics-feeds/5', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const update = mocks.calls.find((c) => c.sql.startsWith('UPDATE ics_feeds SET revoked_at'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('user_id = $2 AND revoked_at IS NULL');
    expect(update!.params).toEqual([5, 7]);
    expect(mocks.feeds[0].revoked_at).not.toBeNull();

    const again = await calendarRoutes.request('/ics-feeds/5', { method: 'DELETE' });
    expect(again.status).toBe(404);

    const unknown = await calendarRoutes.request('/ics-feeds/999', { method: 'DELETE' });
    expect(unknown.status).toBe(404);

    const invalid = await calendarRoutes.request('/ics-feeds/abc', { method: 'DELETE' });
    expect(invalid.status).toBe(400);
  });
});
