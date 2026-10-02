/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadStaticSearchIndex,
  resetStaticSearchIndex,
  searchStatic,
  STATIC_SEARCH_INDEX_PATH,
} from './static-search';

/**
 * Integration test against the REAL emitted index (plan todo 76c): the frontend
 * `test` script regenerates frontend/public/search-index.json first, so this
 * also guards that the build-time tokenizer and the client tokenizer agree.
 */
const indexJson = JSON.parse(
  // vitest runs with cwd = frontend/, and import.meta.url is http:// under jsdom (not file:)
  readFileSync(resolve(process.cwd(), 'public/search-index.json'), 'utf8'),
) as { meta: { corpora: string[]; documents: number } };

function stubFetchOk(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => ({ ok: true, json: async () => indexJson }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  resetStaticSearchIndex();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('static search index (build-time, lazily loaded)', () => {
  it('emits all static corpora in the index payload', () => {
    expect(indexJson.meta.documents).toBeGreaterThan(500);
    expect(indexJson.meta.corpora).toEqual(
      expect.arrayContaining(['holidays', 'workdays', 'solar-terms', 'templates', 'relations', 'docs']),
    );
  });

  it('does not fetch anything until the first query (lazy)', async () => {
    const fetchMock = stubFetchOk();
    expect(fetchMock).not.toHaveBeenCalled();
    await searchStatic('国庆');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(STATIC_SEARCH_INDEX_PATH);
    await searchStatic('冬至');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('finds the National Day holiday by Chinese name', async () => {
    stubFetchOk();
    const hits = await searchStatic('国庆');
    expect(hits.length).toBeGreaterThan(0);
    const holiday = hits.find((hit) => hit.kind === 'holiday');
    expect(holiday).toBeDefined();
    expect(holiday?.title).toContain('国庆');
    expect(hits.every((hit) => hit.title)).toBe(true);
  });

  it('finds 调休 workdays, solar terms, templates, relations and docs', async () => {
    stubFetchOk();
    const workday = await searchStatic('调休');
    expect(workday.some((hit) => hit.kind === 'workday')).toBe(true);

    const term = await searchStatic('寒露');
    expect(term[0]).toMatchObject({ kind: 'solar-term' });
    expect(term[0].title).toContain('寒露');

    const template = await searchStatic('生日提醒');
    expect(template.some((hit) => hit.kind === 'template')).toBe(true);

    const relation = await searchStatic('称呼映射');
    expect(relation.some((hit) => hit.kind === 'relation')).toBe(true);

    const doc = await searchStatic('SMTP');
    expect(doc.some((hit) => hit.kind === 'doc')).toBe(true);
  });

  it('returns an empty list (and null index) when the asset is unavailable', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadStaticSearchIndex()).toBeNull();
    expect(await searchStatic('国庆')).toEqual([]);
  });

  it('empty query short-circuits without loading the index', async () => {
    const fetchMock = stubFetchOk();
    expect(await searchStatic('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
