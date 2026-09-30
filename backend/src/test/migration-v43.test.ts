import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Todo 70 acceptance (plan checkbox 70): the per-profile notification routing
 * migration is registered at version 43 - NOT 40 as the plan text claimed,
 * because 40 (habits), 41 (profiles) and 42 (medications) were already taken
 * when this landed (42 is the previous max in the source list). It is appended
 * after 42, picked up by the runner in order, idempotent (every statement is
 * IF NOT EXISTS-guarded) and purely additive: no ALTER of existing tables, no
 * data write at all.
 *
 * `profile_channel_accounts(profile_id, account_id)` semantics under test:
 * - the pair is UNIQUE (PRIMARY KEY) - a profile can route to an account once;
 * - both FKs are ON DELETE CASCADE - deleting either side drops only routing rows;
 * - no rows for a profile means "all active accounts" (resolved in the reminder
 *   code, proven in the routing tests, not in this DDL test).
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const SCHEMA_SQL = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');

const ROUTING_MIGRATION = 'profile_channel_accounts_v43';

const REQUIRED_V43_MARKERS = [
  'CREATE TABLE IF NOT EXISTS profile_channel_accounts',
  'profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE',
  'account_id INTEGER NOT NULL REFERENCES notification_accounts(id) ON DELETE CASCADE',
  'PRIMARY KEY (profile_id, account_id)',
  'CREATE INDEX IF NOT EXISTS idx_profile_channel_accounts_account',
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

describe('migration v43 registration (todo 70)', () => {
  it('applies v43 when the recorded max version is 42 - proving the previous max was 42', async () => {
    await applyIncrementalMigrations(42);

    const [v43Sql] = callsMatching('CREATE TABLE IF NOT EXISTS profile_channel_accounts');
    expect(v43Sql).toBeDefined();
    for (const marker of REQUIRED_V43_MARKERS) {
      expect(v43Sql, `v43 missing ${marker}`).toContain(marker);
    }
    // v42 and earlier must not re-run on top of a recorded 42.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS medications')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS profiles')).toHaveLength(0);

    const inserts = versionInserts();
    expect(inserts).toContain(43);
    expect(inserts).not.toContain(42);
    expect(inserts).not.toContain(41);
  });

  it('stale-state: a recorded v43 row makes the runner skip v43 (no re-apply, no duplicate write)', async () => {
    await applyIncrementalMigrations(43);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS profile_channel_accounts')).toHaveLength(0);
    expect(versionInserts()).not.toContain(43);
    // v44 (todo 81), v45 (todo 78), v46 (checkbox 80), v47 (checkbox 86), v48
    // (checkbox 89, public ICS feeds), v49 (checkbox 91, Telegram bot dedup) and v50
    // (checkbox 94, chat linking) are newer and do run on top of a recorded 43; v43 itself
    // is never re-applied.
    expect(versionInserts()).toEqual([44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 67, 69, 70, 71, 72, 73, 74, 75]);
  });

  it('does not record v43 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS profile_channel_accounts')) {
        throw new Error('permission denied for table profile_channel_accounts');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(42);

    expect(versionInserts()).not.toContain(43);
  });

  it('keeps every v43 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(42);
    const [v43Sql] = callsMatching('CREATE TABLE IF NOT EXISTS profile_channel_accounts');

    expect(v43Sql).not.toMatch(/\bCREATE TABLE(?! IF NOT EXISTS)/);
    expect(v43Sql).not.toMatch(/\bCREATE INDEX(?! IF NOT EXISTS)/);
    expect(v43Sql).not.toMatch(/\bCREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
    expect(v43Sql).not.toMatch(/\bDROP\b/i);
    expect(v43Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v43Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v43Sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(v43Sql).not.toMatch(/\bALTER TABLE\b/i);
    expect(v43Sql).not.toMatch(/\bINSERT INTO\b/i);
  });

  it('registers v43 once, ascending, immediately after 42 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(42);
    expect(versions).toContain(43);
    expect(versions.filter((v) => v === 43)).toHaveLength(1);
    expect(versions.indexOf(43)).toBe(versions.indexOf(42) + 1);
    // v44 (todo 81, goals/milestones) landed after v43, so 43 is no longer the tail -
    // assert the chain continues instead of pinning 43 as last.
    expect(versions.filter((v) => v === 44)).toHaveLength(1);
    expect(versions.indexOf(44)).toBe(versions.indexOf(43) + 1);
    // v45 (todo 78) and v46 (checkbox 80, digest preferences) continue the chain.
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
    expect(versions[versions.length - 1]).toBe(75);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${ROUTING_MIGRATION}'`);
    // Migrations 1-42 are untouched: the source still contains every recent name.
    expect(MIGRATE_SOURCE).toContain("name: 'medications_v42'");
    expect(MIGRATE_SOURCE).toContain("name: 'profiles_v41'");
  });

  it('mirrors profile_channel_accounts into shared/src/schema.pg.sql', () => {
    for (const marker of [
      'CREATE TABLE IF NOT EXISTS profile_channel_accounts',
      'account_id INTEGER NOT NULL REFERENCES notification_accounts(id) ON DELETE CASCADE',
      'PRIMARY KEY (profile_id, account_id)',
      'idx_profile_channel_accounts_account',
      'backend/src/db/migrate.ts v43',
    ]) {
      expect(SCHEMA_SQL, `schema.pg.sql missing ${marker}`).toContain(marker);
    }
  });
});
