import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 97 acceptance: migration v51 adds the snooze deadline column, and the D5
 * schema divergence between `migrate.ts` (v5) and `shared/src/schema.pg.sql` is resolved.
 *
 * v51 is purely additive + idempotent: one `ALTER TABLE events ADD COLUMN IF NOT EXISTS`.
 * Re-running 51 (or applying on top of a recorded 51) must not re-execute it.
 *
 * D5 finding: `events` is created by `shared/src/schema.pg.sql` (the full schema applied by
 * scripts/migrate-db.ts BEFORE runMigrations, and the incremental chain starts at v2 - no
 * migration creates `events`) with `next_occurrence DATE`. So v5's `TEXT` was dead intent:
 * on every real DB the column already existed as DATE and `ADD COLUMN IF NOT EXISTS` was a
 * no-op. v5 now says DATE, matching the schema and `og.ts`'s `Date | string | null`.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const SCHEMA_SOURCE = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');

const SNOOZE_MIGRATION = 'event_snoozed_until_v51';

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

describe('migration v51 registration (checkbox 97)', () => {
  it('applies v51 when the recorded max version is 50 - proving the previous max was 50', async () => {
    await applyIncrementalMigrations(50);

    const [v51Sql] = callsMatching('ALTER TABLE events ADD COLUMN IF NOT EXISTS snoozed_until');
    expect(v51Sql).toBeDefined();
    expect(v51Sql).toContain('snoozed_until TIMESTAMPTZ');
    // Same-class alignment: the reminder dedup TOKEN cannot live in a DATE column.
    expect(v51Sql).toContain('ALTER TABLE event_trigger_logs ALTER COLUMN trigger_date TYPE TEXT USING trigger_date::text');
    expect(v51Sql).not.toMatch(/\bDROP\b/i);
    expect(v51Sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(v51Sql).not.toMatch(/\bINSERT INTO\b/i);
    // v50 and earlier must not re-run on top of a recorded 50.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS bot_links')).toHaveLength(0);
    expect(versionInserts()).toContain(51);
    expect(versionInserts()).not.toContain(50);
  });

  it('is idempotent: a recorded v51 row makes the runner skip v51 entirely', async () => {
    await applyIncrementalMigrations(51);
    expect(callsMatching('snoozed_until')).toHaveLength(0);
    // v52 (checkbox 105, behavioural patterns) is newer and still runs on a recorded 51.
    expect(versionInserts()).toEqual([52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 67, 69, 70, 71, 72, 73, 74, 75]);
  });

  it('does not record v51 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('snoozed_until')) throw new Error('permission denied for table events');
      return { rows: [], rowCount: 0 };
    });
    await applyIncrementalMigrations(50);
    expect(versionInserts()).not.toContain(51);
  });

  it('registers v51 once, ascending, immediately after 50 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(50);
    expect(versions).toContain(51);
    expect(versions.filter((v) => v === 51)).toHaveLength(1);
    expect(versions.indexOf(51)).toBe(versions.indexOf(50) + 1);
    expect(versions[versions.length - 1]).toBe(75);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${SNOOZE_MIGRATION}'`);
    // Migrations 1-50 are untouched.
    expect(MIGRATE_SOURCE).toContain("name: 'bot_links_v50'");
    expect(MIGRATE_SOURCE).toContain("name: 'bot_updates_v49'");
  });

  it('aligns event_trigger_logs.trigger_date with the TEXT dedup token the code writes', () => {
    expect(MIGRATE_SOURCE).toContain('ALTER COLUMN trigger_date TYPE TEXT USING trigger_date::text');
    // The paired dedup store is already TEXT (v26) - the two must agree.
    expect(MIGRATE_SOURCE).toContain('trigger_date TEXT NOT NULL');
  });

  it('D5: the next_occurrence column type agrees between the migration and the schema', () => {
    expect(MIGRATE_SOURCE).toContain('ADD COLUMN IF NOT EXISTS next_occurrence DATE;');
    expect(MIGRATE_SOURCE).not.toContain('ADD COLUMN IF NOT EXISTS next_occurrence TEXT;');
    expect(SCHEMA_SOURCE).toMatch(/next_occurrence DATE/);
  });
});
