import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Todo 54 acceptance (plan checkbox 54): the documents migration is registered at
 * version 38 - NOT 36 as the plan text claimed, because 36 (maintenance plans) was
 * already taken when this landed. It is appended after 37 (attachments), picked up by
 * the runner in order, idempotent (IF NOT EXISTS everywhere) and purely additive.
 * `document_number_encrypted` is ciphertext-only; no byte columns.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';
import { registeredMigrationVersions } from './helpers.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const SCHEMA_SQL = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');

const REQUIRED_V38_MARKERS = [
  'CREATE TABLE IF NOT EXISTS documents',
  'idx_documents_user_expires',
  'idx_documents_user_kind',
  'idx_documents_active_expires',
  "CHECK (kind IN ('passport', 'id_card', 'driver_license', 'visa', 'certificate', 'policy', 'contract', 'other'))",
  'profile_id INTEGER',
  'document_number_encrypted TEXT',
  'issued_at DATE',
  'expires_at DATE',
  'country TEXT',
  'reminder_config JSONB',
  'is_active BOOLEAN NOT NULL DEFAULT TRUE',
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

describe('migration v38 registration (todo 54)', () => {
  it('applies v37 then v38 when the recorded max version is 36', async () => {
    await applyIncrementalMigrations(36);

    const sqls = mockQuery.mock.calls.map(([sql]) => sql);
    const v37Index = sqls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS attachments'));
    const v38Index = sqls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS documents'));
    expect(v37Index).toBeGreaterThanOrEqual(0);
    expect(v38Index).toBeGreaterThan(v37Index);

    const v38Sql = sqls[v38Index];
    for (const marker of REQUIRED_V38_MARKERS) {
      expect(v38Sql, `v38 missing ${marker}`).toContain(marker);
    }

    const inserts = versionInserts();
    expect(inserts.indexOf(37)).toBeGreaterThanOrEqual(0);
    // Later lanes append beyond 38 (v39 CRM); tolerance mirrors the v35-v36 precedent.
    expect(inserts[inserts.length - 1]).toBeGreaterThanOrEqual(38);
    expect(inserts.filter((v) => v === 38)).toHaveLength(1);
  });

  it('applies only v38 when the recorded max version is 37', async () => {
    await applyIncrementalMigrations(37);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS attachments')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS documents')).toHaveLength(1);
    // This test owns v38 only: it must be recorded exactly once, and v37 must not be
    // re-applied. Later migrations (v39+) may also run - tolerated per the v35-v36 precedent.
    const inserts = versionInserts();
    expect(inserts).toContain(38);
    expect(inserts.filter((v) => v === 38)).toHaveLength(1);
    expect(inserts).not.toContain(37);
  });

  it('stale_state: a recorded v38 row makes the runner skip v38 (no re-apply, no skip)', async () => {
    // Runner gates with `currentVersion < migration.version` and only writes the version
    // row after success, so a stale/enlarged schema_version cannot skip v38; re-running
    // the SQL by hand is still safe because every statement is IF NOT EXISTS-guarded.
    await applyIncrementalMigrations(38);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS documents')).toHaveLength(0);
    expect(versionInserts()).not.toContain(38);
  });

  it('does not record v38 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS documents')) {
        throw new Error('permission denied for table documents');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(37);

    expect(versionInserts()).not.toContain(38);
  });

  it('keeps every v38 statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(37);
    const [v38Sql] = callsMatching('CREATE TABLE IF NOT EXISTS documents');

    expect(v38Sql).not.toMatch(/\bCREATE TABLE(?! IF NOT EXISTS)/);
    expect(v38Sql).not.toMatch(/\bCREATE INDEX(?! IF NOT EXISTS)/);
    expect(v38Sql).not.toMatch(/\bCREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
    expect(v38Sql).not.toMatch(/\bDROP\b/i);
    expect(v38Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v38Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v38Sql).not.toMatch(/\bALTER\b/i);
    expect(v38Sql).not.toMatch(/\bUPDATE\s+/i);
    expect(v38Sql).not.toMatch(/\bBYTEA\b/i);
    // The number column is ciphertext-only; no plaintext column exists.
    expect(v38Sql).not.toMatch(/document_number\s+TEXT/);
    expect(v38Sql).toContain('document_number_encrypted TEXT');
  });

  it('registers v38 once, ascending, immediately after 37 in the source-of-truth list', () => {
    const versions = registeredMigrationVersions(MIGRATE_SOURCE);
    expect(versions).toContain(37);
    expect(versions).toContain(38);
    expect(versions.filter((v) => v === 38)).toHaveLength(1);
    expect(versions[versions.indexOf(37) + 1]).toBe(38);
    // Later lanes append beyond 38 (v39 CRM); tolerance mirrors the v35-v36 precedent.
    expect(versions[versions.length - 1]).toBeGreaterThanOrEqual(38);
    expect(Math.max(...versions)).toBeGreaterThanOrEqual(38);
  });

  it('mirrors the documents table into shared/src/schema.pg.sql with the same markers', () => {
    const mirrorMarkers = [
      'CREATE TABLE IF NOT EXISTS documents',
      'idx_documents_user_expires',
      'idx_documents_active_expires',
      'document_number_encrypted TEXT',
      "CHECK (kind IN ('passport', 'id_card', 'driver_license', 'visa', 'certificate', 'policy', 'contract', 'other'))",
    ];
    for (const marker of mirrorMarkers) {
      expect(SCHEMA_SQL, `schema.pg.sql missing ${marker}`).toContain(marker);
    }
  });
});
