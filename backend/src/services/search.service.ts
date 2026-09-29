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

export const SEARCH_MAX_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;
export const DEFAULT_EMBEDDINGS_BATCH_SIZE = 25;
export const MAX_EMBEDDINGS_BATCH_SIZE = 200;

export interface SearchHit {
  owner_type: SearchOwnerType;
  owner_id: number;
  title: string;
  subtitle: string | null;
  rank: number;
}

export interface SemanticHit {
  owner_type: SearchOwnerType;
  owner_id: number;
  distance: number;
  row: Record<string, unknown> | null;
}

/**
 * The default search. `$1` user, `$2` raw query (ranking), `$3` escaped `%query%` pattern
 * (the only shape a GIN trigram index can serve), `$4` limit. Every `ILIKE` column below
 * has a matching `gin_trgm_ops` index in migration v53, including the `(tags::text)`
 * expression index - the expression must stay byte-identical to the index definition.
 */
export const TRIGRAM_SEARCH_SQL = `
WITH hits AS (
  SELECT 'event' AS owner_type, id AS owner_id, name AS title, type AS subtitle,
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
)
SELECT owner_type, owner_id, title, subtitle, rank
FROM hits
ORDER BY rank DESC, owner_id ASC
LIMIT $4`;

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

function fieldText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(' ');
  return JSON.stringify(value);
}

/** Deterministic text for one owner row: only the whitelisted, non-secret fields. */
export function extractSearchContent(ownerType: SearchOwnerType, row: Record<string, unknown>): string {
  return CONTENT_FIELDS[ownerType]
    .map((field) => fieldText(row[field]).trim())
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
  return result.rows.flatMap((row) => {
    if (!isSearchOwnerType(row.owner_type)) return [];
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
