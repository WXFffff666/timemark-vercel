import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Todo 68 acceptance (plan checkbox 68): the household-profile migration is
 * registered at version 41 - NOT 39 as the plan text claimed, because 39 (CRM)
 * and 40 (habits) were already taken when this landed (40 is the previous max
 * in the source list). It is appended after 40, picked up by the runner in
 * order, idempotent (every DDL statement is IF NOT EXISTS/existence-guarded)
 * and purely additive: the only ALTERs are ADD COLUMN IF NOT EXISTS and the
 * only data writes live in postMigrate (guarded default-`我` INSERT + NULL-only
 * backfill).
 *
 * The live behaviour (backfill counts, double-run "no second 我", ON DELETE
 * SET NULL) is additionally proven against PGlite in the live harness.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const SCHEMA_SQL = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');

const PROFILES_MIGRATION = 'profiles_v41';

const PROFILE_COLUMN_TABLES = [
  'events',
  'fixed_contacts',
  'expiry_items',
  'inventory_items',
  'maintenance_plans',
  'documents',
  'habits',
];

const REQUIRED_V41_MARKERS = [
  'CREATE TABLE IF NOT EXISTS profiles',
  'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE',
  'name TEXT NOT NULL',
  'relation TEXT',
  "CHECK (kind IN ('self', 'family', 'pet'))",
  'birth_date DATE',
  'lunar_birthday JSONB',
  'avatar_emoji TEXT',
  'timezone TEXT',
  'sort_order INTEGER NOT NULL DEFAULT 0',
  'is_active BOOLEAN NOT NULL DEFAULT TRUE',
  'CREATE UNIQUE INDEX IF NOT EXISTS uniq_profiles_user_self ON profiles(user_id) WHERE kind = \'self\'',
  "IF to_regclass('medications') IS NOT NULL",
  'CREATE INDEX IF NOT EXISTS idx_events_user_profile ON events(user_id, profile_id)',
  'CREATE INDEX IF NOT EXISTS idx_fixed_contacts_user_profile ON fixed_contacts(user_id, profile_id)',
  'CREATE INDEX IF NOT EXISTS idx_expiry_items_user_profile ON expiry_items(user_id, profile_id)',
  'CREATE INDEX IF NOT EXISTS idx_inventory_items_user_profile ON inventory_items(user_id, profile_id)',
  'CREATE INDEX IF NOT EXISTS idx_maintenance_plans_user_profile ON maintenance_plans(user_id, profile_id)',
  'CREATE INDEX IF NOT EXISTS idx_documents_user_profile ON documents(user_id, profile_id)',
  'CREATE INDEX IF NOT EXISTS idx_habits_user_profile ON habits(user_id, profile_id)',
];

function callsMatching(marker: string): string[] {
  return mockQuery.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes(marker));
}

function allSql(): string[] {
  return mockQuery.mock.calls.map(([sql]) => sql);
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

describe('migration v41 registration (todo 68)', () => {
  it('applies v41 when the recorded max version is 40 - proving the previous max was 40', async () => {
    await applyIncrementalMigrations(40);

    const sqls = allSql();
    const v41Index = sqls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS profiles'));
    expect(v41Index).toBeGreaterThanOrEqual(0);

    const v41Sql = sqls[v41Index];
    for (const marker of REQUIRED_V41_MARKERS) {
      expect(v41Sql, `v41 missing ${marker}`).toContain(marker);
    }
    for (const table of PROFILE_COLUMN_TABLES) {
      expect(v41Sql, `v41 missing ADD COLUMN for ${table}`).toContain(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL`,
      );
    }

    const inserts = versionInserts();
    expect(inserts).toContain(41);
    expect(inserts).not.toContain(40);
  });

  it('applies only v41 when the recorded max version is 40 (no earlier migration re-runs)', async () => {
    await applyIncrementalMigrations(40);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS habit_logs')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS habits')).toHaveLength(0);
    expect(versionInserts()).toContain(41);
  });

  it('stale-state: a recorded v41 row makes the runner skip v41 (no re-apply, no duplicate write)', async () => {
    await applyIncrementalMigrations(41);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS profiles')).toHaveLength(0);
    expect(callsMatching('SET profile_id = p.id')).toHaveLength(0);
    expect(versionInserts()).not.toContain(41);
  });

  it('does not record v41 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS profiles')) {
        throw new Error('permission denied for table profiles');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(40);

    expect(versionInserts()).not.toContain(41);
  });

  it('postMigrate creates the default `我` self profile and backfills all 7 profile-aware tables', async () => {
    await applyIncrementalMigrations(40);

    const profileInserts = callsMatching('INSERT INTO profiles');
    expect(profileInserts).toHaveLength(1);
    expect(profileInserts[0]).toContain("'我'");
    expect(profileInserts[0]).toContain("'self'");
    // The NOT EXISTS guard is what makes a re-run never create a second 我.
    expect(profileInserts[0]).toContain('NOT EXISTS');

    const backfills = callsMatching('SET profile_id = p.id');
    expect(backfills).toHaveLength(PROFILE_COLUMN_TABLES.length);
    for (const table of PROFILE_COLUMN_TABLES) {
      const update = backfills.find((sql) => sql.includes(`UPDATE ${table} `));
      expect(update, `no backfill for ${table}`).toBeDefined();
      // NULL-only: re-running never overwrites an explicit assignment.
      expect(update).toContain('t.profile_id IS NULL');
      expect(update).toContain("p.kind = 'self'");
    }
  });

  it('skipping postMigrate would leave the backfill undone - the SQL alone writes no profile data', async () => {
    // Observable proof: with the mock recording every call, the profile INSERT and
    // the 7 backfill UPDATEs appear exactly once per apply, and they are made by the
    // postMigrate step (they are not part of the DDL string).
    await applyIncrementalMigrations(40);

    const v41Sql = callsMatching('CREATE TABLE IF NOT EXISTS profiles')[0];
    expect(v41Sql).not.toContain('INSERT INTO profiles');
    expect(v41Sql).not.toContain('SET profile_id = p.id');

    expect(callsMatching('INSERT INTO profiles')).toHaveLength(1);
    expect(callsMatching('SET profile_id = p.id')).toHaveLength(7);
  });

  it('keeps every v41 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(40);
    const [v41Sql] = callsMatching('CREATE TABLE IF NOT EXISTS profiles');

    expect(v41Sql).not.toMatch(/\bCREATE TABLE(?! IF NOT EXISTS)/);
    expect(v41Sql).not.toMatch(/\bCREATE INDEX(?! IF NOT EXISTS)/);
    expect(v41Sql).not.toMatch(/\bCREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
    expect(v41Sql).not.toMatch(/\bDROP\b/i);
    expect(v41Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v41Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    // Every ADD COLUMN is IF NOT EXISTS-guarded (7 tables + the guarded medications block).
    const addColumnStatements = v41Sql.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(addColumnStatements).toHaveLength(8);
    // profile_id is nullable everywhere - future imports may omit it.
    expect(v41Sql).not.toMatch(/profile_id INTEGER NOT NULL/);
    // No organisations / teams / seats: personal household model only.
    expect(v41Sql).not.toMatch(/\borg(anis|aniz)?ation/i);
    expect(v41Sql).not.toMatch(/\bteams?\b/i);
    expect(v41Sql).not.toMatch(/\bseats?\b/i);
  });

  it('registers v41 once, ascending, immediately after 40 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(40);
    expect(versions).toContain(41);
    expect(versions.filter((v) => v === 41)).toHaveLength(1);
    expect(versions.indexOf(41)).toBe(versions.indexOf(40) + 1);
    expect(versions[versions.length - 1]).toBeGreaterThanOrEqual(41);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${PROFILES_MIGRATION}'`);
  });

  it('mirrors profiles and the profile_id columns into shared/src/schema.pg.sql', () => {
    for (const marker of [
      'CREATE TABLE IF NOT EXISTS profiles',
      "CHECK (kind IN ('self', 'family', 'pet'))",
      'uniq_profiles_user_self',
      'idx_events_user_profile',
      'idx_fixed_contacts_user_profile',
      'backend/src/db/migrate.ts v41',
    ]) {
      expect(SCHEMA_SQL, `schema.pg.sql missing ${marker}`).toContain(marker);
    }
    const eventsBlock = SCHEMA_SQL.slice(SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS events')).split(');')[0];
    expect(eventsBlock).toContain('profile_id INTEGER');
    const contactsBlock = SCHEMA_SQL.slice(SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS fixed_contacts')).split(');')[0];
    expect(contactsBlock).toContain('profile_id INTEGER');
  });
});
