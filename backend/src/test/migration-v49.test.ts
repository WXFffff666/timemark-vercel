import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 91 acceptance: the Telegram webhook dedup table is registered at version 49 -
 * the true next number after 48 (verified against the source list; migrations 1-48 are
 * untouched). The plan text said "migration 44", but 44-48 were already taken when this
 * landed, so 49 is the next free number.
 *
 * Purely additive and idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only.
 * `update_id` is the Telegram primary key (BIGINT), and `received_at` defaults to now.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');

const BOT_UPDATES_MIGRATION = 'bot_updates_v49';

const REQUIRED_V49_MARKERS = [
  'CREATE TABLE IF NOT EXISTS bot_updates',
  'update_id BIGINT PRIMARY KEY',
  'received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  'CREATE INDEX IF NOT EXISTS idx_bot_updates_received_at ON bot_updates(received_at)',
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

describe('migration v49 registration (checkbox 91)', () => {
  it('applies v49 when the recorded max version is 48 - proving the previous max was 48', async () => {
    await applyIncrementalMigrations(48);

    const [v49Sql] = callsMatching('CREATE TABLE IF NOT EXISTS bot_updates');
    expect(v49Sql).toBeDefined();
    for (const marker of REQUIRED_V49_MARKERS) {
      expect(v49Sql, `v49 missing ${marker}`).toContain(marker);
    }
    // v48 and earlier must not re-run on top of a recorded 48.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS ics_feeds')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS caldav_writeback_objects')).toHaveLength(0);

    const inserts = versionInserts();
    expect(inserts).toContain(49);
    expect(inserts).not.toContain(48);
    expect(inserts).not.toContain(47);
  });

  it('stale state: a recorded v49 row makes the runner skip v49 (no re-apply)', async () => {
    await applyIncrementalMigrations(49);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS bot_updates')).toHaveLength(0);
    // v50 (checkbox 94, chat linking), v51 (checkbox 97, /snooze persistence) and v52
    // (checkbox 105, behavioural patterns) are newer
    // and still run on top of a recorded 49; v49 itself is never re-applied.
    expect(versionInserts()).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 67, 69, 70, 71]);
  });

  it('does not record v49 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS bot_updates')) {
        throw new Error('permission denied for table bot_updates');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(48);

    expect(versionInserts()).not.toContain(49);
  });

  it('keeps every v49 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(48);
    const [v49Sql] = callsMatching('CREATE TABLE IF NOT EXISTS bot_updates');

    for (const statement of v49Sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      expect(statement).toMatch(/^(CREATE TABLE IF NOT EXISTS |CREATE INDEX IF NOT EXISTS |CREATE UNIQUE INDEX IF NOT EXISTS )/);
    }
    expect(v49Sql).not.toMatch(/\bDROP\b/i);
    expect(v49Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v49Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v49Sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(v49Sql).not.toMatch(/\bALTER TABLE\b/i);
    expect(v49Sql).not.toMatch(/\bINSERT INTO\b/i);
  });

  it('keys dedup on the Telegram update_id and stores no message content', async () => {
    await applyIncrementalMigrations(48);
    const [v49Sql] = callsMatching('CREATE TABLE IF NOT EXISTS bot_updates');

    expect(v49Sql).toContain('update_id BIGINT PRIMARY KEY');
    // Superseded update content (message text, chat id) must never be persisted here.
    expect(v49Sql).not.toMatch(/\bmessage\b/i);
    expect(v49Sql).not.toMatch(/\bchat_id\b/i);
    expect(v49Sql).not.toMatch(/\bpayload\b/i);
  });

  it('registers v49 once, ascending, immediately after 48 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(48);
    expect(versions).toContain(49);
    expect(versions.filter((v) => v === 49)).toHaveLength(1);
    expect(versions.indexOf(49)).toBe(versions.indexOf(48) + 1);
    // v50 (checkbox 94, chat linking) continues the chain; 49 is no longer the tail.
    expect(versions.indexOf(50)).toBe(versions.indexOf(49) + 1);
    // v51 (checkbox 97, /snooze persistence) is the new tail; 1-50 stay untouched.
    expect(versions[versions.length - 1]).toBe(71);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${BOT_UPDATES_MIGRATION}'`);
    // Migrations 1-48 are untouched: the source still contains the recent names.
    expect(MIGRATE_SOURCE).toContain("name: 'ics_feeds_v48'");
    expect(MIGRATE_SOURCE).toContain("name: 'caldav_writeback_v47'");
    expect(MIGRATE_SOURCE).toContain("name: 'digest_preferences_v46'");
  });
});
