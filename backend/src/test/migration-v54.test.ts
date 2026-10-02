import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 112 acceptance: migration v54 adds the durable background-job schema
 * (`agent_jobs` + `agent_job_events` + `agent_workers` + `agent_routines`). The real
 * chain max before this lane was 53 (`search_trgm_embeddings_v53`, verified by reading
 * migrate.ts immediately before appending), so v54 is appended immediately after it.
 *
 * v54 is purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
 * no ALTER of existing tables, no backfill, no data migration. Re-running 54 (or applying
 * on top of a recorded 54) must not re-execute it, and a failing v54 must not be recorded
 * so the next cold start retries.
 *
 * The executed engine-level proof (PGlite: apply twice, duplicate idempotency key
 * rejected 23505, 1000-row EXPLAIN uses idx_agent_jobs_claim, unknown kind rejected with
 * the named CHECK) lives in the out-of-repo harness
 * `%TEMP%/opencode/wave14-112-jobschema/probe.mjs`; this file pins the shipped DDL and
 * its registration in the one source-of-truth migration list.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';
import { migrationSqlFor, registeredMigrationVersions } from './helpers.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const MIGRATION_NAME = 'agent_jobs_v54';

const V54_SQL = migrationSqlFor(MIGRATE_SOURCE, MIGRATION_NAME);

/**
 * The five job kinds the plan defines for Wave 14/15. The routines (122-125) and the
 * self-watchdog (121/130) are the consumers of the queue; no other kind exists yet, so
 * the CHECK rejects anything else at the schema level.
 */
const KNOWN_KINDS = ['evening_review', 'hourly_triage', 'morning_brief', 'watchdog', 'weekly_review'];
const JOB_STATUSES = ['queued', 'leased', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled'];

function parseInList(constraint: string, column: string): string[] {
  const match = V54_SQL.match(new RegExp(`${constraint} CHECK \\(${column} IN \\(([^)]*)\\)\\)`));
  if (!match) throw new Error(`missing ${constraint} in v54 SQL`);
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

describe('migration v54 registration (checkbox 112)', () => {
  it('applies v54 when the recorded max version is 53 - proving the previous max was 53', async () => {
    await applyIncrementalMigrations(53);
    const [v54Sql] = callsMatching('CREATE TABLE IF NOT EXISTS agent_jobs');
    expect(v54Sql).toBeDefined();
    expect(v54Sql).toContain('CREATE TABLE IF NOT EXISTS agent_jobs');
    expect(v54Sql).toContain('CREATE TABLE IF NOT EXISTS agent_routines');
    // v53 and earlier must not re-run on top of a recorded 53. (v57 also ships gin_trgm_ops,
    // so key on the v53-only `idx_events_name_trgm` index name instead.)
    expect(callsMatching('idx_events_name_trgm')).toHaveLength(0);
    // v63's SQL mentions `user_patterns` in a doc comment, so the marker must be the DDL.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS user_patterns')).toHaveLength(0);
    expect(versionInserts()).toContain(54);
    expect(versionInserts()).not.toContain(53);
  });

  it('is idempotent: a recorded v54 row makes the runner skip v54 entirely', async () => {
    await applyIncrementalMigrations(54);
    expect(callsMatching('agent_jobs')).toHaveLength(0);
    expect(callsMatching('agent_routines')).toHaveLength(0);
    // v55 (checkbox 101) is the tail after v54; applying on a recorded 54 runs only v55.
    expect(versionInserts()).toEqual(registeredMigrationVersions(MIGRATE_SOURCE).filter((v) => v > 54));
  });

  it('does not record v54 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('agent_jobs_kind_check')) throw new Error('permission denied for table users');
      return { rows: [], rowCount: 0 };
    });
    await applyIncrementalMigrations(53);
    expect(versionInserts()).not.toContain(54);
  });

  it('registers v54 once, ascending, immediately after 53 in the source-of-truth list', () => {
    const versions = registeredMigrationVersions(MIGRATE_SOURCE);
    expect(versions.filter((v) => v === 54)).toHaveLength(1);
    expect(versions.indexOf(54)).toBe(versions.indexOf(53) + 1);
    expect(MIGRATE_SOURCE).toContain(`name: '${MIGRATION_NAME}'`);
    // Migrations 1-53 are untouched.
    expect(MIGRATE_SOURCE).toContain("name: 'search_trgm_embeddings_v53'");
    expect(MIGRATE_SOURCE).toContain("name: 'user_patterns_v52'");
    expect(MIGRATE_SOURCE).toContain("name: 'event_snoozed_until_v51'");
  });

  it('is re-runnable: every statement is IF NOT EXISTS-guarded and additive-only', () => {
    expect(V54_SQL).not.toMatch(/CREATE TABLE\s+(?!IF NOT EXISTS)/i);
    expect(V54_SQL).not.toMatch(/CREATE INDEX\s+(?!IF NOT EXISTS)/i);
    expect(V54_SQL).not.toMatch(/CREATE UNIQUE INDEX\s+(?!IF NOT EXISTS)/i);
    expect(V54_SQL).not.toMatch(/\bDROP\b/i);
    expect(V54_SQL).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(V54_SQL).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(V54_SQL).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(V54_SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(V54_SQL.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(4);
    expect(V54_SQL.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g)).toHaveLength(6);
    // The queue table - not workflow retention - is the source of truth.
    expect(V54_SQL).not.toMatch(/\bworkflow\b/i);
    expect(V54_SQL).not.toContain('retention');
  });

  it('enumerates the known kinds with a named CHECK so an unknown kind is rejected', () => {
    expect(parseInList('agent_jobs_kind_check', 'kind')).toEqual(KNOWN_KINDS);
    const unknownKinds = ['brief', 'review', 'digest', 'triage', 'nonsense', 'agent_jobs'];
    for (const unknown of unknownKinds) {
      expect(KNOWN_KINDS).not.toContain(unknown);
    }
    expect(V54_SQL).toContain('kind TEXT NOT NULL CONSTRAINT agent_jobs_kind_check CHECK');
  });

  it('enumerates the seven job lifecycle states with a named CHECK', () => {
    expect(parseInList('agent_jobs_status_check', 'status')).toEqual(JOB_STATUSES);
    expect(V54_SQL).toContain("status TEXT NOT NULL DEFAULT 'queued' CONSTRAINT agent_jobs_status_check CHECK");
  });

  it('creates the required columns, the unique partial idempotency index and the queue indexes', () => {
    for (const pin of [
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'user_id INTEGER REFERENCES users(id) ON DELETE CASCADE',
      'payload JSONB NOT NULL DEFAULT',
      'priority INTEGER NOT NULL DEFAULT 0',
      'attempt INTEGER NOT NULL DEFAULT 0',
      'max_attempts INTEGER NOT NULL DEFAULT 3',
      'idempotency_key TEXT',
      'lease_owner TEXT',
      'lease_token UUID',
      'lease_expires_at TIMESTAMPTZ',
      'last_heartbeat_at TIMESTAMPTZ',
      'run_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      'started_at TIMESTAMPTZ',
      'finished_at TIMESTAMPTZ',
      'error_code TEXT',
      'error_message TEXT',
      'result JSONB',
      'cost_tokens INTEGER NOT NULL DEFAULT 0',
      'created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      'updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
    ]) {
      expect(V54_SQL, `missing column DDL: ${pin}`).toContain(pin);
    }
    expect(V54_SQL).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_idempotency ON agent_jobs (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;',
    );
    expect(V54_SQL).toContain('idx_agent_jobs_claim ON agent_jobs (status, run_at)');
    expect(V54_SQL).toContain('idx_agent_jobs_kind_status ON agent_jobs (kind, status)');
    expect(V54_SQL).toContain('idx_agent_jobs_user_created ON agent_jobs (user_id, created_at DESC)');
  });

  it('creates the events, workers and routines tables with their keys and cascade', () => {
    expect(V54_SQL).toContain('CREATE TABLE IF NOT EXISTS agent_job_events');
    expect(V54_SQL).toContain('id BIGSERIAL PRIMARY KEY');
    expect(V54_SQL).toContain('job_id UUID NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE');
    expect(V54_SQL).toContain('at TIMESTAMPTZ NOT NULL DEFAULT now()');
    expect(V54_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_agent_job_events_job ON agent_job_events (job_id, at)');
    expect(V54_SQL).toContain('CREATE TABLE IF NOT EXISTS agent_workers');
    expect(V54_SQL).toContain('id TEXT PRIMARY KEY');
    expect(V54_SQL).toContain('CREATE TABLE IF NOT EXISTS agent_routines');
    expect(V54_SQL).toContain('UNIQUE (user_id, name)');
    expect(V54_SQL).toContain('enabled BOOLEAN NOT NULL DEFAULT FALSE');
    expect(V54_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_agent_routines_due ON agent_routines (enabled, next_run_at)');
  });
});
