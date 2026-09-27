import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Todo 64 acceptance (plan checkbox 64): the habits migration is registered at
 * version 40 - NOT 38 as the plan text claimed, because 38 (documents) and 39
 * (CRM interactions/cadence) were already taken when this landed (v39 is the
 * current max in the source list). It is appended after 39, picked up by the
 * runner in order, idempotent (IF NOT EXISTS everywhere) and purely additive:
 * the only ALTER is `ADD COLUMN IF NOT EXISTS` on user_configs.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const SCHEMA_SQL = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');

const HABITS_MIGRATION = 'habits_v40';

const REQUIRED_V40_MARKERS = [
  'CREATE TABLE IF NOT EXISTS habits',
  'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE',
  'profile_id INTEGER',
  'target_per_period INTEGER NOT NULL DEFAULT 1 CHECK (target_per_period >= 1)',
  "CHECK (period IN ('day', 'week'))",
  'schedule_days INTEGER[]',
  'reminder_times TEXT[]',
  'CREATE TABLE IF NOT EXISTS habit_logs',
  'logged_on DATE NOT NULL',
  'count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1)',
  'UNIQUE (habit_id, logged_on)',
  'idx_habit_logs_habit_date',
  'idx_habit_logs_user_date',
  "ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS habit_streak_nudge_hour TEXT DEFAULT '20:00'",
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

describe('migration v40 registration (todo 64)', () => {
  it('applies v39 then v40 when the recorded max version is 38 - proving the previous max was 39', async () => {
    await applyIncrementalMigrations(38);

    const sqls = allSql();
    const v39Index = sqls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS interactions'));
    const v40Index = sqls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS habits'));
    expect(v39Index).toBeGreaterThanOrEqual(0);
    expect(v40Index).toBeGreaterThan(v39Index);

    const v40Sql = sqls[v40Index];
    for (const marker of REQUIRED_V40_MARKERS) {
      expect(v40Sql, `v40 missing ${marker}`).toContain(marker);
    }

    const inserts = versionInserts();
    expect(inserts).toContain(39);
    // v40 must still be applied immediately after 39; later migrations (41+) follow.
    expect(inserts.indexOf(40)).toBeGreaterThan(inserts.indexOf(39));
    expect(inserts.filter((v) => v === 40)).toHaveLength(1);
  });

  it('applies only v40 when the recorded max version is 39', async () => {
    await applyIncrementalMigrations(39);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS interactions')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS habits')).toHaveLength(1);
    expect(versionInserts()[0]).toBe(40);
  });

  it('stale-state: a recorded v40 row makes the runner skip v40 (no re-apply, no duplicate write)', async () => {
    // The runner gates with `currentVersion < migration.version` and only writes the
    // version row after success; a stale/enlarged schema_version cannot skip v40.
    await applyIncrementalMigrations(40);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS habits')).toHaveLength(0);
    expect(versionInserts()).not.toContain(40);
  });

  it('does not record v40 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS habit_logs')) {
        throw new Error('permission denied for table habit_logs');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(39);

    expect(versionInserts()).not.toContain(40);
  });

  it('keeps every v40 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(39);
    const [v40Sql] = callsMatching('CREATE TABLE IF NOT EXISTS habits');

    expect(v40Sql).not.toMatch(/\bCREATE TABLE(?! IF NOT EXISTS)/);
    expect(v40Sql).not.toMatch(/\bCREATE INDEX(?! IF NOT EXISTS)/);
    expect(v40Sql).not.toMatch(/\bCREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
    expect(v40Sql).not.toMatch(/\bDROP\b/i);
    expect(v40Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v40Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v40Sql).not.toMatch(/\bUPDATE\s+/i);
    // Exactly one ALTER, and it is additive.
    const alterStatements = v40Sql.match(/ALTER TABLE[^;]+;/g) ?? [];
    expect(alterStatements).toHaveLength(1);
    expect(alterStatements[0]).toMatch(/^ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS /);
    // habits are their own concept: nothing from todo_completions (v29) is reused.
    expect(v40Sql).not.toContain('todo_completions');
    expect(v40Sql).not.toContain('event_id');
  });

  it('registers v40 once, ascending, immediately after 39 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(39);
    expect(versions).toContain(40);
    expect(versions.filter((v) => v === 40)).toHaveLength(1);
    expect(versions.indexOf(40)).toBe(versions.indexOf(39) + 1);
    // Later migrations (41+) may follow; 40 must remain the version right after 39.
    expect(versions[versions.length - 1]).toBeGreaterThanOrEqual(40);
    // The plan text claimed version 38; the real previous max was 39.
    expect(versions.filter((v) => v === 38)).toHaveLength(1);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${HABITS_MIGRATION}'`);
  });

  it('mirrors the habit tables and the nudge-hour column into shared/src/schema.pg.sql', () => {
    const mirrorMarkers = [
      'CREATE TABLE IF NOT EXISTS habits',
      'target_per_period INTEGER NOT NULL DEFAULT 1 CHECK (target_per_period >= 1)',
      "CHECK (period IN ('day', 'week'))",
      'schedule_days INTEGER[]',
      'reminder_times TEXT[]',
      'CREATE TABLE IF NOT EXISTS habit_logs',
      'count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1)',
      'UNIQUE (habit_id, logged_on)',
      'idx_habit_logs_habit_date',
      'idx_habit_logs_user_date',
      'habit_streak_nudge_hour TEXT DEFAULT',
      'Mirrors backend/src/db/migrate.ts v40',
    ];
    for (const marker of mirrorMarkers) {
      expect(SCHEMA_SQL, `schema.pg.sql missing ${marker}`).toContain(marker);
    }
    // The base file runs BEFORE the migrations, so user_configs already carries the
    // column and v40's ALTER is a no-op there.
    expect(SCHEMA_SQL).not.toMatch(/ALTER TABLE user_configs/);
  });
});
