import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 106 acceptance: the DEFAULT trigram search path.
 *
 * - A Chinese query (`苹果`) reaches the database as `ILIKE '%苹果%'` against the v53 GIN
 *   trigram indexes. The executed engine proof that such a pattern picks
 *   `Bitmap Index Scan on idx_events_name_trgm` instead of a seq scan (`EXPLAIN (FORMAT
 *   JSON, ANALYZE)`, 3000-row seed) lives in the out-of-repo PGlite harness
 *   `%TEMP%/opencode/wave13-106-search/probe-explaim.mjs`; a PGlite dependency is
 *   explicitly forbidden in the repo. Here the shipped SQL/DDL pairing is pinned:
 *   `migration-v53.test.ts` asserts every ILIKE column has a matching `gin_trgm_ops`
 *   index, and this file asserts the service emits exactly that indexable shape.
 * - NO outbound request: the fetch spy must never fire on the trigram path, even when
 *   `EMBEDDINGS_ENABLED` happens to be set.
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

import { escapeLikePattern, searchLocal } from '../services/search.service.js';
import searchRoutes from '../routes/search.js';

const APPLE_HIT = {
  owner_type: 'event',
  owner_id: 7,
  title: '苹果手机发布会',
  subtitle: 'custom',
  rank: 0.42,
};

let fetchSpy: ReturnType<typeof vi.fn>;

function installDb(seed: { results?: Array<Record<string, unknown>> } = {}): void {
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('WITH hits AS')) {
      const rows = seed.results ?? [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function searchSqlCall(): [string, unknown[]] {
  // LAST matching call: each searchLocal invocation pushes one 'WITH hits AS' query,
  // and assertions below inspect the parameters of the most recent one.
  const call = [...dbQuery.mock.calls].reverse().find(([sql]) => String(sql).includes('WITH hits AS'));
  if (!call) throw new Error('trigram search SQL was never executed');
  return call as [string, unknown[]];
}

beforeEach(() => {
  authState.user = { id: 1, username: 'admin' };
  installDb();
  delete process.env.EMBEDDINGS_ENABLED;
  fetchSpy = vi.fn(() => Promise.reject(new Error('outbound request attempted')));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EMBEDDINGS_ENABLED;
});

describe('trigram search service (default path)', () => {
  it('Chinese query 苹果 becomes the indexable ILIKE pattern and matches - zero outbound requests', async () => {
    installDb({ results: [APPLE_HIT] });

    const results = await searchLocal(1, '苹果');

    expect(results).toEqual([APPLE_HIT]);
    const [sql, params] = searchSqlCall();
    expect(sql).toContain('ILIKE');
    expect(sql).toContain('similarity(');
    expect(sql).toContain('ORDER BY rank DESC');
    expect(sql).toContain('FROM events');
    expect(sql).toContain('FROM fixed_contacts');
    expect(sql).toContain('FROM interactions');
    expect(sql).toContain('FROM documents');
    expect(sql).toContain('FROM expiry_items');
    expect(params).toEqual([1, '苹果', '%苹果%', 20]);
    // The pattern stays index-usable: `%...%` around the raw query, no leading function call.
    expect(String(params[2])).toMatch(/^%.+%$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the trigram path stays local even when embeddings are enabled', async () => {
    process.env.EMBEDDINGS_ENABLED = 'true';
    installDb({ results: [APPLE_HIT] });

    const results = await searchLocal(1, '苹果');

    expect(results).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(searchSqlCall()[0]).not.toContain('<=>');
  });

  it('escapes LIKE metacharacters so % / _ / \\ search literally', async () => {
    expect(escapeLikePattern('100%_a\\b')).toBe('100\\%\\_a\\\\b');

    installDb({ results: [] });
    await searchLocal(1, '100%_x');
    expect(searchSqlCall()[1][2]).toBe('%100\\%\\_x%');
  });

  it('clamps the limit defensively to 1..50 and short-circuits a blank query without touching the DB', async () => {
    installDb({ results: [] });
    await searchLocal(1, 'x', { limit: 999 });
    expect(searchSqlCall()[1][3]).toBe(50);

    await searchLocal(1, 'x', { limit: 0 });
    expect(searchSqlCall()[1][3]).toBe(1);

    const callsBefore = dbQuery.mock.calls.length;
    expect(await searchLocal(1, '   ')).toEqual([]);
    expect(dbQuery.mock.calls.length).toBe(callsBefore);
  });

  it('rejects a malformed owner_type row instead of leaking an unknown owner', async () => {
    installDb({
      results: [
        { owner_type: 'users', owner_id: 1, title: 'root', subtitle: null, rank: 1 },
        APPLE_HIT,
      ],
    });
    const results = await searchLocal(1, '苹果');
    expect(results.map((hit) => hit.owner_type)).toEqual(['event']);
  });
});

describe('POST /api/search (trigram by default)', () => {
  it('returns trigram-mode hits and never contacts a provider', async () => {
    authState.user = null;
    const unauthorized = await searchRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: '苹果' }),
    });
    expect(unauthorized.status).toBe(401);

    authState.user = { id: 1, username: 'admin' };
    installDb({ results: [APPLE_HIT] });
    const response = await searchRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: '苹果' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { mode: string; query: string; results: Array<{ title: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.mode).toBe('trigram');
    expect(body.data.query).toBe('苹果');
    expect(body.data.results[0]?.title).toBe('苹果手机发布会');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing / blank / oversized query or an out-of-range limit with 400, never running a query', async () => {
    installDb({ results: [APPLE_HIT] });
    const callsBefore = dbQuery.mock.calls.length;

    const missing = await searchRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const blank = await searchRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: '   ' }),
    });
    expect(blank.status).toBe(400);

    const oversized = await searchRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'x'.repeat(201) }),
    });
    expect(oversized.status).toBe(400);

    const badLimit = await searchRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: '苹果', limit: 999 }),
    });
    expect(badLimit.status).toBe(400);

    expect(dbQuery.mock.calls.length).toBe(callsBefore);
  });
});

describe('trigram path hygiene', () => {
  it('the service never selects secrets / attachment bytes and uses no type or console escapes', () => {
    const service = readFileSync(new URL('../services/search.service.ts', import.meta.url), 'utf8');
    expect(service).not.toMatch(/\bFROM\s+attachments\b/i);
    expect(service).not.toMatch(/SELECT[^`]*document_number_encrypted/i);
    expect(service).not.toMatch(/\bas any\b|@ts-ignore/);
    expect(service).not.toMatch(/console\.log/);

    // The document embed source is title + issuer only - the number is never read.
    const documentSelect = /document: \{ table: 'documents', select: '([^']+)'/.exec(service);
    expect(documentSelect?.[1]).toBe('id, user_id, title, issuer');
  });
});
