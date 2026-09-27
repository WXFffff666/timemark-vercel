import type MiniSearchClass from 'minisearch';
import type { Options, SearchResult } from 'minisearch';
import { tokenize } from './search-tokenizer.mjs';

/**
 * Lazy client for the build-time static search index (plan todo 76c).
 *
 * The index is produced by `scripts/build-search-index.mjs` into
 * `frontend/public/search-index.json` (size-asserted during build). It covers
 * holidays/调休, 节气/黄历. rules, notification templates, relation mappings and
 * help/docs — so static lookups never hit the API at query time.
 *
 * Loading is deferred until the first query (dynamic `import('minisearch')`
 * keeps the search engine in its own chunk). Any failure degrades to an empty
 * result set instead of crashing the page.
 */

export const STATIC_SEARCH_INDEX_PATH = '/search-index.json';

export interface StaticSearchHit {
  id: string;
  kind: string;
  title: string;
  score: number;
}

const SEARCH_OPTIONS: Options = {
  fields: ['title', 'text'],
  storeFields: ['kind', 'title'],
  idField: 'id',
  tokenize,
};

let indexPromise: Promise<MiniSearchClass | null> | null = null;

/** Loads (once) and memoizes the static index; resolves null when unavailable. */
export function loadStaticSearchIndex(): Promise<MiniSearchClass | null> {
  if (!indexPromise) {
    indexPromise = (async () => {
      try {
        const [miniSearchModule, response] = await Promise.all([
          import('minisearch'),
          fetch(STATIC_SEARCH_INDEX_PATH, { headers: { Accept: 'application/json' } }),
        ]);
        if (!response.ok) throw new Error(`search index HTTP ${response.status}`);
        const payload = (await response.json()) as { index?: unknown } | unknown;
        const serialized =
          payload && typeof payload === 'object' && 'index' in payload
            ? (payload as { index: unknown }).index
            : payload;
        return miniSearchModule.default.loadJSON(JSON.stringify(serialized), SEARCH_OPTIONS);
      } catch {
        return null;
      }
    })();
  }
  return indexPromise;
}

/** Test-only: forget the memoized promise so the next call re-fetches. */
export function resetStaticSearchIndex(): void {
  indexPromise = null;
}

export async function searchStatic(query: string, limit = 8): Promise<StaticSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const index = await loadStaticSearchIndex();
  if (!index) return [];
  // MiniSearch 7 has no `limit` search option; cap the result list ourselves.
  // Title matches are boosted so a holiday name outranks 调休 docs that merely
  // mention the same name in a longer text field.
  const results = index.search(trimmed, { prefix: true, boost: { title: 3 } }).slice(0, limit) as Array<
    SearchResult & { kind?: unknown; title?: unknown }
  >;
  return results.map((result) => ({
    id: String(result.id),
    kind: typeof result.kind === 'string' ? result.kind : '',
    title: typeof result.title === 'string' ? result.title : String(result.id),
    score: result.score,
  }));
}
