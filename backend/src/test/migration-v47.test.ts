import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 86 acceptance: the CalDAV write-back migration is registered at version
 * 47 - the true next number after 46 (verified against the source list; migrations
 * 1-46 are untouched). Purely additive and idempotent: the toggle defaults to
 * FALSE (write-back is opt-in), the collection URL is nullable, and the new
 * bookkeeping table is created with IF NOT EXISTS guards.
 *
 * Contract under test:
 * - `caldav_writeback_enabled BOOLEAN NOT NULL DEFAULT FALSE` - default OFF;
 * - `caldav_writeback_url TEXT` - nullable, no default (empty = not configured);
 * - `caldav_writeback_objects` stores the stable uid + ETag + content hash per
 *   (user, entity) with a UNIQUE constraint so a re-run updates instead of
 *   creating duplicate rows / VEVENTs.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');

const WRITE_BACK_MIGRATION = 'caldav_writeback_v47';

const REQUIRED_V47_MARKERS = [
  'ADD COLUMN IF NOT EXISTS caldav_writeback_enabled BOOLEAN NOT NULL DEFAULT FALSE',
  'ADD COLUMN IF NOT EXISTS caldav_writeback_url TEXT',
  'CREATE TABLE IF NOT EXISTS caldav_writeback_objects',
  'UNIQUE (user_id, entity_type, entity_id)',
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

describe('migration v47 registration (checkbox 86)', () => {
  it('applies v47 when the recorded max version is 46 - proving the previous max was 46', async () => {
    await applyIncrementalMigrations(46);

    const [v47Sql] = callsMatching('CREATE TABLE IF NOT EXISTS caldav_writeback_objects');
    expect(v47Sql).toBeDefined();
    for (const marker of REQUIRED_V47_MARKERS) {
      expect(v47Sql, `v47 missing ${marker}`).toContain(marker);
    }
    // v46 and earlier must not re-run on top of a recorded 46.
    expect(callsMatching('ADD COLUMN IF NOT EXISTS digest_enabled')).toHaveLength(0);
    expect(callsMatching('ADD COLUMN IF NOT EXISTS holiday_reminder_mode')).toHaveLength(0);

    const inserts = versionInserts();
    expect(inserts).toContain(47);
    expect(inserts).not.toContain(46);
    expect(inserts).not.toContain(45);
  });

  it('stale state: a recorded v47 row makes the runner skip v47 (no re-apply)', async () => {
    await applyIncrementalMigrations(47);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS caldav_writeback_objects')).toHaveLength(0);
    // v48 (checkbox 89, public ICS feeds), v49 (checkbox 91, Telegram bot dedup) and v50
    // (checkbox 94, chat linking) are newer and still run on top of a recorded 47; v47
    // itself is never re-applied.
    expect(versionInserts()).toEqual([48, 49, 50, 51, 52, 53, 54]);
  });

  it('does not record v47 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS caldav_writeback_objects')) {
        throw new Error('permission denied for table user_configs');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(46);

    expect(versionInserts()).not.toContain(47);
  });

  it('keeps every v47 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(46);
    const [v47Sql] = callsMatching('CREATE TABLE IF NOT EXISTS caldav_writeback_objects');

    for (const statement of v47Sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      expect(statement).toMatch(/^(ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS |CREATE TABLE IF NOT EXISTS |CREATE INDEX IF NOT EXISTS )/);
    }
    expect(v47Sql).not.toMatch(/\bDROP\b/i);
    expect(v47Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v47Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v47Sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(v47Sql).not.toMatch(/\bINSERT INTO\b/i);
    // The toggle must default to FALSE so the feature is strictly opt-in.
    expect(v47Sql).toContain('caldav_writeback_enabled BOOLEAN NOT NULL DEFAULT FALSE');
  });

  it('registers v47 once, ascending, immediately after 46 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(46);
    expect(versions).toContain(47);
    expect(versions.filter((v) => v === 47)).toHaveLength(1);
    expect(versions.indexOf(47)).toBe(versions.indexOf(46) + 1);
    // v48 (checkbox 89, public ICS feeds) continues the chain; 47 is no longer the tail.
    expect(versions.indexOf(48)).toBe(versions.indexOf(47) + 1);
    // v49 (checkbox 91, Telegram bot update dedup) and v50 (checkbox 94, chat linking)
    // continue the chain; 49 is no longer the tail.
    expect(versions.indexOf(49)).toBe(versions.indexOf(48) + 1);
    // v51 (checkbox 97, /snooze persistence) is the new tail; 1-50 stay untouched.
    expect(versions[versions.length - 1]).toBe(54);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${WRITE_BACK_MIGRATION}'`);
    // Migrations 1-46 are untouched: the source still contains the recent names.
    expect(MIGRATE_SOURCE).toContain("name: 'digest_preferences_v46'");
    expect(MIGRATE_SOURCE).toContain("name: 'holiday_jieqi_reminders_v45'");
    expect(MIGRATE_SOURCE).toContain("name: 'goals_milestones_v44'");
  });
});
