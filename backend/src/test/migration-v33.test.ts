import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 41 acceptance: prove the retention/index migration is registered at
 * version 33 (max pre-existing version in migrate.ts was 32), appended after 32,
 * picked up by the runner, idempotent (IF NOT EXISTS everywhere) and non-destructive.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const REQUIRED_V33_MARKERS = [
  'CREATE EXTENSION IF NOT EXISTS pg_trgm',
  'idx_events_name_trgm',
  'idx_events_person_name_trgm',
  'idx_events_tags_trgm',
  'idx_fixed_contacts_name_trgm',
  'idx_fixed_contacts_nickname_trgm',
  'idx_fixed_contacts_notes_trgm',
  'idx_trigger_logs_user_created',
  'idx_trigger_logs_consecutive',
  'idx_email_logs_user_sent_desc',
  'idx_notification_queue_retry',
  'idx_login_attempts_last_attempt',
  "to_regclass('expiry_items')",
];

function versionInserts(): unknown[] {
  return mockQuery.mock.calls
    .filter(([sql]) => sql.includes('INSERT INTO schema_version'))
    .map(([, params]) => params?.[0]);
}

describe('migration v33 registration (todo 41)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('applies v33 when the recorded max version is 32 (the pre-existing max)', async () => {
    await applyIncrementalMigrations(32);

    const [v33Sql] = mockQuery.mock.calls[0];
    for (const marker of REQUIRED_V33_MARKERS) {
      expect(v33Sql, `missing ${marker}`).toContain(marker);
    }
    // The version row is written only after the migration SQL ran.
    expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO schema_version');
    expect(versionInserts()).toEqual([33]);
  });

  it('applies v32 before v33 in ascending order when the recorded max version is 31', async () => {
    await applyIncrementalMigrations(31);

    const sqls = mockQuery.mock.calls.map(([sql]) => sql);
    const v32Index = sqls.findIndex((sql) => sql.includes('session_data_text'));
    const v33Index = sqls.findIndex((sql) => sql.includes('logging_indexes') || sql.includes('pg_trgm'));
    expect(v32Index).toBeGreaterThanOrEqual(0);
    expect(v33Index).toBeGreaterThan(v32Index);
    expect(versionInserts()).toEqual([32, 33]);
  });

  it('is a runner-level no-op when version 33 is already recorded', async () => {
    // Documented runner behaviour: `currentVersion < migration.version` gates each
    // migration, and the version row is INSERTed only after the SQL succeeds, so a
    // "stale" row can only exist from manual tampering. The migration itself is
    // idempotent (IF NOT EXISTS / guarded DO), so re-running it by hand is safe.
    await applyIncrementalMigrations(33);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not record v33 when the migration SQL fails, so a later startup retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE EXTENSION IF NOT EXISTS pg_trgm')) {
        throw new Error('permission denied for extension pg_trgm');
      }
      return { rows: [], rowCount: 0 };
    });

    // Must not throw: the runner logs and leaves the version unrecorded.
    await applyIncrementalMigrations(32);

    expect(versionInserts()).toEqual([]);
  });

  it('keeps every CREATE INDEX IF NOT EXISTS-guarded and never drops or rewrites data', async () => {
    await applyIncrementalMigrations(32);
    const [v33Sql] = mockQuery.mock.calls[0];

    const statements = v33Sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const createIndexStatements = statements.filter((s) => s.includes('CREATE INDEX'));
    expect(createIndexStatements.length).toBeGreaterThanOrEqual(9);
    for (const statement of createIndexStatements) {
      expect(statement, `unguarded: ${statement}`).toContain('IF NOT EXISTS');
    }

    expect(v33Sql).not.toMatch(/\bDROP\b/i);
    expect(v33Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v33Sql).not.toMatch(/\bDELETE\b/i);
    expect(v33Sql).not.toMatch(/\bUPDATE\b/i);
    // The only ALTER-free migration: v33 is pure additive DDL.
    expect(v33Sql).not.toMatch(/\bALTER\b/i);
  });
});
