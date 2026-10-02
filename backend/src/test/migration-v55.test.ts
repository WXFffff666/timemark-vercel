import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 101 acceptance: migration v55 adds the scoped, revocable agent-token schema
 * (`agent_tokens` + `agent_audit_logs`). The real chain max before this lane was 54
 * (`agent_jobs_v54`, verified by reading migrate.ts immediately before appending), so v55
 * is appended immediately after it.
 *
 * v55 is purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no
 * ALTER of existing tables, no backfill, no data migration. Re-running 55 (or applying on
 * top of a recorded 55) must not re-execute it, and a failing v55 must not be recorded so
 * the next cold start retries.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';
import { migrationSqlFor, registeredMigrationVersions } from './helpers.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const MIGRATION_NAME = 'agent_tokens_v55';

const V55_SQL = migrationSqlFor(MIGRATE_SOURCE, MIGRATION_NAME);

function parseInList(constraint: string, column: string): string[] {
  const match = V55_SQL.match(new RegExp(`${constraint} CHECK \\(${column} IN \\(([^)]*)\\)\\)`));
  if (!match) throw new Error(`missing ${constraint} in v55 SQL`);
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

describe('migration v55 registration (checkbox 101)', () => {
  it('applies v55 when the recorded max version is 54 - proving the previous max was 54', async () => {
    await applyIncrementalMigrations(54);
    const [v55Sql] = callsMatching('CREATE TABLE IF NOT EXISTS agent_tokens');
    expect(v55Sql).toBeDefined();
    expect(v55Sql).toContain('CREATE TABLE IF NOT EXISTS agent_tokens');
    expect(v55Sql).toContain('CREATE TABLE IF NOT EXISTS agent_audit_logs');
    // v54 and earlier must not re-run on top of a recorded 54.
    expect(callsMatching('agent_jobs')).toHaveLength(0);
    expect(versionInserts()).toContain(55);
    expect(versionInserts()).not.toContain(54);
  });

  it('is idempotent: a recorded v55 row makes the runner skip v55 entirely', async () => {
    await applyIncrementalMigrations(55);
    // v56 (checkbox 102) is the tail after v55; applying on a recorded 55 runs only v56.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS agent_audit_logs')).toHaveLength(0);
    expect(versionInserts()).toEqual(registeredMigrationVersions(MIGRATE_SOURCE).filter((v) => v > 55));
  });

  it('does not record v55 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('agent_audit_logs_decision_check')) throw new Error('permission denied for table users');
      return { rows: [], rowCount: 0 };
    });
    await applyIncrementalMigrations(54);
    expect(versionInserts()).not.toContain(55);
  });

  it('registers v55 once, ascending, immediately after 54 as the tail of the source-of-truth list', () => {
    const versions = registeredMigrationVersions(MIGRATE_SOURCE);
    expect(versions.filter((v) => v === 55)).toHaveLength(1);
    expect(versions.indexOf(55)).toBe(versions.indexOf(54) + 1);
    expect(versions[versions.length - 1]).toBe(75);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${MIGRATION_NAME}'`);
    // Migrations 1-54 are untouched.
    expect(MIGRATE_SOURCE).toContain("name: 'agent_jobs_v54'");
    expect(MIGRATE_SOURCE).toContain("name: 'search_trgm_embeddings_v53'");
  });

  it('is re-runnable: every statement is IF NOT EXISTS-guarded and additive-only', () => {
    expect(V55_SQL).not.toMatch(/CREATE TABLE\s+(?!IF NOT EXISTS)/i);
    expect(V55_SQL).not.toMatch(/CREATE INDEX\s+(?!IF NOT EXISTS)/i);
    expect(V55_SQL).not.toMatch(/CREATE UNIQUE INDEX\s+(?!IF NOT EXISTS)/i);
    expect(V55_SQL).not.toMatch(/\bDROP\b/i);
    expect(V55_SQL).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(V55_SQL).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(V55_SQL).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(V55_SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(V55_SQL.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2);
    expect(V55_SQL.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(3);
  });

  it('creates agent_tokens with a hash-only store, nullable lifecycle timestamps and a read-only default', () => {
    for (const pin of [
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE',
      'name TEXT NOT NULL',
      'token_hash TEXT NOT NULL UNIQUE',
      "scopes TEXT[] NOT NULL DEFAULT ARRAY['read']::text[]",
      'created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      'last_used_at TIMESTAMPTZ',
      'revoked_at TIMESTAMPTZ',
      'expires_at TIMESTAMPTZ',
    ]) {
      expect(V55_SQL, `missing agent_tokens DDL: ${pin}`).toContain(pin);
    }
    // There is NO raw-token column - only the hash.
    expect(V55_SQL).not.toMatch(/\btoken\b(?!_hash)/);
    expect(V55_SQL).not.toContain('raw_token');
    expect(V55_SQL).not.toContain('token_plaintext');
    expect(V55_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens (user_id, created_at DESC)');
  });

  it('creates agent_audit_logs with the three-way decision, outcome and timing columns', () => {
    expect(V55_SQL).toContain('CREATE TABLE IF NOT EXISTS agent_audit_logs');
    expect(V55_SQL).toContain('id BIGSERIAL PRIMARY KEY');
    expect(V55_SQL).toContain('token_id UUID REFERENCES agent_tokens(id) ON DELETE SET NULL');
    expect(V55_SQL).toContain('tool TEXT NOT NULL');
    expect(V55_SQL).toContain("args_redacted JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(V55_SQL).toContain('error_code TEXT');
    expect(V55_SQL).toContain('duration_ms INTEGER');
    expect(V55_SQL).toContain('request_id TEXT');
    expect(V55_SQL).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT now()');
    expect(V55_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_user ON agent_audit_logs (user_id, created_at DESC)');
    expect(V55_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_token ON agent_audit_logs (token_id, created_at DESC)');
  });

  it('enumerates the three decisions and the two outcomes with named CHECKs', () => {
    expect(parseInList('agent_audit_logs_decision_check', 'decision')).toEqual([
      'allowed',
      'denied',
      'confirm_required',
    ]);
    expect(parseInList('agent_audit_logs_result_check', 'result')).toEqual(['ok', 'error']);
    expect(V55_SQL).toContain(
      "decision TEXT NOT NULL CONSTRAINT agent_audit_logs_decision_check CHECK (decision IN ('allowed', 'denied', 'confirm_required'))",
    );
    expect(V55_SQL).toContain(
      "result TEXT CONSTRAINT agent_audit_logs_result_check CHECK (result IN ('ok', 'error'))",
    );
  });
});
