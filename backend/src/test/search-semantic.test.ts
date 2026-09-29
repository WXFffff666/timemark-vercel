import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 106 acceptance: the OPT-IN semantic accelerator.
 *
 * The DB is mocked by a small stateful fake that emulates the exact pgvector semantics the
 * shipped SQL relies on (`embedding <=> $2::vector` = cosine distance, ASC), so the
 * end-to-end ranking below exercises the real service + route code, the real
 * OpenAI-compatible request shape (a stubbed fetch) and a deterministic embedder - and
 * never a network. The provider is contacted only when `EMBEDDINGS_ENABLED=true`.
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
  EmbeddingsDisabledError,
  EmbeddingsError,
  embedTexts,
  isEmbeddingsEnabled,
} from '../services/ai/embeddings.js';
import {
  cleanupOrphanEmbeddings,
  indexEmbeddingsBatch,
  semanticSearch,
} from '../services/search.service.js';
import searchRoutes from '../routes/search.js';

const DIMS = 768;
const ENABLED_ENV = {
  EMBEDDINGS_ENABLED: 'true',
  EMBEDDINGS_MODEL: 'test-embed',
  EMBEDDINGS_BASE_URL: 'http://127.0.0.1:11434/v1',
};
const ENV_KEYS = [
  'EMBEDDINGS_ENABLED',
  'EMBEDDINGS_BASE_URL',
  'EMBEDDINGS_MODEL',
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_DIMS',
  'EMBEDDINGS_BATCH_SIZE',
];

interface FakeEmbedding {
  userId: number;
  ownerType: string;
  ownerId: number;
  model: string;
  dims: number;
  embedding: string;
  contentHash: string;
}

interface Seed {
  events?: Array<Record<string, unknown>>;
  contacts?: Array<Record<string, unknown>>;
  interactions?: Array<Record<string, unknown>>;
  documents?: Array<Record<string, unknown>>;
  expiry?: Array<Record<string, unknown>>;
  embeddings?: FakeEmbedding[];
  tablePresent?: boolean;
}

interface FakeStore {
  events: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
  interactions: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  expiry: Array<Record<string, unknown>>;
  embeddings: FakeEmbedding[];
  tablePresent: boolean;
}

const SOURCES = [
  { owner: 'event', table: 'events', key: 'events' },
  { owner: 'contact', table: 'fixed_contacts', key: 'contacts' },
  { owner: 'interaction', table: 'interactions', key: 'interactions' },
  { owner: 'document', table: 'documents', key: 'documents' },
  { owner: 'expiry', table: 'expiry_items', key: 'expiry' },
] as const;

let store: FakeStore;
let insertCount = 0;
let savedEnv: Record<string, string | undefined> = {};

function parseVector(literal: string): number[] {
  return literal.replace(/^\[/, '').replace(/\]$/, '').split(',').filter(Boolean).map(Number);
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function project(sql: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const match = /^SELECT (.+?) FROM /i.exec(sql);
  if (!match || match[1].trim() === '*') return rows;
  const columns = match[1].split(',').map((column) => column.trim());
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
}

function rowsForOwner(ownerType: string): Array<Record<string, unknown>> {
  const source = SOURCES.find((candidate) => candidate.owner === ownerType);
  return source ? store[source.key] : [];
}

function installDb(seed: Seed = {}): void {
  store = {
    events: (seed.events ?? []).map((row) => ({ ...row })),
    contacts: (seed.contacts ?? []).map((row) => ({ ...row })),
    interactions: (seed.interactions ?? []).map((row) => ({ ...row })),
    documents: (seed.documents ?? []).map((row) => ({ ...row })),
    expiry: (seed.expiry ?? []).map((row) => ({ ...row })),
    embeddings: (seed.embeddings ?? []).map((row) => ({ ...row })),
    tablePresent: seed.tablePresent !== false,
  };
  insertCount = 0;
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();

    if (s.includes('to_regclass')) {
      return { rows: [{ table_name: store.tablePresent ? 'embeddings' : null }], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO embeddings')) {
      const [userId, ownerType, ownerId, model, dims, embedding, contentHash] = params as [
        number,
        string,
        number,
        string,
        number,
        string,
        string,
      ];
      const next: FakeEmbedding = {
        userId: Number(userId),
        ownerType,
        ownerId: Number(ownerId),
        model,
        dims: Number(dims),
        embedding,
        contentHash,
      };
      const existing = store.embeddings.find(
        (row) => row.ownerType === ownerType && row.ownerId === next.ownerId && row.model === model,
      );
      if (existing) Object.assign(existing, next);
      else store.embeddings.push(next);
      insertCount += 1;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM embeddings')) {
      const [ownerType] = params as [string];
      const liveIds = new Set(rowsForOwner(ownerType).map((row) => Number(row.id)));
      const before = store.embeddings.length;
      store.embeddings = store.embeddings.filter(
        (row) => row.ownerType !== ownerType || liveIds.has(row.ownerId),
      );
      return { rows: [], rowCount: before - store.embeddings.length };
    }
    if (s.includes('embedding <=> ')) {
      const [userId, vectorLiteral, limit] = params as [number, string, number];
      const queryVector = parseVector(vectorLiteral);
      const ranked = store.embeddings
        .filter((row) => row.userId === Number(userId))
        .map((row) => ({
          owner_type: row.ownerType,
          owner_id: row.ownerId,
          distance: cosineDistance(queryVector, parseVector(row.embedding)),
        }))
        .sort((a, b) => a.distance - b.distance || a.owner_id - b.owner_id)
        .slice(0, Number(limit));
      return { rows: ranked, rowCount: ranked.length };
    }
    if (s.includes('SELECT owner_id, content_hash FROM embeddings')) {
      const [ownerType, model, ids] = params as [string, string, number[]];
      const rows = store.embeddings
        .filter((row) => row.ownerType === ownerType && row.model === model && ids.includes(row.ownerId))
        .map((row) => ({ owner_id: row.ownerId, content_hash: row.contentHash }));
      return { rows, rowCount: rows.length };
    }
    for (const source of SOURCES) {
      if (s.includes(`FROM ${source.table}`)) {
        const rows = store[source.key];
        if (s.includes('id = ANY($2::int[])')) {
          const wanted = (params[1] as number[]) ?? [];
          const matched = rows.filter((row) => wanted.includes(Number(row.id)));
          return { rows: project(s, matched), rowCount: matched.length };
        }
        const limited = rows.slice(0, Number(params[0]));
        return { rows: project(s, limited), rowCount: limited.length };
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

/** Deterministic topic-bucket embedder: 苹果 -> e0, 香蕉 -> e1, 会议 -> e2, 旅行 -> e3. */
const TOPICS = ['苹果', '香蕉', '会议', '旅行'];
function deterministicEmbedder(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const vector = new Array<number>(DIMS).fill(0);
      const bucket = TOPICS.findIndex((topic) => text.includes(topic));
      vector[bucket >= 0 ? bucket : TOPICS.length] = 1;
      return vector;
    }),
  );
}

function seededEvents(count = 20): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let id = 1; id <= count; id += 1) {
    const name =
      id === 7
        ? '苹果手机发布会'
        : id % 3 === 0
          ? `香蕉采购单 ${id}`
          : id % 3 === 1
            ? `项目会议 ${id}`
            : `东京旅行 ${id}`;
    rows.push({ id, user_id: 1, name, person_name: null, tags: [] });
  }
  return rows;
}

function callsIncluding(marker: string): Array<[string, unknown[]]> {
  return dbQuery.mock.calls.filter(([sql]) => String(sql).includes(marker)) as Array<[string, unknown[]]>;
}

beforeEach(() => {
  authState.user = { id: 1, username: 'admin' };
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  installDb();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

describe('semantic search is opt-in (default OFF)', () => {
  it('with EMBEDDINGS_ENABLED unset: endpoint 503, no provider contacted, trigram still returns matches', async () => {
    expect(isEmbeddingsEnabled({})).toBe(false);

    // The trigram default keeps working with the feature flag absent.
    installDb({ events: seededEvents() });
    dbQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('WITH hits AS')) {
        return {
          rows: [{ owner_type: 'event', owner_id: 7, title: '苹果手机发布会', subtitle: 'custom', rank: 0.4 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const trigram = await searchRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: '苹果' }),
    });
    expect(trigram.status).toBe(200);
    const trigramBody = (await trigram.json()) as { data: { mode: string; results: unknown[] } };
    expect(trigramBody.data.mode).toBe('trigram');
    expect(trigramBody.data.results).toHaveLength(1);

    // The semantic endpoint is disabled and does not even open a DB query.
    const callsBefore = dbQuery.mock.calls.length;
    const semantic = await searchRoutes.request('/semantic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: '苹果' }),
    });
    expect(semantic.status).toBe(503);
    const semanticBody = (await semantic.json()) as { code: string; error: string };
    expect(semanticBody.code).toBe('EMBEDDINGS_DISABLED');
    expect(semanticBody.error).toContain('EMBEDDINGS_ENABLED');
    expect(dbQuery.mock.calls.length).toBe(callsBefore);

    // Neither the client nor the background jobs contact a provider.
    const fetchSpy = vi.fn(() => Promise.reject(new Error('outbound request attempted')));
    await expect(embedTexts(['苹果'], { env: {}, fetchImpl: fetchSpy })).rejects.toBeInstanceOf(
      EmbeddingsDisabledError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    const queriesBefore = dbQuery.mock.calls.length;
    const indexed = await indexEmbeddingsBatch({ env: {} });
    expect(indexed).toMatchObject({ enabled: false, scanned: 0, embedded: 0, skipped: 0, failed: 0 });
    const cleaned = await cleanupOrphanEmbeddings({ env: {} });
    expect(cleaned).toEqual({ enabled: false, removed: 0 });
    expect(dbQuery.mock.calls.length).toBe(queriesBefore);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('degrades when the embeddings table is absent (pgvector unavailable) without failing the nightly job', async () => {
    installDb({ events: seededEvents(), tablePresent: false });
    const indexed = await indexEmbeddingsBatch({ env: ENABLED_ENV, embed: deterministicEmbedder, batchSize: 100 });
    expect(indexed).toMatchObject({ enabled: true, tableReady: false, embedded: 0 });
    const cleaned = await cleanupOrphanEmbeddings({ env: ENABLED_ENV });
    expect(cleaned).toEqual({ enabled: true, removed: 0 });
  });
});

describe('semantic indexing + cosine ranking', () => {
  it('seeds 20 events, embeds them in a bounded batch and ranks the expected row first', async () => {
    installDb({ events: seededEvents() });
    const fetchSpy = vi.fn(() => Promise.reject(new Error('outbound request attempted')));
    vi.stubGlobal('fetch', fetchSpy);
    const indexed = await indexEmbeddingsBatch({
      env: ENABLED_ENV,
      embed: deterministicEmbedder,
      batchSize: 100,
    });
    expect(indexed).toMatchObject({
      enabled: true,
      tableReady: true,
      scanned: 20,
      embedded: 20,
      skipped: 0,
      failed: 0,
    });
    expect(insertCount).toBe(20);
    expect(store.embeddings).toHaveLength(20);
    expect(store.embeddings.every((row) => row.dims === DIMS && row.embedding.startsWith('['))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const hits = await semanticSearch(1, '苹果手机', { env: ENABLED_ENV, embed: deterministicEmbedder });
    expect(hits).toHaveLength(20);
    expect(hits[0]?.owner_type).toBe('event');
    expect(hits[0]?.owner_id).toBe(7);
    expect(hits[0]?.distance).toBeCloseTo(0, 10);
    expect(String(hits[0]?.row?.name)).toContain('苹果');
    expect(fetchSpy).not.toHaveBeenCalled();

    // Ranking is delegated to pgvector; the query vector goes in as a `$2::vector` literal.
    const rankSql = callsIncluding('embedding <=> ')[0];
    expect(rankSql?.[0]).toContain('ORDER BY embedding <=> $2::vector ASC');
    expect(rankSql?.[1][1]).toMatch(/^\[.+\]$/);
  });

  it('an unchanged row is a no-op via content_hash: the embedder is never called again', async () => {
    installDb({ events: seededEvents() });
    await indexEmbeddingsBatch({ env: ENABLED_ENV, embed: deterministicEmbedder, batchSize: 100 });
    const insertsAfterFirstRun = insertCount;

    let embeddedTexts = 0;
    const countingEmbedder = (texts: string[]) => {
      embeddedTexts += texts.length;
      return deterministicEmbedder(texts);
    };
    const second = await indexEmbeddingsBatch({ env: ENABLED_ENV, embed: countingEmbedder, batchSize: 100 });
    expect(second).toMatchObject({ scanned: 20, embedded: 0, skipped: 20, failed: 0 });
    expect(embeddedTexts).toBe(0);
    expect(insertCount).toBe(insertsAfterFirstRun);
  });

  it('a changed row is re-embedded because its content_hash differs', async () => {
    installDb({ events: seededEvents() });
    await indexEmbeddingsBatch({ env: ENABLED_ENV, embed: deterministicEmbedder, batchSize: 100 });
    store.events[0].name = `改名的会议 ${store.events[0].id}`;

    const second = await indexEmbeddingsBatch({ env: ENABLED_ENV, embed: deterministicEmbedder, batchSize: 100 });
    expect(second).toMatchObject({ scanned: 20, embedded: 1, skipped: 19, failed: 0 });
  });

  it('caps a huge batch size at 200 rows per nightly run', async () => {
    installDb({ events: seededEvents() });
    const result = await indexEmbeddingsBatch({
      env: ENABLED_ENV,
      embed: deterministicEmbedder,
      batchSize: 5000,
    });
    expect(result.scanned).toBe(20);
    const sourceSelect = callsIncluding('FROM events WHERE user_id IS NOT NULL')[0];
    expect(sourceSelect?.[1][0]).toBe(200);
  });

  it('the nightly cleaner removes embeddings whose owner row was deleted - no orphan survives', async () => {
    installDb({ events: seededEvents() });
    await indexEmbeddingsBatch({ env: ENABLED_ENV, embed: deterministicEmbedder, batchSize: 100 });
    expect(store.embeddings.some((row) => row.ownerType === 'event' && row.ownerId === 7)).toBe(true);

    store.events = store.events.filter((row) => Number(row.id) !== 7);
    const cleaned = await cleanupOrphanEmbeddings({ env: ENABLED_ENV });
    expect(cleaned).toEqual({ enabled: true, removed: 1 });
    expect(store.embeddings.some((row) => row.ownerType === 'event' && row.ownerId === 7)).toBe(false);
    expect(store.embeddings).toHaveLength(19);

    const deleteSql = callsIncluding('DELETE FROM embeddings').map(([sql]) => sql);
    expect(deleteSql).toHaveLength(5);
    for (const sql of deleteSql) {
      expect(sql).toContain('NOT EXISTS');
    }
  });

  it('the semantic route returns ranked hits with the source row when enabled', async () => {
    installDb({ events: seededEvents() });
    await indexEmbeddingsBatch({ env: ENABLED_ENV, embed: deterministicEmbedder, batchSize: 100 });

    process.env.EMBEDDINGS_ENABLED = 'true';
    process.env.EMBEDDINGS_MODEL = 'test-embed';
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
      const vectors = await deterministicEmbedder(body.input);
      return new Response(JSON.stringify({ data: vectors.map((embedding) => ({ embedding })) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const response = await searchRoutes.request('/semantic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: '苹果手机', limit: 5 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { mode: string; results: Array<{ owner_id: number; row: { name: string } | null }> };
    };
    expect(body.data.mode).toBe('semantic');
    expect(body.data.results[0]?.owner_id).toBe(7);
    expect(body.data.results[0]?.row?.name).toContain('苹果');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:11434/v1/embeddings');
    expect(init?.method).toBe('POST');
  });
});

describe('failure cases', () => {
  it('rejects a >2048-dim model config with a clear message before any provider call', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('outbound request attempted')));
    const env3072 = { ...ENABLED_ENV, EMBEDDINGS_DIMS: '3072' };
    await expect(embedTexts(['x'], { env: env3072, fetchImpl: fetchSpy })).rejects.toMatchObject({
      code: 'EMBEDDINGS_DIMS',
    });
    await expect(embedTexts(['x'], { env: env3072, fetchImpl: fetchSpy })).rejects.toThrow(/3072/);
    await expect(embedTexts(['x'], { env: env3072, fetchImpl: fetchSpy })).rejects.toThrow(/2048/);
    await expect(embedTexts(['x'], { env: env3072, fetchImpl: fetchSpy })).rejects.toThrow(
      /embeddings\.embedding column/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    // An injected provider that returns too many dims is rejected by the same column rule.
    installDb({ events: seededEvents() });
    await expect(
      indexEmbeddingsBatch({
        env: ENABLED_ENV,
        embed: (texts: string[]) => Promise.resolve(texts.map(() => new Array<number>(3072).fill(0))),
      }),
    ).rejects.toThrow(/2048/);

    // DDL-level backstop: the v53 CHECK is what a direct INSERT would hit.
    const migrateSource = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
    expect(migrateSource).toContain('CHECK (vector_dims(embedding) <= 2048)');
  });

  it('rejects the semantic route with 400 and the clear message for an oversized dims config', async () => {
    process.env.EMBEDDINGS_ENABLED = 'true';
    process.env.EMBEDDINGS_DIMS = '3072';
    const response = await searchRoutes.request('/semantic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: '苹果' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe('EMBEDDINGS_DIMS');
    expect(body.error).toContain('3072');
    expect(body.error).toContain('2048');
  });

  it('reports a provider outage as failed instead of aborting the nightly job', async () => {
    installDb({ events: seededEvents() });
    const failing = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    const result = await indexEmbeddingsBatch({ env: ENABLED_ENV, embed: failing, batchSize: 100 });
    expect(result.failed).toBe(20);
    expect(result.embedded).toBe(0);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('the embeddings client speaks the OpenAI-compatible protocol to the local Ollama default', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const vectors = await embedTexts(['hello'], { env: { EMBEDDINGS_ENABLED: 'true' }, fetchImpl });
    expect(vectors).toEqual([[0.1, 0.2]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:11434/v1/embeddings');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'nomic-embed-text', input: ['hello'] });
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();

    const withKey = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await embedTexts(['hello'], {
      env: { EMBEDDINGS_ENABLED: 'true', EMBEDDINGS_API_KEY: 'secret-key' },
      fetchImpl: withKey,
    });
    const [, keyedInit] = withKey.mock.calls[0] ?? [];
    expect((keyedInit?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer secret-key');
  });

  it('never reads document numbers into embed content or hydrated results', async () => {
    installDb({
      documents: [
        {
          id: 3,
          user_id: 1,
          title: '护照续签',
          issuer: '出入境管理局',
          document_number_encrypted: 'P1234567',
          kind: 'passport',
        },
      ],
    });
    const capturingEmbedder = vi.fn((texts: string[]) => deterministicEmbedder(texts));
    await indexEmbeddingsBatch({ env: ENABLED_ENV, embed: capturingEmbedder, batchSize: 100 });

    const documentSelect = callsIncluding('FROM documents')[0];
    expect(documentSelect?.[0]).toContain('title, issuer');
    expect(documentSelect?.[0]).not.toContain('document_number_encrypted');
    const embeddedInputTexts = (capturingEmbedder.mock.calls[0]?.[0] ?? []).join(' ');
    expect(embeddedInputTexts).toContain('护照续签');
    expect(embeddedInputTexts).not.toContain('P1234567');

    const hits = await semanticSearch(1, '护照', { env: ENABLED_ENV, embed: deterministicEmbedder });
    expect(hits[0]?.owner_type).toBe('document');
    expect(JSON.stringify(hits)).toContain('护照续签');
    expect(JSON.stringify(hits)).not.toContain('P1234567');
  });

  it('ships no secrets / attachment reads and no type or console escapes in the new modules', () => {
    const service = readFileSync(new URL('../services/search.service.ts', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../services/ai/embeddings.ts', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../routes/search.ts', import.meta.url), 'utf8');
    for (const source of [service, client, route]) {
      expect(source).not.toMatch(/\bFROM\s+attachments\b/i);
      expect(source).not.toMatch(/\bas any\b|@ts-ignore/);
      expect(source).not.toMatch(/console\.log/);
    }
    expect(service).not.toMatch(/SELECT[^`]*document_number_encrypted/i);
    expect(route).not.toMatch(/document_number_encrypted/);
    expect(client).not.toMatch(/document_number_encrypted|attachment/);
  });
});

describe('EmbeddingsError contract', () => {
  it('keeps a machine-readable code for every failure class', () => {
    const disabled = new EmbeddingsDisabledError();
    expect(disabled).toBeInstanceOf(EmbeddingsError);
    expect(disabled.code).toBe('EMBEDDINGS_DISABLED');
  });
});
