import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 102 acceptance: migration v56 adds the durable two-phase confirmation store
 * (`agent_confirmations`). The real chain max before this lane was 55 (`agent_tokens_v55`,
 * verified by reading migrate.ts immediately before appending), so v56 is appended right after.
 *
 * v56 is purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no ALTER
 * of existing tables, no backfill, no data migration. Re-running 56 (or applying on top of a
 * recorded 56) must not re-execute it, and a failing v56 must not be recorded so the next cold
 * start retries.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const MIGRATION_NAME = 'agent_confirmations_v56';

function migrationSql(marker: string): string {
  const nameIndex = MIGRATE_SOURCE.indexOf(`name: '${marker}'`);
  if (nameIndex < 0) throw new Error(`migration ${marker} not found in migrate.ts`);
  const sqlStart = MIGRATE_SOURCE.indexOf('sql: `', nameIndex);
  const sqlEnd = MIGRATE_SOURCE.indexOf('`,', sqlStart);
  return MIGRATE_SOURCE.slice(sqlStart + 'sql: `'.length, sqlEnd);
}

const V56_SQL = migrationSql(MIGRATION_NAME);

function parseInList(constraint: string, column: string): string[] {
  const match = V56_SQL.match(new RegExp(`${constraint} CHECK \\(${column} IN \\(([^)]*)\\)\\)`));
  if (!match) throw new Error(`missing ${constraint} in v56 SQL`);
  return match[1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
}

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

describe('migration v56 registration (checkbox 102)', () => {
  it('applies v56 when the recorded max version is 55 - proving the previous max was 55', async () => {
    await applyIncrementalMigrations(55);
    const [v56Sql] = callsMatching('CREATE TABLE IF NOT EXISTS agent_confirmations');
    expect(v56Sql).toBeDefined();
    expect(v56Sql).toContain('CREATE TABLE IF NOT EXISTS agent_confirmations');
    // v55 and earlier must not re-run on top of a recorded 55. (v56 references `agent_tokens`
    // via its FK, so the marker must be a v55-only table, not the substring `agent_tokens`.)
    expect(callsMatching('CREATE TABLE IF NOT EXISTS agent_audit_logs')).toHaveLength(0);
    expect(versionInserts()).toContain(56);
    expect(versionInserts()).not.toContain(55);
  });

  it('is idempotent: a recorded v56 row makes the runner skip v56 entirely', async () => {
    await applyIncrementalMigrations(56);
    expect(callsMatching('agent_confirmations')).toHaveLength(0);
    expect(versionInserts()).toEqual([57]);
  });

  it('does not record v56 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('agent_confirmations_status_check')) throw new Error('permission denied for table users');
      return { rows: [], rowCount: 0 };
    });
    await applyIncrementalMigrations(55);
    expect(versionInserts()).not.toContain(56);
  });

  it('registers v56 once, ascending, immediately after 55 as the tail of the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions.filter((v) => v === 56)).toHaveLength(1);
    expect(versions.indexOf(56)).toBe(versions.indexOf(55) + 1);
    expect(versions[versions.length - 1]).toBe(57);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${MIGRATION_NAME}'`);
    // Migrations 1-55 are untouched.
    expect(MIGRATE_SOURCE).toContain("name: 'agent_tokens_v55'");
    expect(MIGRATE_SOURCE).toContain("name: 'agent_jobs_v54'");
  });

  it('is re-runnable: every statement is IF NOT EXISTS-guarded and additive-only', () => {
    expect(V56_SQL).not.toMatch(/CREATE TABLE\s+(?!IF NOT EXISTS)/i);
    expect(V56_SQL).not.toMatch(/CREATE INDEX\s+(?!IF NOT EXISTS)/i);
    expect(V56_SQL).not.toMatch(/CREATE UNIQUE INDEX\s+(?!IF NOT EXISTS)/i);
    expect(V56_SQL).not.toMatch(/\bDROP\b/i);
    expect(V56_SQL).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(V56_SQL).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(V56_SQL).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(V56_SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(V56_SQL.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(1);
    expect(V56_SQL.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
  });

  it('creates agent_confirmations with the single-use lifecycle columns', () => {
    for (const pin of [
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE',
      'token_id UUID REFERENCES agent_tokens(id) ON DELETE SET NULL',
      'tool TEXT NOT NULL',
      "args JSONB NOT NULL DEFAULT '{}'::jsonb",
      "status TEXT NOT NULL DEFAULT 'pending'",
      'created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      'expires_at TIMESTAMPTZ NOT NULL',
      'consumed_at TIMESTAMPTZ',
    ]) {
      expect(V56_SQL, `missing agent_confirmations DDL: ${pin}`).toContain(pin);
    }
    expect(V56_SQL).toContain(
      'CREATE INDEX IF NOT EXISTS idx_agent_confirmations_user ON agent_confirmations (user_id, created_at DESC)',
    );
    expect(V56_SQL).toContain(
      'CREATE INDEX IF NOT EXISTS idx_agent_confirmations_pending ON agent_confirmations (status, expires_at)',
    );
  });

  it('enumerates the three confirmation states with a named CHECK', () => {
    expect(parseInList('agent_confirmations_status_check', 'status')).toEqual(['pending', 'consumed', 'expired']);
  });
});
