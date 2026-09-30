import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Todo 81 acceptance (plan checkbox 81): the personal goals + milestones
 * migration is registered at version 44 鈥?NOT 42 as the plan text claimed,
 * because 42 (medications) and 43 (per-profile notification routing) were
 * already taken when this landed (43 is the previous max in the source list).
 * It is appended after 43, picked up by the runner in order, idempotent (every
 * statement is IF NOT EXISTS-guarded) and purely additive: no ALTER of existing
 * tables, no data write at all.
 *
 * `goals` / `milestones` semantics under test:
 * - current_value is the RAW value (may exceed target_value); only the derived
 *   percentage is clamped (service level, proven in the route tests);
 * - target_value is NULLable but never 0 (CHECK);
 * - milestones.goal_id is ON DELETE CASCADE 鈥?deleting a goal drops its checklist;
 * - milestones.event_id is an OPTIONAL FK with ON DELETE SET NULL 鈥?deleting the
 *   event only unlinks the milestone, and deleting the goal never touches events
 *   (proven on a live PGlite engine in `.omo/evidence/task-81-*`).
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const SCHEMA_SQL = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');

const GOALS_MIGRATION = 'goals_milestones_v44';

const REQUIRED_V44_MARKERS = [
  'CREATE TABLE IF NOT EXISTS goals',
  'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE',
  'profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL',
  'target_value NUMERIC CHECK (target_value IS NULL OR target_value > 0)',
  'current_value NUMERIC NOT NULL DEFAULT 0 CHECK (current_value >= 0)',
  "CHECK (status IN ('active', 'paused', 'done', 'abandoned'))",
  'CONSTRAINT goals_target_after_start CHECK (target_date IS NULL OR target_date >= start_date)',
  'CREATE INDEX IF NOT EXISTS idx_goals_user_status',
  'CREATE INDEX IF NOT EXISTS idx_goals_user_profile',
  'CREATE TABLE IF NOT EXISTS milestones',
  'goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE',
  'event_id INTEGER REFERENCES events(id) ON DELETE SET NULL',
  'CREATE INDEX IF NOT EXISTS idx_milestones_goal',
  'CREATE INDEX IF NOT EXISTS idx_milestones_event',
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

describe('migration v44 registration (todo 81)', () => {
  it('applies v44 when the recorded max version is 43 - proving the previous max was 43', async () => {
    await applyIncrementalMigrations(43);

    const [v44Sql] = callsMatching('CREATE TABLE IF NOT EXISTS goals');
    expect(v44Sql).toBeDefined();
    for (const marker of REQUIRED_V44_MARKERS) {
      expect(v44Sql, `v44 missing ${marker}`).toContain(marker);
    }
    // v43 and earlier must not re-run on top of a recorded 43.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS profile_channel_accounts')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS medications')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS profiles')).toHaveLength(0);

    const inserts = versionInserts();
    expect(inserts).toContain(44);
    expect(inserts).not.toContain(43);
    expect(inserts).not.toContain(42);
  });

  it('stale-state: a recorded v44 row makes the runner skip v44 (no re-apply, no duplicate write)', async () => {
    await applyIncrementalMigrations(44);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS goals')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS milestones')).toHaveLength(0);
    expect(versionInserts()).not.toContain(44);
    // v45 (todo 78), v46 (checkbox 80), v47 (checkbox 86), v48 (checkbox 89, public ICS
    // feeds), v49 (checkbox 91, Telegram bot dedup) and v50 (checkbox 94, chat linking)
    // landed after v44 and DO run on a recorded 44; v44 itself is never re-applied
    // (one insert each).
    expect(versionInserts()).toEqual([45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  });

  it('does not record v44 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS goals')) {
        throw new Error('permission denied for table goals');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(43);

    expect(versionInserts()).not.toContain(44);
  });

  it('keeps every v44 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(43);
    const [v44Sql] = callsMatching('CREATE TABLE IF NOT EXISTS goals');

    expect(v44Sql).not.toMatch(/\bCREATE TABLE(?! IF NOT EXISTS)/);
    expect(v44Sql).not.toMatch(/\bCREATE INDEX(?! IF NOT EXISTS)/);
    expect(v44Sql).not.toMatch(/\bCREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
    expect(v44Sql).not.toMatch(/\bDROP\b/i);
    expect(v44Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v44Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v44Sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(v44Sql).not.toMatch(/\bALTER TABLE\b/i);
    expect(v44Sql).not.toMatch(/\bINSERT INTO\b/i);
  });

  it('registers v44 once, ascending, immediately after 43 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(43);
    expect(versions).toContain(44);
    expect(versions.filter((v) => v === 44)).toHaveLength(1);
    expect(versions.indexOf(44)).toBe(versions.indexOf(43) + 1);
    // v45 (todo 78) and v46 (checkbox 80, digest preferences) continue the chain; 44 is no longer the tail.
    expect(versions.indexOf(45)).toBe(versions.indexOf(44) + 1);
    expect(versions.indexOf(46)).toBe(versions.indexOf(45) + 1);
    // v47 (checkbox 86, CalDAV write-back) and v48 (checkbox 89, public ICS feeds)
    // continue the chain; 46 is no longer the tail.
    expect(versions.indexOf(47)).toBe(versions.indexOf(46) + 1);
    expect(versions.indexOf(48)).toBe(versions.indexOf(47) + 1);
    // v49 (checkbox 91, Telegram bot update dedup) and v50 (checkbox 94, chat linking)
    // continue the chain; 49 is no longer the tail.
    expect(versions.indexOf(49)).toBe(versions.indexOf(48) + 1);
    // v51 (checkbox 97, /snooze persistence) is the new tail; 1-50 stay untouched.
    expect(versions[versions.length - 1]).toBe(58);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${GOALS_MIGRATION}'`);
    // Migrations 1-43 are untouched: the source still contains every recent name.
    expect(MIGRATE_SOURCE).toContain("name: 'profile_channel_accounts_v43'");
    expect(MIGRATE_SOURCE).toContain("name: 'medications_v42'");
    expect(MIGRATE_SOURCE).toContain("name: 'profiles_v41'");
  });

  it('mirrors goals/milestones into shared/src/schema.pg.sql', () => {
    for (const marker of [
      'CREATE TABLE IF NOT EXISTS goals',
      'CREATE TABLE IF NOT EXISTS milestones',
      'current_value NUMERIC NOT NULL DEFAULT 0 CHECK (current_value >= 0)',
      "CHECK (status IN ('active', 'paused', 'done', 'abandoned'))",
      'goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE',
      'event_id INTEGER REFERENCES events(id) ON DELETE SET NULL',
      'backend/src/db/migrate.ts v44',
    ]) {
      expect(SCHEMA_SQL, `schema.pg.sql missing ${marker}`).toContain(marker);
    }
  });
});
