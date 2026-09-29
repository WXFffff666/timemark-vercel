import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 132 acceptance: `GET /api/search?q=&types=&limit=`.
 *
 * The DB is a small stateful fake that mirrors the exact semantics the shipped SQL relies on -
 * `ILIKE '%q%'` membership and `ORDER BY rank DESC, owner_id ASC` for the page, `GROUP BY
 * owner_type` for the facets - so the real service + route code runs end-to-end. NO outbound
 * request is ever made on this path (the fetch spy must never fire, even with
 * `EMBEDDINGS_ENABLED` set), and neither query constant mentions a URL.
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

import {
  SEARCH_RESULT_TYPES,
  searchGlobal,
  TRIGRAM_FACET_SQL,
  TRIGRAM_SEARCH_TYPED_SQL,
} from '../services/search.service.js';
import searchRoutes from '../routes/search.js';

interface FixtureRow {
  owner_type: string;
  owner_id: number;
  title: string;
  subtitle: string | null;
  rank: number;
}

/** One row per entity type, ranks descending in the order listed (the expected page order). */
const ALL_TYPES_FIXTURE: FixtureRow[] = SEARCH_RESULT_TYPES.map((owner_type, index) => ({
  owner_type,
  owner_id: index + 1,
  title: `苹果 ${owner_type}`,
  subtitle: owner_type,
  rank: 0.9 - index * 0.05,
}));

let fixture: FixtureRow[] = [];
let fetchSpy: ReturnType<typeof vi.fn>;

function installDb(): void {
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = String(sql);
    if (s.includes('COUNT(*)::int AS count')) {
      const types = (params[3] as string[]) ?? [];
      const counts = new Map<string, number>();
      for (const row of fixture) {
        if (!types.includes(row.owner_type)) continue;
        counts.set(row.owner_type, (counts.get(row.owner_type) ?? 0) + 1);
      }
      const rows = [...counts.entries()].map(([owner_type, count]) => ({ owner_type, count }));
      return { rows, rowCount: rows.length };
    }
    if (s.includes('ORDER BY rank DESC')) {
      const limit = Number(params[3]);
      const types = (params[4] as string[]) ?? [];
      const rows = fixture
        .filter((row) => types.includes(row.owner_type))
        .sort((a, b) => b.rank - a.rank || a.owner_id - b.owner_id)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function hitsCall(): [string, unknown[]] {
  const call = [...dbQuery.mock.calls]
    .reverse()
    .find(([sql]) => String(sql).includes('ORDER BY rank DESC') && !String(sql).includes('COUNT(*)'));
  if (!call) throw new Error('typed trigram search SQL was never executed');
  return call as [string, unknown[]];
}

function facetCall(): [string, unknown[]] {
  const call = [...dbQuery.mock.calls].reverse().find(([sql]) => String(sql).includes('COUNT(*)::int AS count'));
  if (!call) throw new Error('facet SQL was never executed');
  return call as [string, unknown[]];
}

async function get(query: string): Promise<Response> {
  return searchRoutes.request(query ? `/?${query}` : '/');
}

beforeEach(() => {
  authState.user = { id: 1, username: 'admin' };
  fixture = [];
  installDb();
  delete process.env.EMBEDDINGS_ENABLED;
  fetchSpy = vi.fn(() => Promise.reject(new Error('outbound request attempted')));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EMBEDDINGS_ENABLED;
});

describe('GET /api/search - ten-type ranked results + facets', () => {
  it('a Chinese query matching every type returns all ten with correct facets', async () => {
    fixture = [...ALL_TYPES_FIXTURE];
    const response = await get(`q=${encodeURIComponent('苹果')}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: {
        mode: string;
        query: string;
        types: string[];
        ignoredTypes: string[];
        limit: number;
        total: number;
        facets: Record<string, number>;
        results: Array<{ owner_type: string; rank: number }>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.mode).toBe('trigram');
    expect(body.data.query).toBe('苹果');
    expect(body.data.results).toHaveLength(10);
    expect(body.data.results.map((hit) => hit.owner_type).sort()).toEqual([...SEARCH_RESULT_TYPES].sort());
    expect(body.data.types).toEqual([...SEARCH_RESULT_TYPES]);
    expect(body.data.ignoredTypes).toEqual([]);
    expect(body.data.total).toBe(10);
    for (const type of SEARCH_RESULT_TYPES) {
      expect(body.data.facets[type]).toBe(1);
    }
    expect(Object.keys(body.data.facets).sort()).toEqual([...SEARCH_RESULT_TYPES].sort());

    const [sql, params] = hitsCall();
    expect(sql).toContain('owner_type = ANY($5::text[])');
    expect(params[0]).toBe(1);
    expect(params[1]).toBe('苹果');
    expect(params[2]).toBe('%苹果%');
    expect(params[3]).toBe(20);
    expect(params[4]).toEqual([...SEARCH_RESULT_TYPES]);

    const [, facetParams] = facetCall();
    expect(facetParams).toEqual([1, '苹果', '%苹果%', [...SEARCH_RESULT_TYPES]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ranking puts the expected row first for a known fixture', async () => {
    fixture = [
      { owner_type: 'event', owner_id: 7, title: '苹果手机发布会', subtitle: 'custom', rank: 0.42 },
      { owner_type: 'event', owner_id: 3, title: '苹果园踏青', subtitle: 'travel', rank: 0.11 },
      { owner_type: 'inbox', owner_id: 9, title: '关于苹果的通知', subtitle: 'webhook', rank: 0.05 },
    ];
    const response = await get(`q=${encodeURIComponent('苹果')}`);
    const body = (await response.json()) as { data: { results: Array<{ owner_type: string; owner_id: number }> } };
    expect(body.data.results[0]).toEqual(expect.objectContaining({ owner_type: 'event', owner_id: 7 }));
    expect(body.data.results.map((hit) => hit.owner_id)).toEqual([7, 3, 9]);
    // The database does the ordering; the shipped SQL must say so.
    expect(hitsCall()[0]).toContain('ORDER BY rank DESC, owner_id ASC');
  });

  it('types= filters to exactly the requested types and echoes them', async () => {
    fixture = [...ALL_TYPES_FIXTURE];
    const response = await get(`q=${encodeURIComponent('苹果')}&types=event,goal`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { types: string[]; total: number; results: Array<{ owner_type: string }>; facets: Record<string, number> };
    };
    expect(body.data.types).toEqual(['event', 'goal']);
    expect(body.data.results.map((hit) => hit.owner_type).sort()).toEqual(['event', 'goal']);
    expect(body.data.facets.event).toBe(1);
    expect(body.data.facets.goal).toBe(1);
    expect(body.data.facets.inbox).toBe(0);
    expect(body.data.total).toBe(2);
    expect(hitsCall()[1][4]).toEqual(['event', 'goal']);
  });

  it('ignores an unknown types value instead of crashing', async () => {
    fixture = [...ALL_TYPES_FIXTURE];
    const response = await get(`q=${encodeURIComponent('苹果')}&types=bogus`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { types: string[]; ignoredTypes: string[]; total: number; results: unknown[] };
    };
    expect(body.data.ignoredTypes).toEqual(['bogus']);
    expect(body.data.types).toEqual([]);
    expect(body.data.results).toEqual([]);
    expect(body.data.total).toBe(0);

    // Mixed valid + unknown: the valid type applies, the unknown is reported as ignored.
    const mixed = await get(`q=${encodeURIComponent('苹果')}&types=event,bogus`);
    const mixedBody = (await mixed.json()) as {
      data: { types: string[]; ignoredTypes: string[]; results: Array<{ owner_type: string }> };
    };
    expect(mixedBody.data.types).toEqual(['event']);
    expect(mixedBody.data.ignoredTypes).toEqual(['bogus']);
    expect(mixedBody.data.results.map((hit) => hit.owner_type)).toEqual(['event']);
  });

  it('clamps limit defensively: 9999 -> 50, 0 -> 1, non-numeric -> default 20', async () => {
    fixture = [...ALL_TYPES_FIXTURE];
    const high = await get(`q=${encodeURIComponent('苹果')}&limit=9999`);
    expect(((await high.json()) as { data: { limit: number } }).data.limit).toBe(50);
    expect(hitsCall()[1][3]).toBe(50);

    const zero = await get(`q=${encodeURIComponent('苹果')}&limit=0`);
    expect(((await zero.json()) as { data: { limit: number } }).data.limit).toBe(1);
    expect(hitsCall()[1][3]).toBe(1);

    const bogus = await get(`q=${encodeURIComponent('苹果')}&limit=abc`);
    expect(((await bogus.json()) as { data: { limit: number } }).data.limit).toBe(20);
    expect(hitsCall()[1][3]).toBe(20);
  });

  it('a query with no matches returns a valid empty result, not an error', async () => {
    fixture = [];
    const response = await get(`q=${encodeURIComponent('不存在的词')}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { results: unknown[]; total: number; facets: Record<string, number> };
    };
    expect(body.success).toBe(true);
    expect(body.data.results).toEqual([]);
    expect(body.data.total).toBe(0);
    for (const type of SEARCH_RESULT_TYPES) expect(body.data.facets[type]).toBe(0);
  });

  it('rejects an empty q with 400 and never opens a query', async () => {
    const before = dbQuery.mock.calls.length;
    const blank = await get('q=%20%20');
    expect(blank.status).toBe(400);
    const missing = await get('');
    expect(missing.status).toBe(400);
    expect(dbQuery.mock.calls.length).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bounds an over-long q with 400 rather than truncating, and never opens a query', async () => {
    const before = dbQuery.mock.calls.length;
    const oversized = await get(`q=${'x'.repeat(201)}`);
    expect(oversized.status).toBe(400);
    const body = (await oversized.json()) as { error: string };
    expect(body.error).toContain('200');
    expect(dbQuery.mock.calls.length).toBe(before);
  });

  it('requires authentication', async () => {
    authState.user = null;
    const response = await get(`q=${encodeURIComponent('苹果')}`);
    expect(response.status).toBe(401);
  });
});

describe('GET /api/search - zero egress + service contract', () => {
  it('searchGlobal keeps the facet list complete and drops unknown owner rows', async () => {
    dbQuery.mockReset();
    dbQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('COUNT(*)::int AS count')) {
        return {
          rows: [
            { owner_type: 'goal', count: 3 },
            { owner_type: 'users', count: 99 },
          ],
          rowCount: 2,
        };
      }
      if (String(sql).includes('ORDER BY rank DESC')) {
        return { rows: [{ owner_type: 'users', owner_id: 1, title: 'root', subtitle: null, rank: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await searchGlobal(1, '苹果');
    expect(result.results).toEqual([]);
    expect(result.facets.goal).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(result.facets, 'users')).toBe(false);
    expect(result.total).toBe(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the default path never short-circuits into a network call and never mentions a URL', async () => {
    const service = readFileSync(new URL('../services/search.service.ts', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../routes/search.ts', import.meta.url), 'utf8');
    for (const source of [service, route]) {
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/axios|node:https|node:http/);
      expect(source).not.toMatch(/\bconsole\.log\b/);
      expect(source).not.toMatch(/\bas any\b|@ts-ignore/);
    }
    expect(TRIGRAM_SEARCH_TYPED_SQL).not.toMatch(/https?:\/\//);
    expect(TRIGRAM_FACET_SQL).not.toMatch(/https?:\/\//);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
