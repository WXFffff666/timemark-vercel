import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 80 acceptance: the digest-preferences migration is registered at
 * version 46 — the true next number after 45 (verified against the source list;
 * migrations 1-45 are untouched). It is appended after v45, picked up by the
 * runner in order, idempotent (every statement is ADD COLUMN IF NOT EXISTS-guarded)
 * and purely additive: no ALTER of existing columns, no data write.
 *
 * Contract under test:
 * - `digest_enabled` defaults TRUE so the checkbox-79 cron behaviour (a monthly
 *   digest to every account) is preserved until a user opts out;
 * - `digest_sections` is NULLable (NULL = all sections);
 * - `digest_recipients` defaults to `[]` (fall back to resolveRecipientEmails);
 * - `digest_channel_account_id` is a plain nullable INTEGER (ownership and
 *   email-capability are validated in the API layer, not the schema).
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');

const DIGEST_MIGRATION = 'digest_preferences_v46';

const REQUIRED_V46_MARKERS = [
  'ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT TRUE',
  "ADD COLUMN IF NOT EXISTS digest_period TEXT NOT NULL DEFAULT 'monthly'",
  "ADD COLUMN IF NOT EXISTS digest_recipients JSONB DEFAULT '[]'::jsonb",
  'ADD COLUMN IF NOT EXISTS digest_sections JSONB',
  'ADD COLUMN IF NOT EXISTS digest_channel_account_id INTEGER',
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

describe('migration v46 registration (checkbox 80)', () => {
  it('applies v46 when the recorded max version is 45 - proving the previous max was 45', async () => {
    await applyIncrementalMigrations(45);

    const [v46Sql] = callsMatching('ADD COLUMN IF NOT EXISTS digest_enabled');
    expect(v46Sql).toBeDefined();
    for (const marker of REQUIRED_V46_MARKERS) {
      expect(v46Sql, `v46 missing ${marker}`).toContain(marker);
    }
    // v45 and earlier must not re-run on top of a recorded 45.
    expect(callsMatching('ADD COLUMN IF NOT EXISTS holiday_reminder_mode')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS goals')).toHaveLength(0);

    const inserts = versionInserts();
    expect(inserts).toContain(46);
    expect(inserts).not.toContain(45);
    expect(inserts).not.toContain(44);
  });

  it('stale-state: a recorded v46 row makes the runner skip v46 (no re-apply, no duplicate write)', async () => {
    await applyIncrementalMigrations(46);

    expect(callsMatching('ADD COLUMN IF NOT EXISTS digest_enabled')).toHaveLength(0);
    expect(versionInserts()).not.toContain(46);
    // v47 (checkbox 86, CalDAV write-back) is newer and does run on top of a recorded 46.
    expect(versionInserts()).toEqual([47]);
  });

  it('does not record v46 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('ADD COLUMN IF NOT EXISTS digest_enabled')) {
        throw new Error('permission denied for table user_configs');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(45);

    expect(versionInserts()).not.toContain(46);
  });

  it('keeps every v46 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(45);
    const [v46Sql] = callsMatching('ADD COLUMN IF NOT EXISTS digest_enabled');

    // Only ADD COLUMN IF NOT EXISTS - never a bare ADD COLUMN, ALTER TYPE, DROP or write.
    for (const statement of v46Sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      expect(statement).toMatch(/^ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS /);
    }
    expect(v46Sql).not.toMatch(/\bDROP\b/i);
    expect(v46Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v46Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v46Sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(v46Sql).not.toMatch(/\bINSERT INTO\b/i);
    expect(v46Sql).not.toMatch(/\bCREATE\s+(TABLE|INDEX)\b/i);
  });

  it('registers v46 once, ascending, immediately after 45 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(45);
    expect(versions).toContain(46);
    expect(versions.filter((v) => v === 46)).toHaveLength(1);
    expect(versions.indexOf(46)).toBe(versions.indexOf(45) + 1);
    // v47 (checkbox 86, CalDAV write-back) continues the chain; 46 is no longer the tail.
    expect(versions.indexOf(47)).toBe(versions.indexOf(46) + 1);
    expect(versions[versions.length - 1]).toBe(47);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${DIGEST_MIGRATION}'`);
    // Migrations 1-45 are untouched: the source still contains every recent name.
    expect(MIGRATE_SOURCE).toContain("name: 'holiday_jieqi_reminders_v45'");
    expect(MIGRATE_SOURCE).toContain("name: 'goals_milestones_v44'");
    expect(MIGRATE_SOURCE).toContain("name: 'profile_channel_accounts_v43'");
  });
});
