import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 94 acceptance: the chat-linking + audit-trail migration is registered at
 * version 50 - the true next number after 49 (verified against the source list; migrations
 * 1-49 are untouched). The plan text said "version: 45", but 45-49 were already taken when
 * this landed, so 50 is the next free number.
 *
 * Purely additive and idempotent: CREATE TABLE / CREATE INDEX / CREATE UNIQUE INDEX
 * IF NOT EXISTS only. `bot_links` carries the `UNIQUE (platform, chat_id)` backstop;
 * `bot_link_codes` stores only a SHA-256 hash (never a raw code); `bot_audit_logs` stores
 * the command plus a redacted args shape and a result summary - no message bodies.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');

const BOT_LINKS_MIGRATION = 'bot_links_v50';

const REQUIRED_V50_MARKERS = [
  'CREATE TABLE IF NOT EXISTS bot_links',
  'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE',
  'platform TEXT NOT NULL',
  'chat_id TEXT NOT NULL',
  'chat_type TEXT',
  'active_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL',
  'linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  'last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  'revoked_at TIMESTAMP',
  'UNIQUE (platform, chat_id)',
  'CREATE INDEX IF NOT EXISTS idx_bot_links_user ON bot_links(user_id)',
  'CREATE TABLE IF NOT EXISTS bot_link_codes',
  'code_hash TEXT NOT NULL',
  'expires_at TIMESTAMPTZ NOT NULL',
  'used_at TIMESTAMP',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_link_codes_code_hash ON bot_link_codes(code_hash)',
  'CREATE TABLE IF NOT EXISTS bot_audit_logs',
  'command TEXT NOT NULL',
  'args_redacted TEXT',
  'result TEXT NOT NULL',
  'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  'CREATE INDEX IF NOT EXISTS idx_bot_audit_logs_user ON bot_audit_logs(user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_bot_audit_logs_chat ON bot_audit_logs(platform, chat_id, created_at)',
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

describe('migration v50 registration (checkbox 94)', () => {
  it('applies v50 when the recorded max version is 49 - proving the previous max was 49', async () => {
    await applyIncrementalMigrations(49);

    const [v50Sql] = callsMatching('CREATE TABLE IF NOT EXISTS bot_links');
    expect(v50Sql).toBeDefined();
    for (const marker of REQUIRED_V50_MARKERS) {
      expect(v50Sql, `v50 missing ${marker}`).toContain(marker);
    }
    // v49 and earlier must not re-run on top of a recorded 49.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS bot_updates')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS ics_feeds')).toHaveLength(0);

    const inserts = versionInserts();
    expect(inserts).toContain(50);
    expect(inserts).not.toContain(49);
    expect(inserts).not.toContain(48);
  });

  it('stale state: a recorded v50 row makes the runner skip v50 (no re-apply)', async () => {
    await applyIncrementalMigrations(50);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS bot_links')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS bot_link_codes')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS bot_audit_logs')).toHaveLength(0);
    // v50 itself is never re-applied; v51 (checkbox 97) and v52 (checkbox 105) still run.
    expect(versionInserts()).toEqual([51, 52, 53, 54, 55, 56]);
  });

  it('does not record v50 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS bot_link_codes')) {
        throw new Error('permission denied for table bot_link_codes');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(49);

    expect(versionInserts()).not.toContain(50);
  });

  it('keeps every v50 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(49);
    const [v50Sql] = callsMatching('CREATE TABLE IF NOT EXISTS bot_links');

    for (const statement of v50Sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      expect(statement).toMatch(/^(CREATE TABLE IF NOT EXISTS |CREATE INDEX IF NOT EXISTS |CREATE UNIQUE INDEX IF NOT EXISTS )/);
    }
    expect(v50Sql).not.toMatch(/\bDROP\b/i);
    expect(v50Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v50Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v50Sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(v50Sql).not.toMatch(/\bALTER TABLE\b/i);
    expect(v50Sql).not.toMatch(/\bINSERT INTO\b/i);
  });

  it('enforces one link per (platform, chat_id) and stores no message bodies', async () => {
    await applyIncrementalMigrations(49);
    const [v50Sql] = callsMatching('CREATE TABLE IF NOT EXISTS bot_links');

    expect(v50Sql).toContain('UNIQUE (platform, chat_id)');
    expect(v50Sql).toContain('revoked_at TIMESTAMP');
    expect(v50Sql).not.toContain('revoked_at TIMESTAMP NOT NULL');
    // Link codes and audit rows must never persist message content.
    expect(v50Sql).not.toMatch(/\bmessage\b/);
    expect(v50Sql).not.toMatch(/\bpayload\b/);
    expect(v50Sql).not.toMatch(/\btext_body\b/);
  });

  it('stores only a code hash - no raw link-code column exists', async () => {
    await applyIncrementalMigrations(49);
    const [v50Sql] = callsMatching('CREATE TABLE IF NOT EXISTS bot_links');

    expect(v50Sql).toContain('code_hash TEXT NOT NULL');
    expect(v50Sql).not.toMatch(/\braw_code\b/i);
    expect(v50Sql).not.toMatch(/\bcode\s+TEXT\b/i);
    expect(v50Sql).toContain('used_at TIMESTAMP');
    expect(v50Sql).toContain('expires_at TIMESTAMPTZ NOT NULL');
  });

  it('registers v50 once, ascending, immediately after 49 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(49);
    expect(versions).toContain(50);
    expect(versions.filter((v) => v === 50)).toHaveLength(1);
    expect(versions.indexOf(50)).toBe(versions.indexOf(49) + 1);
    // v51 (checkbox 97, /snooze persistence) is the new tail; 1-50 stay untouched.
    expect(versions[versions.length - 1]).toBe(56);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${BOT_LINKS_MIGRATION}'`);
    // Migrations 1-49 are untouched: the source still contains the recent names.
    expect(MIGRATE_SOURCE).toContain("name: 'bot_updates_v49'");
    expect(MIGRATE_SOURCE).toContain("name: 'ics_feeds_v48'");
    expect(MIGRATE_SOURCE).toContain("name: 'caldav_writeback_v47'");
  });
});
