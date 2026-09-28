import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 89 acceptance: the public ICS subscription feed migration is registered
 * at version 48 - the true next number after 47 (verified against the source list;
 * migrations 1-47 are untouched). The plan text said "migration 43", but 43-47 were
 * already taken when this landed, so 48 is the next free number.
 *
 * Purely additive and idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only.
 * The public token is stored as a SHA-256 hash (`token_hash`), never raw; the
 * `revoked_at` soft-delete marker is nullable, and `last_access_at` is nullable
 * until the first read.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');

const ICS_FEEDS_MIGRATION = 'ics_feeds_v48';

const REQUIRED_V48_MARKERS = [
  'CREATE TABLE IF NOT EXISTS ics_feeds',
  'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE',
  'name TEXT NOT NULL',
  '"filter" JSONB NOT NULL',
  'token_hash TEXT NOT NULL',
  'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  'last_access_at TIMESTAMP',
  'revoked_at TIMESTAMP',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_ics_feeds_token_hash ON ics_feeds(token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_ics_feeds_user ON ics_feeds(user_id)',
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

describe('migration v48 registration (checkbox 89)', () => {
  it('applies v48 when the recorded max version is 47 - proving the previous max was 47', async () => {
    await applyIncrementalMigrations(47);

    const [v48Sql] = callsMatching('CREATE TABLE IF NOT EXISTS ics_feeds');
    expect(v48Sql).toBeDefined();
    for (const marker of REQUIRED_V48_MARKERS) {
      expect(v48Sql, `v48 missing ${marker}`).toContain(marker);
    }
    // v47 and earlier must not re-run on top of a recorded 47.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS caldav_writeback_objects')).toHaveLength(0);
    expect(callsMatching('ADD COLUMN IF NOT EXISTS digest_enabled')).toHaveLength(0);

    const inserts = versionInserts();
    expect(inserts).toContain(48);
    expect(inserts).not.toContain(47);
    expect(inserts).not.toContain(46);
  });

  it('stale state: a recorded v48 row makes the runner skip v48 (no re-apply)', async () => {
    await applyIncrementalMigrations(48);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS ics_feeds')).toHaveLength(0);
    // v49 (checkbox 91, Telegram bot update dedup) is newer and still runs on top of a
    // recorded 48; v48 itself is never re-applied.
    expect(versionInserts()).toEqual([49]);
  });

  it('does not record v48 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS ics_feeds')) {
        throw new Error('permission denied for table users');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(47);

    expect(versionInserts()).not.toContain(48);
  });

  it('keeps every v48 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(47);
    const [v48Sql] = callsMatching('CREATE TABLE IF NOT EXISTS ics_feeds');

    for (const statement of v48Sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      expect(statement).toMatch(/^(CREATE TABLE IF NOT EXISTS |CREATE INDEX IF NOT EXISTS |CREATE UNIQUE INDEX IF NOT EXISTS )/);
    }
    expect(v48Sql).not.toMatch(/\bDROP\b/i);
    expect(v48Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v48Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v48Sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(v48Sql).not.toMatch(/\bALTER TABLE\b/i);
    expect(v48Sql).not.toMatch(/\bINSERT INTO\b/i);
  });

  it('stores only a token hash - no raw token column exists', async () => {
    await applyIncrementalMigrations(47);
    const [v48Sql] = callsMatching('CREATE TABLE IF NOT EXISTS ics_feeds');

    expect(v48Sql).toContain('token_hash TEXT NOT NULL');
    expect(v48Sql).not.toMatch(/\braw_token\b/i);
    expect(v48Sql).not.toMatch(/\btoken\s+TEXT\b/i);
    // The soft-delete column is nullable and unset at creation time (strictly opt-in).
    expect(v48Sql).toContain('revoked_at TIMESTAMP');
    expect(v48Sql).not.toContain('revoked_at TIMESTAMP NOT NULL');
  });

  it('registers v48 once, ascending, immediately after 47 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(47);
    expect(versions).toContain(48);
    expect(versions.filter((v) => v === 48)).toHaveLength(1);
    expect(versions.indexOf(48)).toBe(versions.indexOf(47) + 1);
    // v49 (checkbox 91, Telegram bot update dedup) continues the chain; 48 is no longer the tail.
    expect(versions.indexOf(49)).toBe(versions.indexOf(48) + 1);
    expect(versions[versions.length - 1]).toBe(49);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${ICS_FEEDS_MIGRATION}'`);
    // Migrations 1-47 are untouched: the source still contains the recent names.
    expect(MIGRATE_SOURCE).toContain("name: 'caldav_writeback_v47'");
    expect(MIGRATE_SOURCE).toContain("name: 'digest_preferences_v46'");
    expect(MIGRATE_SOURCE).toContain("name: 'holiday_jieqi_reminders_v45'");
  });
});
