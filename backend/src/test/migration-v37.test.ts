import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Todo 52 acceptance (plan checkbox 52): the attachments migration is registered at
 * version 37 - NOT 35 as the plan text claimed, because 35 (inventory) and 36
 * (maintenance) were already taken when this landed. It is appended after 36, picked
 * up by the runner in order, idempotent (IF NOT EXISTS everywhere) and purely additive.
 * Attachment METADATA only: bytes live in object storage, never in Postgres.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const SCHEMA_SQL = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');

const REQUIRED_V37_MARKERS = [
  'CREATE TABLE IF NOT EXISTS attachments',
  'idx_attachments_user_owner',
  'owner_type TEXT CHECK (owner_type IS NULL OR owner_type IN (\'document\', \'expiry\', \'inventory\', \'maintenance\', \'event\'))',
  'owner_id INTEGER',
  'filename TEXT NOT NULL',
  'content_type TEXT NOT NULL',
  'byte_size INTEGER NOT NULL CHECK (byte_size > 0)',
  'sha256 TEXT NOT NULL',
  'storage_key TEXT NOT NULL',
  'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  'CONSTRAINT attachments_owner_pair CHECK ((owner_type IS NULL) = (owner_id IS NULL))',
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

describe('migration v37 registration (todo 52)', () => {
  it('applies v37 when the recorded max version is 36 (the pre-existing max)', async () => {
    await applyIncrementalMigrations(36);

    const [v37Sql] = callsMatching('CREATE TABLE IF NOT EXISTS attachments');
    expect(v37Sql).toBeDefined();
    for (const marker of REQUIRED_V37_MARKERS) {
      expect(v37Sql, `v37 missing ${marker}`).toContain(marker);
    }

    // The version row is written only after the migration SQL ran. Later migrations
    // (v38 documents) may follow, so 37 must be first and unique rather than last.
    const inserts = versionInserts();
    expect(inserts[0]).toBe(37);
    expect(inserts.filter((v) => v === 37)).toHaveLength(1);
    if (inserts.includes(38)) {
      expect(inserts.indexOf(38)).toBeGreaterThan(inserts.indexOf(37));
    }
  });

  it('applies only v37 when the recorded max version is 36 and no later migration exists yet', async () => {
    await applyIncrementalMigrations(36);
    // v36 tables must not be re-created by the v37 SQL.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS maintenance_plans')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS inventory_items')).toHaveLength(0);
    expect(versionInserts()).not.toContain(36);
  });

  it('stale_state: a recorded v37 row makes the runner skip v37 (no re-apply, nothing skipped)', async () => {
    // The runner gates each migration with `currentVersion < migration.version`, so a
    // schema_version row of 37 cannot cause v37 to be re-applied; re-running the SQL by
    // hand is still safe because every statement is IF NOT EXISTS-guarded.
    await applyIncrementalMigrations(37);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS attachments')).toHaveLength(0);
    expect(versionInserts()).not.toContain(37);
  });

  it('does not record v37 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS attachments')) {
        throw new Error('permission denied for table attachments');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(36);

    expect(versionInserts()).not.toContain(37);
  });

  it('keeps every v37 statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(36);
    const [v37Sql] = callsMatching('CREATE TABLE IF NOT EXISTS attachments');

    expect(v37Sql).not.toMatch(/\bCREATE TABLE(?! IF NOT EXISTS)/);
    expect(v37Sql).not.toMatch(/\bCREATE INDEX(?! IF NOT EXISTS)/);
    expect(v37Sql).not.toMatch(/\bCREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
    expect(v37Sql).not.toMatch(/\bDROP\b/i);
    expect(v37Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v37Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v37Sql).not.toMatch(/\bALTER\b/i);
    expect(v37Sql).not.toMatch(/\bUPDATE\s+/i);
    // No byte columns in Postgres: the row is metadata only.
    expect(v37Sql).not.toMatch(/\bBYTEA\b/i);
    expect(v37Sql).not.toMatch(/\bBLOB\b/i);
  });

  it('registers v37 once, ascending, immediately after 36 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(36);
    expect(versions).toContain(37);
    expect(versions.filter((v) => v === 37)).toHaveLength(1);
    expect(versions[versions.indexOf(36) + 1]).toBe(37);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
  });

  it('mirrors the attachments table into shared/src/schema.pg.sql with the same markers', () => {
    const mirrorMarkers = [
      'CREATE TABLE IF NOT EXISTS attachments',
      'idx_attachments_user_owner',
      'CONSTRAINT attachments_owner_pair',
      'byte_size INTEGER NOT NULL CHECK (byte_size > 0)',
      'storage_key TEXT NOT NULL',
    ];
    for (const marker of mirrorMarkers) {
      expect(SCHEMA_SQL, `schema.pg.sql missing ${marker}`).toContain(marker);
    }
  });
});
