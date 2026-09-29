import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 106 acceptance: migration v53 adds the default `pg_trgm` search path and the
 * guarded opt-in pgvector `embeddings` table. The real chain max before this lane was 52
 * (`user_patterns_v52`, verified by reading migrate.ts immediately before appending), so
 * v53 is appended immediately after it.
 *
 * v53 is purely additive + idempotent: CREATE EXTENSION/TABLE/INDEX IF NOT EXISTS plus a
 * DO-block guard around pgvector. No ALTER of existing tables, no backfill, no data
 * migration. The executed engine-level proof (PGlite: pg_trgm GIN present, Chinese EXPLAIN
 * uses the index, guard degrades cleanly) lives in the out-of-repo harness
 * `%TEMP%/opencode/wave13-106-search/probe-*.mjs`; this file pins the shipped DDL and its
 * pairing with the SQL the service actually executes.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';
import { SEMANTIC_RANK_SQL, TRIGRAM_SEARCH_SQL } from '../services/search.service.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const MIGRATION_NAME = 'search_trgm_embeddings_v53';

function migrationSql(marker: string): string {
  const nameIndex = MIGRATE_SOURCE.indexOf(`name: '${marker}'`);
  if (nameIndex < 0) throw new Error(`migration ${marker} not found in migrate.ts`);
  const sqlStart = MIGRATE_SOURCE.indexOf('sql: `', nameIndex);
  const sqlEnd = MIGRATE_SOURCE.indexOf('`,', sqlStart);
  return MIGRATE_SOURCE.slice(sqlStart + 'sql: `'.length, sqlEnd);
}

const V53_SQL = migrationSql(MIGRATION_NAME);

/**
 * Every searchable text column and the ILIKE expression the service runs against it.
 * The expression string must appear BOTH in the v53 GIN DDL and in TRIGRAM_SEARCH_SQL -
 * a drift on either side (column renamed, index dropped, expression changed) fails here.
 */
const TRIGRAM_PAIRS: Array<{ table: string; indexExpr: string; ilikePattern: RegExp }> = [
  { table: 'events', indexExpr: 'name', ilikePattern: /\bname ILIKE \$3/ },
  { table: 'events', indexExpr: 'person_name', ilikePattern: /\bperson_name ILIKE \$3/ },
  { table: 'events', indexExpr: '(tags::text)', ilikePattern: /\btags::text ILIKE \$3/ },
  { table: 'fixed_contacts', indexExpr: 'name', ilikePattern: /\bname ILIKE \$3/ },
  { table: 'fixed_contacts', indexExpr: 'nickname', ilikePattern: /\bnickname ILIKE \$3/ },
  { table: 'fixed_contacts', indexExpr: 'notes', ilikePattern: /\bnotes ILIKE \$3/ },
  { table: 'fixed_contacts', indexExpr: 'relationship', ilikePattern: /\brelationship ILIKE \$3/ },
  { table: 'interactions', indexExpr: 'summary', ilikePattern: /\bsummary ILIKE \$3/ },
  { table: 'documents', indexExpr: 'title', ilikePattern: /\btitle ILIKE \$3/ },
  { table: 'documents', indexExpr: 'issuer', ilikePattern: /\bissuer ILIKE \$3/ },
  { table: 'expiry_items', indexExpr: 'title', ilikePattern: /\btitle ILIKE \$3/ },
  { table: 'expiry_items', indexExpr: 'vendor', ilikePattern: /\bvendor ILIKE \$3/ },
  { table: 'expiry_items', indexExpr: 'notes', ilikePattern: /\bnotes ILIKE \$3/ },
];

function callsMatching(marker: string): string[] {
  return mockQuery.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes(marker));
}

function versionInserts(): unknown[] {
  return mockQuery.mock.calls
    .filter(([sql]) => sql.includes('INSERT INTO schema_version'))
    .map(([, params]) => params?.[0]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('migration v53 registration (checkbox 106)', () => {
  it('applies v53 when the recorded max version is 52 - proving the previous max was 52', async () => {
    await applyIncrementalMigrations(52);
    const [v53Sql] = callsMatching('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(v53Sql).toBeDefined();
    expect(v53Sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(callsMatching('gin_trgm_ops')).toHaveLength(1);
    expect(callsMatching('user_patterns')).toHaveLength(0);
    expect(versionInserts()).toContain(53);
    expect(versionInserts()).not.toContain(52);
  });

  it('is idempotent: a recorded v53 row makes the runner skip v53 entirely', async () => {
    await applyIncrementalMigrations(53);
    expect(callsMatching('gin_trgm_ops')).toHaveLength(0);
    expect(callsMatching('embeddings')).toHaveLength(0);
    expect(versionInserts()).toEqual([54]);
  });

  it('does not record v53 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('gin_trgm_ops')) throw new Error('permission denied for table events');
      return { rows: [], rowCount: 0 };
    });
    await applyIncrementalMigrations(52);
    expect(versionInserts()).not.toContain(53);
  });

  it('registers v53 once, ascending, immediately after 52 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions.filter((v) => v === 53)).toHaveLength(1);
    expect(versions.indexOf(53)).toBe(versions.indexOf(52) + 1);
    expect(versions[versions.length - 1]).toBe(54);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${MIGRATION_NAME}'`);
    // Migrations 1-52 are untouched.
    expect(MIGRATE_SOURCE).toContain("name: 'user_patterns_v52'");
    expect(MIGRATE_SOURCE).toContain("name: 'event_snoozed_until_v51'");
  });

  it('creates one GIN trigram index per searchable column and pairs with the search SQL', () => {
    expect(TRIGRAM_PAIRS).toHaveLength(13);
    for (const pair of TRIGRAM_PAIRS) {
      const ddl = `ON ${pair.table} USING GIN (${pair.indexExpr} gin_trgm_ops)`;
      expect(V53_SQL, `missing DDL: ${ddl}`).toContain(ddl);
      expect(TRIGRAM_SEARCH_SQL, `search SQL does not search ${pair.table}.${pair.indexExpr}`).toMatch(
        pair.ilikePattern,
      );
    }
    expect(V53_SQL.match(/USING GIN \(/g)).toHaveLength(13);
    expect(V53_SQL.match(/gin_trgm_ops/g)).toHaveLength(13);
    expect(V53_SQL.match(/CREATE INDEX IF NOT EXISTS \w+_trgm/g)).toHaveLength(13);
    // The search query itself lives in the service; its index-usable shape is pinned here.
    expect(TRIGRAM_SEARCH_SQL).toContain('ORDER BY rank DESC');
    expect(TRIGRAM_SEARCH_SQL).toContain('LIMIT $4');
    expect(TRIGRAM_SEARCH_SQL).toContain('ILIKE $3');
  });

  it('is re-runnable: every statement is IF NOT EXISTS and the vector block is guarded', () => {
    expect(V53_SQL).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(V53_SQL).toContain('CREATE TABLE IF NOT EXISTS embeddings');
    expect(V53_SQL).not.toMatch(/CREATE TABLE\s+(?!IF NOT EXISTS)/i);
    expect(V53_SQL).not.toMatch(/CREATE INDEX\s+(?!IF NOT EXISTS)/i);
    // 13 trigram indexes + 2 embeddings indexes, every one created re-runnably.
    expect(V53_SQL.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(15);
    expect(V53_SQL.match(/IF NOT EXISTS/g)?.length).toBeGreaterThanOrEqual(15);
  });

  it('guards the pgvector block so a database without it keeps the trigram path', () => {
    const vectorCreate = V53_SQL.indexOf('CREATE EXTENSION IF NOT EXISTS vector');
    const exceptionHandler = V53_SQL.indexOf('EXCEPTION WHEN OTHERS');
    const tableBranch = V53_SQL.indexOf("IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')");
    const tableCreate = V53_SQL.indexOf('CREATE TABLE IF NOT EXISTS embeddings');
    expect(vectorCreate).toBeGreaterThanOrEqual(0);
    expect(exceptionHandler).toBeGreaterThan(vectorCreate);
    expect(tableBranch).toBeGreaterThan(exceptionHandler);
    expect(tableCreate).toBeGreaterThan(tableBranch);
    // The extension creation itself is inside the guarded EXECUTE, not raw top-level SQL.
    expect(V53_SQL).toContain("EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector'");
    // Degrade notice mentions that trigram search stays available.
    expect(V53_SQL).toContain('trigram search unaffected');
  });

  it('embeddings DDL rejects an oversized model config at the column level', () => {
    expect(V53_SQL).toContain('owner_type TEXT NOT NULL CHECK (owner_type IN');
    expect(V53_SQL).toContain('dims INTEGER NOT NULL CHECK (dims > 0 AND dims <= 2048)');
    expect(V53_SQL).toContain('embedding vector NOT NULL CHECK (vector_dims(embedding) <= 2048)');
    expect(V53_SQL).toContain('UNIQUE (owner_type, owner_id, model)');
    expect(V53_SQL).toContain('user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE');
  });

  it('is additive-only and never touches secrets or attachment bytes', () => {
    expect(V53_SQL).not.toMatch(/\bDROP\b/i);
    expect(V53_SQL).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(V53_SQL).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(V53_SQL).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(V53_SQL).not.toContain('document_number_encrypted');
    expect(V53_SQL).not.toContain('attachment');
  });

  it('delegates semantic ranking to pgvector cosine distance', () => {
    expect(SEMANTIC_RANK_SQL).toContain('embedding <=> $2::vector');
    expect(SEMANTIC_RANK_SQL).toContain('ORDER BY embedding <=> $2::vector ASC');
    expect(SEMANTIC_RANK_SQL).toContain('WHERE user_id = $1');
    expect(TRIGRAM_SEARCH_SQL).not.toContain('<=>');
  });
});
