import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 132 acceptance: migration v57 completes the default `pg_trgm` search path for the
 * five entity types the earlier trigram landings did not cover.
 *
 * ENUMERATION (read from migrate.ts + schema.pg.sql immediately before appending): v33 created
 * pg_trgm + events(name, person_name, tags) + fixed_contacts(name, nickname, notes) +
 * expiry_items(title, vendor); v34 re-created the expiry pair; v35 created
 * `idx_inventory_items_name_trgm`; v38/v53 created documents(title, issuer); v53 completed
 * fixed_contacts(relationship) + interactions(summary) + expiry_items(notes). `inventory_items.name`
 * therefore ALREADY had a trigram index and v57 deliberately does NOT re-issue it.
 *
 * The real max before this lane was 56 (`agent_confirmations_v56`, verified by reading migrate.ts
 * immediately before appending), so v57 is appended immediately after it. v57 is purely additive
 * + idempotent: CREATE EXTENSION/INDEX IF NOT EXISTS only, no ALTER of existing tables, no
 * backfill, no data migration. Re-running v57 (or applying on top of a recorded 57) is a no-op,
 * and a failing v57 must not be recorded so the next cold start retries.
 *
 * EXPLAIN note: a unit-level PGlite `EXPLAIN` over a tiny one-row fixture is misleading - the
 * planner picks a seq scan for a handful of rows regardless of the index - so the engine-level
 * proof that `鑻规灉` uses `Bitmap Index Scan on idx_*_trgm` lives in the out-of-repo harness
 * `%TEMP%/opencode/wave16-132-search/probe-explain.mjs` with `enable_seqscan=off` and a
 * multi-row seed. Here the shipped DDL and the exact index-usable SQL shape the service emits
 * are pinned, which is the honest, engine-independent assertion.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';
import { TRIGRAM_FACET_SQL, TRIGRAM_SEARCH_SQL, TRIGRAM_SEARCH_TYPED_SQL } from '../services/search.service.js';
import { registeredMigrationVersions } from './helpers.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const MIGRATION_NAME = 'search_trgm_remaining_v57';

function migrationSql(marker: string): string {
  const nameIndex = MIGRATE_SOURCE.indexOf(`name: '${marker}'`);
  if (nameIndex < 0) throw new Error(`migration ${marker} not found in migrate.ts`);
  const sqlStart = MIGRATE_SOURCE.indexOf('sql: `', nameIndex);
  const sqlEnd = MIGRATE_SOURCE.indexOf('`,', sqlStart);
  return MIGRATE_SOURCE.slice(sqlStart + 'sql: `'.length, sqlEnd);
}

const V57_SQL = migrationSql(MIGRATION_NAME);

/**
 * The ten columns migration v57 indexes and the ILIKE the shared `hits` CTE runs against each.
 * The DDL string must appear in V57_SQL AND the column must be searched in TRIGRAM_SEARCH_SQL -
 * a drift on either side (column renamed, index dropped, expression changed) fails here.
 */
const V57_NEW_INDEXES: Array<{ table: string; column: string }> = [
  { table: 'inventory_items', column: 'location' },
  { table: 'inventory_items', column: 'notes' },
  { table: 'maintenance_plans', column: 'asset_name' },
  { table: 'maintenance_plans', column: 'notes' },
  { table: 'habits', column: 'name' },
  { table: 'goals', column: 'title' },
  { table: 'goals', column: 'description' },
  { table: 'inbox_messages', column: 'title' },
  { table: 'inbox_messages', column: 'body' },
  { table: 'inbox_messages', column: 'sender_label' },
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

describe('migration v57 registration (checkbox 132)', () => {
  it('applies v57 when the recorded max version is 56 - proving the previous max was 56', async () => {
    await applyIncrementalMigrations(56);
    const [v57Sql] = callsMatching('idx_inbox_messages_body_trgm');
    expect(v57Sql).toBeDefined();
    expect(v57Sql).toContain('idx_inbox_messages_body_trgm');
    // v56 and earlier must not re-run on top of a recorded 56.
    expect(callsMatching('agent_confirmations')).toHaveLength(0);
    expect(callsMatching('idx_events_name_trgm')).toHaveLength(0);
    expect(versionInserts()).toContain(57);
    expect(versionInserts()).not.toContain(56);
  });

  it('is idempotent: a recorded v57 row makes the runner skip v57 entirely', async () => {
    await applyIncrementalMigrations(57);
    expect(callsMatching('idx_inbox_messages_body_trgm')).toHaveLength(0);
    expect(callsMatching('gin_trgm_ops')).toHaveLength(0);
    expect(versionInserts()).toEqual([58, 59, 60, 61, 62, 63, 64, 65, 67, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81]);
  });

  it('does not record v57 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('idx_goals_description_trgm')) throw new Error('permission denied for table goals');
      return { rows: [], rowCount: 0 };
    });
    await applyIncrementalMigrations(56);
    expect(versionInserts()).not.toContain(57);
  });

  it('registers v57 once, ascending, immediately after 56 as the tail of the source-of-truth list', () => {
    const versions = registeredMigrationVersions(MIGRATE_SOURCE);
    expect(versions.filter((v) => v === 57)).toHaveLength(1);
    expect(versions.indexOf(57)).toBe(versions.indexOf(56) + 1);
    expect(versions[versions.length - 1]).toBe(81);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${MIGRATION_NAME}'`);
    // Migrations 1-56 are untouched.
    expect(MIGRATE_SOURCE).toContain("name: 'agent_confirmations_v56'");
    expect(MIGRATE_SOURCE).toContain("name: 'search_trgm_embeddings_v53'");
  });

  it('creates one GIN trigram index per newly covered column and pairs with the search SQL', () => {
    expect(V57_NEW_INDEXES).toHaveLength(10);
    for (const { table, column } of V57_NEW_INDEXES) {
      const ddl = `CREATE INDEX IF NOT EXISTS idx_${table}_${column}_trgm ON ${table} USING GIN (${column} gin_trgm_ops)`;
      expect(V57_SQL, `missing DDL: ${ddl}`).toContain(ddl);
      expect(V57_SQL).toContain(`ON ${table} USING GIN (${column} gin_trgm_ops)`);
      expect(TRIGRAM_SEARCH_SQL, `search SQL does not search ${table}.${column}`).toContain(`${column} ILIKE $3`);
    }
    expect(V57_SQL.match(/USING GIN \(/g)).toHaveLength(10);
    expect(V57_SQL.match(/gin_trgm_ops/g)).toHaveLength(10);
    expect(V57_SQL.match(/CREATE INDEX IF NOT EXISTS \w+_trgm/g)).toHaveLength(10);
  });

  it('does not re-issue the already-covered inventory name index (enumeration guard)', () => {
    // `idx_inventory_items_name_trgm` was created by v35; v57 must add only the missing columns.
    expect(V57_SQL).not.toContain('idx_inventory_items_name_trgm');
    expect(V57_SQL).not.toContain('idx_events_name_trgm');
    expect(V57_SQL).not.toContain('idx_interactions_summary_trgm');
    expect(V57_SQL).toContain('idx_inventory_items_location_trgm');
    expect(V57_SQL).toContain('idx_inventory_items_notes_trgm');
  });

  it('covers all ten result tables in the search SQL (five v53 types + five v57 types)', () => {
    for (const table of [
      'events',
      'fixed_contacts',
      'interactions',
      'documents',
      'expiry_items',
      'inventory_items',
      'maintenance_plans',
      'habits',
      'goals',
      'inbox_messages',
    ]) {
      expect(TRIGRAM_SEARCH_SQL, `search SQL is missing FROM ${table}`).toContain(`FROM ${table}`);
    }
    expect(TRIGRAM_SEARCH_SQL.match(/UNION ALL/g)).toHaveLength(9);
  });

  it('is re-runnable: every statement is IF NOT EXISTS and additive-only', () => {
    expect(V57_SQL).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(V57_SQL).not.toMatch(/CREATE TABLE\s+(?!IF NOT EXISTS)/i);
    expect(V57_SQL).not.toMatch(/CREATE INDEX\s+(?!IF NOT EXISTS)/i);
    expect(V57_SQL).not.toMatch(/\bDROP\b/i);
    expect(V57_SQL).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(V57_SQL).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(V57_SQL).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(V57_SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(V57_SQL.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(10);
  });

  it('documents the GIN access-path shape: the typed and facet queries stay index-usable', () => {
    // The typed page and the facet count both filter on the concrete type list and both still
    // carry the ILIKE/similarity CTE, so per-entity trigram indexes remain the access path.
    expect(TRIGRAM_SEARCH_TYPED_SQL).toContain('WITH hits AS');
    expect(TRIGRAM_SEARCH_TYPED_SQL).toContain('owner_type = ANY($5::text[])');
    expect(TRIGRAM_SEARCH_TYPED_SQL).toContain('ILIKE $3');
    expect(TRIGRAM_SEARCH_TYPED_SQL).toContain('ORDER BY rank DESC');
    expect(TRIGRAM_SEARCH_TYPED_SQL).toContain('LIMIT $4');
    expect(TRIGRAM_SEARCH_TYPED_SQL).not.toContain('<=>');

    expect(TRIGRAM_FACET_SQL).toContain('WITH hits AS');
    expect(TRIGRAM_FACET_SQL).toContain('owner_type = ANY($4::text[])');
    expect(TRIGRAM_FACET_SQL).toContain('COUNT(*)::int AS count');
    expect(TRIGRAM_FACET_SQL).toContain('GROUP BY owner_type');
    // The default (untyped) page stays at exactly four parameters: $1 user, $2 raw query,
    // $3 escaped pattern, $4 limit - nothing more.
    expect(TRIGRAM_SEARCH_SQL).toContain('LIMIT $4');
    expect(TRIGRAM_SEARCH_SQL).not.toContain('$5');
  });
});
