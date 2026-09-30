import { createHash } from 'node:crypto';
import { query } from '../db/index.js';
import {
  EmbeddingsDisabledError,
  EmbeddingsError,
  assertEmbeddingDims,
  embedTexts,
  getEmbeddingsConfig,
  isEmbeddingsEnabled,
  type EmbeddingsEnv,
} from './ai/embeddings.js';
import { decryptFieldValue } from './field-encryption.service.js';

/**
 * Search over the user's OWN data (checkbox 106).
 *
 * ## Default path - trigram, zero egress
 * `searchLocal()` runs one `UNION ALL` of `ILIKE '%q%'` predicates against the v53 GIN
 * trigram indexes (`gin_trgm_ops`) and ranks candidates with `similarity()`. This is the
 * only path that runs by default: it needs nothing but Postgres + `pg_trgm`, works for
 * Chinese/CJK substring queries (which `to_tsvector` cannot tokenise), and performs NO
 * outbound request of any kind.
 *
 * ## Opt-in accelerator - embeddings (EMBEDDINGS_ENABLED=false by default)
 * `indexEmbeddingsBatch()` writes changed rows to `embeddings` in a bounded nightly batch,
 * `semanticSearch()` ranks by cosine distance (`<=>`) through pgvector, and
 * `cleanupOrphanEmbeddings()` removes rows whose owner was deleted. All three are no-ops
 * (not even a query) while the feature flag is off.
 *
 * ## Never embedded / never returned
 * `document_number_encrypted`, notification credentials, share tokens and attachment bytes
 * are never selected into the embed content nor into the search projections. `documents`
 * is embedded from `title` + `issuer` only, and its hydrated source row is an explicit
 * safe column list - not `SELECT *`.
 */

export const SEARCH_OWNER_TYPES = ['event', 'contact', 'interaction', 'document', 'expiry'] as const;
export type SearchOwnerType = (typeof SEARCH_OWNER_TYPES)[number];

/**
 * The ten result-entity types `GET /api/search` folds together (checkbox 132). The first five
 * are the embeddable `SEARCH_OWNER_TYPES` (they also back the opt-in semantic path); the last
 * five are trigram-only entity types added by migration v57. This is the SAME search stack -
 * one `pg_trgm` GIN index set, one ranked `ILIKE`/`similarity` CTE - never a second engine.
 */
export const SEARCH_RESULT_TYPES = [
  'event',
  'contact',
  'interaction',
  'document',
  'expiry',
  'inventory',
  'maintenance',
  'habit',
  'goal',
  'inbox',
] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

export const SEARCH_MAX_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;
export const DEFAULT_EMBEDDINGS_BATCH_SIZE = 25;
export const MAX_EMBEDDINGS_BATCH_SIZE = 200;

export interface SearchHit {
  /** Widened to the ten result types; a superset of `SearchOwnerType`, so callers are unaffected. */
  owner_type: SearchResultType;
  owner_id: number;
  title: string;
  subtitle: string | null;
  rank: number;
}

/** Facet counts per result type; every one of the ten keys is always present (0 when nothing matched). */
export type SearchFacets = Record<SearchResultType, number>;

export interface GlobalSearchResult {
  results: SearchHit[];
  facets: SearchFacets;
  /** Total matches across every returned facet (NOT capped by `limit`). */
  total: number;
  /** The effective, clamped page size actually sent to the database. */
  limit: number;
  /** The effective type filter (canonically ordered); all ten when the caller passed none. */
  types: SearchResultType[];
}

export interface SemanticHit {
  owner_type: SearchOwnerType;
  owner_id: number;
  distance: number;
  row: Record<string, unknown> | null;
}

/**
 * The shared `hits` CTE body for the default search: one `ILIKE '%q%'` predicate per indexed
 * column, ranked by `similarity()`. `$1` user, `$2` raw query (ranking), `$3` escaped `%query%`
 * pattern (the only shape a GIN trigram index can serve). Every `ILIKE` column below has a
 * matching `gin_trgm_ops` index - the first five entity types were completed by migration v53
 * (including the `(tags::text)` expression index, which must stay byte-identical to the index
 * definition) and inventory/maintenance/habits/goals/inbox by v57.
 *
 * The CTE is factored into ONE builder so the four result paths (untyped / typed / facet / ...)
 * can never drift. `WITH hits AS` is the stable marker the tests key on.
 */
const TRIGRAM_HITS_SQL = `SELECT 'event' AS owner_type, id AS owner_id, name AS title, type AS subtitle,
       COALESCE(GREATEST(
         similarity(name, $2),
         similarity(COALESCE(person_name, ''), $2),
         similarity(COALESCE(tags::text, ''), $2)
       ), 0) AS rank
FROM events
WHERE user_id = $1
  AND (name ILIKE $3 OR person_name ILIKE $3 OR tags::text ILIKE $3)
UNION ALL
SELECT 'contact' AS owner_type, id AS owner_id, name AS title, relationship AS subtitle,
       COALESCE(GREATEST(
         similarity(name, $2),
         similarity(COALESCE(nickname, ''), $2),
         similarity(COALESCE(notes, ''), $2),
         similarity(COALESCE(relationship, ''), $2)
       ), 0) AS rank
FROM fixed_contacts
WHERE user_id = $1
  AND (name ILIKE $3 OR nickname ILIKE $3 OR notes ILIKE $3 OR relationship ILIKE $3)
UNION ALL
SELECT 'interaction' AS owner_type, id AS owner_id, COALESCE(summary, '') AS title, kind AS subtitle,
       similarity(COALESCE(summary, ''), $2) AS rank
FROM interactions
WHERE user_id = $1 AND summary ILIKE $3
UNION ALL
SELECT 'document' AS owner_type, id AS owner_id, title AS title, issuer AS subtitle,
       COALESCE(GREATEST(
         similarity(title, $2),
         similarity(COALESCE(issuer, ''), $2)
       ), 0) AS rank
FROM documents
WHERE user_id = $1
  AND (title ILIKE $3 OR issuer ILIKE $3)
UNION ALL
SELECT 'expiry' AS owner_type, id AS owner_id, title AS title, vendor AS subtitle,
       COALESCE(GREATEST(
         similarity(title, $2),
         similarity(COALESCE(vendor, ''), $2),
         similarity(COALESCE(notes, ''), $2)
       ), 0) AS rank
FROM expiry_items
WHERE user_id = $1
  AND (title ILIKE $3 OR vendor ILIKE $3 OR notes ILIKE $3)
UNION ALL
SELECT 'inventory' AS owner_type, id AS owner_id, name AS title, category AS subtitle,
       COALESCE(GREATEST(
         similarity(name, $2),
         similarity(COALESCE(location, ''), $2),
         similarity(COALESCE(notes, ''), $2)
       ), 0) AS rank
FROM inventory_items
WHERE user_id = $1
  AND (name ILIKE $3 OR location ILIKE $3 OR notes ILIKE $3)
UNION ALL
SELECT 'maintenance' AS owner_type, id AS owner_id, asset_name AS title, asset_kind AS subtitle,
       COALESCE(GREATEST(
         similarity(asset_name, $2),
         similarity(COALESCE(notes, ''), $2)
       ), 0) AS rank
FROM maintenance_plans
WHERE user_id = $1
  AND (asset_name ILIKE $3 OR notes ILIKE $3)
UNION ALL
SELECT 'habit' AS owner_type, id AS owner_id, name AS title, period AS subtitle,
       similarity(name, $2) AS rank
FROM habits
WHERE user_id = $1 AND name ILIKE $3
UNION ALL
SELECT 'goal' AS owner_type, id AS owner_id, title AS title, status AS subtitle,
       COALESCE(GREATEST(
         similarity(title, $2),
         similarity(COALESCE(description, ''), $2)
       ), 0) AS rank
FROM goals
WHERE user_id = $1
  AND (title ILIKE $3 OR description ILIKE $3)
UNION ALL
SELECT 'inbox' AS owner_type, id AS owner_id, title AS title, source AS subtitle,
       COALESCE(GREATEST(
         similarity(title, $2),
         similarity(COALESCE(body, ''), $2),
         similarity(COALESCE(sender_label, ''), $2)
       ), 0) AS rank
FROM inbox_messages
WHERE user_id = $1
  AND (title ILIKE $3 OR body ILIKE $3 OR sender_label ILIKE $3)`;

/**
 * Untyped default search: `$1` user, `$2` raw query, `$3` escaped pattern, `$4` limit. Kept at
 * EXACTLY four parameters so the existing POST path and `tool-handlers.search` are unchanged.
 */
export const TRIGRAM_SEARCH_SQL = `
WITH hits AS (
${TRIGRAM_HITS_SQL}
)
SELECT owner_type, owner_id, title, subtitle, rank
FROM hits
ORDER BY rank DESC, owner_id ASC
LIMIT $4`;

/**
 * Type-filtered search for `GET /api/search`: `$5` is the concrete `text[]` of result types to
 * keep (`owner_type = ANY($5::text[])`). `searchGlobal` always passes an explicit, non-empty
 * type list - all ten when the caller specified none - so there is no NULL-array branch to get
 * wrong. An empty list is a valid no-op that matches zero rows.
 */
export const TRIGRAM_SEARCH_TYPED_SQL = `
WITH hits AS (
${TRIGRAM_HITS_SQL}
)
SELECT owner_type, owner_id, title, subtitle, rank
FROM hits
WHERE owner_type = ANY($5::text[])
ORDER BY rank DESC, owner_id ASC
LIMIT $4`;

/**
 * Facet counts for `GET /api/search`: `$4` is the same concrete `text[]` type list. Counts are
 * computed over ALL matches (before `LIMIT`), so the facet tells the caller how many hits each
 * type has, not just how many fit on the page.
 */
export const TRIGRAM_FACET_SQL = `
WITH hits AS (
${TRIGRAM_HITS_SQL}
)
SELECT owner_type, COUNT(*)::int AS count
FROM hits
WHERE owner_type = ANY($4::text[])
GROUP BY owner_type`;

/** Cosine ranking is delegated to pgvector; `$2` is the query vector literal. */
export const SEMANTIC_RANK_SQL = `
SELECT owner_type, owner_id, embedding <=> $2::vector AS distance
FROM embeddings
WHERE user_id = $1 AND embedding IS NOT NULL
ORDER BY embedding <=> $2::vector ASC
LIMIT $3`;

export const EMBEDDING_UPSERT_SQL = `
INSERT INTO embeddings (user_id, owner_type, owner_id, model, dims, embedding, content_hash)
VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
ON CONFLICT (owner_type, owner_id, model) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  dims = EXCLUDED.dims,
  embedding = EXCLUDED.embedding,
  content_hash = EXCLUDED.content_hash,
  created_at = CURRENT_TIMESTAMP`;

/** Columns embedded per owner type - every one of them is non-secret by construction. */
const CONTENT_FIELDS: Record<SearchOwnerType, readonly string[]> = {
  event: ['name', 'person_name', 'tags'],
  contact: ['name', 'nickname', 'notes', 'relationship'],
  interaction: ['summary'],
  document: ['title', 'issuer'],
  expiry: ['title', 'vendor'],
};

interface EmbedSourceSpec {
  table: string;
  select: string;
}

/**
 * Source columns for indexing. `documents` deliberately reads `title`/`issuer` only:
 * the number lives encrypted in `document_number_encrypted` and must never be embedded.
 */
const EMBED_SOURCES: Record<SearchOwnerType, EmbedSourceSpec> = {
  event: { table: 'events', select: 'id, user_id, name, person_name, tags' },
  contact: { table: 'fixed_contacts', select: 'id, user_id, name, nickname, notes, relationship' },
  interaction: { table: 'interactions', select: 'id, user_id, summary' },
  document: { table: 'documents', select: 'id, user_id, title, issuer' },
  expiry: { table: 'expiry_items', select: 'id, user_id, title, vendor' },
};

/** Explicit safe projections for hydrated semantic results - never `SELECT *`. */
const SOURCE_PROJECTIONS: Record<SearchOwnerType, string> = {
  event: 'id, name, type, date, person_name, tags',
  contact: 'id, name, nickname, relationship',
  interaction: 'id, contact_id, kind, occurred_at, summary',
  document: 'id, kind, title, issuer, country, issued_at, expires_at, is_active',
  expiry: 'id, title, vendor, kind, currency, next_due_date, amount_cents, is_active',
};

export interface EmbedTextsFn {
  (texts: string[]): Promise<number[][]>;
}

export interface IndexEmbeddingsOptions {
  batchSize?: number;
  /** Injected deterministic embedder for tests; defaults to the configured provider. */
  embed?: EmbedTextsFn;
  env?: EmbeddingsEnv;
}

export interface IndexEmbeddingsResult {
  enabled: boolean;
  tableReady: boolean;
  scanned: number;
  embedded: number;
  skipped: number;
  failed: number;
  error?: string;
}

export interface CleanupEmbeddingsResult {
  enabled: boolean;
  removed: number;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), SEARCH_MAX_LIMIT);
}

/** Escape LIKE metacharacters so `%` / `_` / `\` search literally (default ESCAPE '\'). */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function isSearchOwnerType(value: unknown): value is SearchOwnerType {
  return typeof value === 'string' && (SEARCH_OWNER_TYPES as readonly string[]).includes(value);
}

/** Guards a row's `owner_type` against the ten trigram result types (never an unknown owner). */
export function isSearchResultType(value: unknown): value is SearchResultType {
  return typeof value === 'string' && (SEARCH_RESULT_TYPES as readonly string[]).includes(value);
}

/** Maps raw `hits` rows to `SearchHit`s, dropping any row whose owner_type is unknown. */
function mapSearchRows(rows: Array<Record<string, unknown>>): SearchHit[] {
  return rows.flatMap((row) => {
    if (!isSearchResultType(row.owner_type)) return [];
    return [
      {
        owner_type: row.owner_type,
        owner_id: Number(row.owner_id),
        title: String(row.title ?? ''),
        subtitle: row.subtitle === null || row.subtitle === undefined ? null : String(row.subtitle),
        rank: Number(row.rank ?? 0),
      },
    ];
  });
}

function fieldText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(' ');
  return JSON.stringify(value);
}

/** Deterministic text for one owner row: only the whitelisted, non-secret fields. */
export function extractSearchContent(ownerType: SearchOwnerType, row: Record<string, unknown>): string {
  // Task 161: interaction summaries are encrypted at rest - embed the plaintext, never
  // the ciphertext (a ciphertext-shaped undecryptable value becomes the placeholder).
  const source =
    ownerType === 'interaction' && row.summary != null
      ? { ...row, summary: decryptFieldValue(row.summary) }
      : row;
  return CONTENT_FIELDS[ownerType]
    .map((field) => fieldText(source[field]).trim())
    .filter(Boolean)
    .join('\n');
}

export function embeddingsContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** pgvector text representation accepted by `$n::vector` parameters. */
export function toVectorLiteral(values: number[]): string {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new EmbeddingsError(
      'embedding vector contains a non-finite value; the embeddings.embedding column accepts only finite numbers',
      'EMBEDDINGS_PARSE',
    );
  }
  return `[${values.join(',')}]`;
}

/** Trigrams need at least one character; the route enforces the same rule. */
export async function searchLocal(
  userId: number,
  searchQuery: string,
  options: { limit?: number } = {},
): Promise<SearchHit[]> {
  const trimmed = searchQuery.trim();
  if (trimmed === '') return [];
  const result = await query(TRIGRAM_SEARCH_SQL, [
    userId,
    trimmed,
    `%${escapeLikePattern(trimmed)}%`,
    clampLimit(options.limit),
  ]);
  return mapSearchRows(result.rows);
}

/**
 * Normalize a caller-supplied `types` filter into the canonical, de-duplicated type list.
 * An absent filter means ALL ten types; an unknown value is IGNORED (dropped), never an error -
 * so a filter made only of unknown values becomes the empty list (a valid "match nothing").
 */
export function normalizeSearchTypes(types: readonly string[] | undefined): SearchResultType[] {
  if (types === undefined) return [...SEARCH_RESULT_TYPES];
  return SEARCH_RESULT_TYPES.filter((type) => types.includes(type));
}

function emptyFacets(): SearchFacets {
  return Object.fromEntries(SEARCH_RESULT_TYPES.map((type) => [type, 0])) as SearchFacets;
}

/**
 * The `GET /api/search` path (checkbox 132): ranked results ACROSS all ten entity types plus
 * per-type facet counts, over the same v53/v57 trigram indexes as `searchLocal`. Two queries run
 * in parallel - the ranked page and the facet counts - and neither touches the network, so the
 * default search path has zero egress. A blank query short-circuits without a database call.
 */
export async function searchGlobal(
  userId: number,
  searchQuery: string,
  options: { limit?: number; types?: readonly string[] } = {},
): Promise<GlobalSearchResult> {
  const trimmed = searchQuery.trim();
  const limit = clampLimit(options.limit);
  const types = normalizeSearchTypes(options.types);
  if (trimmed === '') {
    return { results: [], facets: emptyFacets(), total: 0, limit, types };
  }
  const pattern = `%${escapeLikePattern(trimmed)}%`;
  const [hitsResult, facetResult] = await Promise.all([
    query(TRIGRAM_SEARCH_TYPED_SQL, [userId, trimmed, pattern, limit, types]),
    query(TRIGRAM_FACET_SQL, [userId, trimmed, pattern, types]),
  ]);
  const results = mapSearchRows(hitsResult.rows);
  const facets = emptyFacets();
  for (const row of facetResult.rows) {
    // Bind to a typed local BEFORE narrowing: `query()` returns `rows: any[]`, and a type guard
    // on an `any` PROPERTY access does not narrow the property expression, only a local variable.
    const ownerType: unknown = row?.owner_type;
    if (isSearchResultType(ownerType)) {
      facets[ownerType] = Number(row?.count ?? 0);
    }
  }
  const total = SEARCH_RESULT_TYPES.reduce((sum, type) => sum + facets[type], 0);
  return { results, facets, total, limit, types };
}

async function fetchSourceRows(
  userId: number,
  hits: Array<{ owner_type: SearchOwnerType; owner_id: number }>,
): Promise<Map<string, Record<string, unknown>>> {
  const grouped = new Map<SearchOwnerType, number[]>();
  for (const hit of hits) {
    const ids = grouped.get(hit.owner_type) ?? [];
    ids.push(hit.owner_id);
    grouped.set(hit.owner_type, ids);
  }
  const found = new Map<string, Record<string, unknown>>();
  for (const [ownerType, ids] of grouped) {
    const uniqueIds = [...new Set(ids)];
    const result = await query(
      `SELECT ${SOURCE_PROJECTIONS[ownerType]} FROM ${EMBED_SOURCES[ownerType].table} WHERE user_id = $1 AND id = ANY($2::int[])`,
      [userId, uniqueIds],
    );
    for (const row of result.rows) {
      // Task 161: hydrate the interaction summary decrypted (placeholder on failure).
      if (ownerType === 'interaction' && row.summary != null) {
        row.summary = decryptFieldValue(row.summary);
      }
      found.set(`${ownerType}:${Number(row.id)}`, row);
    }
  }
  return found;
}

/**
 * Cosine-ranked semantic search. `$2::vector` gets the embedded query, the database does
 * the ranking (`embedding <=> $2::vector ASC`), and every hit is hydrated with the explicit
 * safe projection of its source row. Throws `EmbeddingsDisabledError` when the feature is
 * off and `EmbeddingsError` for provider/config problems - the route maps both.
 */
export async function semanticSearch(
  userId: number,
  searchQuery: string,
  options: { limit?: number; embed?: EmbedTextsFn; env?: EmbeddingsEnv } = {},
): Promise<SemanticHit[]> {
  const env = options.env ?? process.env;
  const config = getEmbeddingsConfig(env);
  if (!config) throw new EmbeddingsDisabledError();
  const trimmed = searchQuery.trim();
  if (trimmed === '') return [];

  const embed = options.embed ?? ((texts: string[]) => embedTexts(texts, { env }));
  const vectors = await embed([trimmed]);
  const vector = vectors[0];
  if (!vector || vector.length === 0) {
    throw new EmbeddingsError('embeddings provider returned no vector for the query', 'EMBEDDINGS_PARSE');
  }
  assertEmbeddingDims(vector.length, config.model);

  const ranked = await query(SEMANTIC_RANK_SQL, [userId, toVectorLiteral(vector), clampLimit(options.limit)]);
  const hits = ranked.rows.flatMap((row) => {
    if (!isSearchOwnerType(row.owner_type)) return [];
    return [
      {
        owner_type: row.owner_type,
        owner_id: Number(row.owner_id),
        distance: Number(row.distance ?? Number.POSITIVE_INFINITY),
      },
    ];
  });
  const sourceRows = await fetchSourceRows(userId, hits);
  return hits.map((hit) => ({
    ...hit,
    row: sourceRows.get(`${hit.owner_type}:${hit.owner_id}`) ?? null,
  }));
}

async function embeddingsTableReady(): Promise<boolean> {
  const result = await query(`SELECT to_regclass('public.embeddings') AS table_name`);
  return result.rows[0]?.table_name != null;
}

function resolveBatchSize(configured: number | undefined, env: EmbeddingsEnv): number {
  const raw = configured ?? Number(env.EMBEDDINGS_BATCH_SIZE);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_EMBEDDINGS_BATCH_SIZE;
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_EMBEDDINGS_BATCH_SIZE);
}

/**
 * Nightly bounded indexing. With the feature off this is a pure no-op: no query, no
 * provider call. With it on, at most `batchSize` rows (default 25, max 200) are examined;
 * rows whose `content_hash` already matches are skipped WITHOUT calling the embedder, so
 * an unchanged row is never re-embedded. A provider outage is reported as `failed` +
 * `error` instead of aborting the caller's nightly job.
 */
export async function indexEmbeddingsBatch(
  options: IndexEmbeddingsOptions = {},
): Promise<IndexEmbeddingsResult> {
  const env = options.env ?? process.env;
  const result: IndexEmbeddingsResult = {
    enabled: false,
    tableReady: false,
    scanned: 0,
    embedded: 0,
    skipped: 0,
    failed: 0,
  };
  if (!isEmbeddingsEnabled(env)) return result;
  result.enabled = true;
  const config = getEmbeddingsConfig(env);
  if (!config) return result;
  if (!(await embeddingsTableReady())) return result;
  result.tableReady = true;

  const embed = options.embed ?? ((texts: string[]) => embedTexts(texts, { env }));
  let remaining = resolveBatchSize(options.batchSize, env);

  for (const ownerType of SEARCH_OWNER_TYPES) {
    if (remaining <= 0) break;
    const source = EMBED_SOURCES[ownerType];
    const rowsResult = await query(
      `SELECT ${source.select} FROM ${source.table} WHERE user_id IS NOT NULL ORDER BY id DESC LIMIT $1`,
      [remaining],
    );
    const rows = rowsResult.rows;
    result.scanned += rows.length;
    if (rows.length === 0) continue;
    remaining -= rows.length;

    const ids = rows.map((row) => Number(row.id));
    const existing = await query(
      `SELECT owner_id, content_hash FROM embeddings WHERE owner_type = $1 AND model = $2 AND owner_id = ANY($3::int[])`,
      [ownerType, config.model, ids],
    );
    const knownHashes = new Map<number, string>(
      existing.rows.map((row) => [Number(row.owner_id), String(row.content_hash)]),
    );

    const pending: Array<{ userId: number; ownerId: number; content: string; hash: string }> = [];
    for (const row of rows) {
      const ownerId = Number(row.id);
      const content = extractSearchContent(ownerType, row);
      const hash = embeddingsContentHash(content);
      if (knownHashes.get(ownerId) === hash) {
        result.skipped += 1;
        continue;
      }
      pending.push({ userId: Number(row.user_id), ownerId, content, hash });
    }
    if (pending.length === 0) continue;

    let vectors: number[][];
    try {
      vectors = await embed(pending.map((item) => item.content));
    } catch (error) {
      result.failed += pending.length;
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
    if (vectors.length !== pending.length) {
      result.failed += pending.length;
      result.error = `embeddings provider returned ${vectors.length} vectors for ${pending.length} inputs`;
      return result;
    }
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const vector = vectors[index];
      assertEmbeddingDims(vector.length, config.model);
      await query(EMBEDDING_UPSERT_SQL, [
        item.userId,
        ownerType,
        item.ownerId,
        config.model,
        vector.length,
        toVectorLiteral(vector),
        item.hash,
      ]);
      result.embedded += 1;
    }
  }
  return result;
}

/**
 * Deletes embeddings whose owner row no longer exists. The polymorphic `owner_id` cannot
 * carry a foreign key, so the nightly job is the authoritative delete path (user deletion
 * is covered separately by the `user_id` FK cascade).
 */
export async function cleanupOrphanEmbeddings(
  options: { env?: EmbeddingsEnv } = {},
): Promise<CleanupEmbeddingsResult> {
  const env = options.env ?? process.env;
  if (!isEmbeddingsEnabled(env)) return { enabled: false, removed: 0 };
  if (!(await embeddingsTableReady())) return { enabled: true, removed: 0 };
  let removed = 0;
  for (const ownerType of SEARCH_OWNER_TYPES) {
    const result = await query(
      `DELETE FROM embeddings WHERE owner_type = $1 AND NOT EXISTS (SELECT 1 FROM ${EMBED_SOURCES[ownerType].table} t WHERE t.id = embeddings.owner_id)`,
      [ownerType],
    );
    removed += result.rowCount ?? 0;
  }
  return { enabled: true, removed };
}
