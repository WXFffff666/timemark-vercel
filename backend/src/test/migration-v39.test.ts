import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Todo 60 acceptance (plan checkbox 60): the personal-CRM migration is registered at
 * version 39 - NOT 37 as the plan text claimed, because 37 (attachments) and 38
 * (documents) were already taken when this landed. It is appended after 38, picked up
 * by the runner in order, idempotent (IF NOT EXISTS everywhere) and purely additive.
 * The only data write is the postMigrate `last_contact_at` backfill, guarded by
 * `last_contact_at IS NULL` so re-running never rewrites an existing anchor.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';
import { registeredMigrationVersions } from './helpers.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const SCHEMA_SQL = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');

const CRMCADENCE = 'crm_interactions_cadence_v39';

const REQUIRED_V39_MARKERS = [
  'ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS cadence_days INT NULL',
  'ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ NULL',
  'ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS cadence_enabled BOOLEAN DEFAULT FALSE',
  'CREATE TABLE IF NOT EXISTS interactions',
  'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE',
  'contact_id INTEGER NOT NULL REFERENCES fixed_contacts(id) ON DELETE CASCADE',
  "CHECK (kind IN ('call', 'message', 'meeting', 'meal', 'visit', 'gift', 'other'))",
  'occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP',
  'summary TEXT',
  'mood TEXT',
  'idx_interactions_user_contact_occurred',
  'CREATE TABLE IF NOT EXISTS contact_promises',
  'due_at DATE',
  'done_at TIMESTAMPTZ',
  'CREATE TABLE IF NOT EXISTS gift_records',
  "CHECK (direction IN ('given', 'received'))",
  'amount_cents BIGINT',
  'occurred_at DATE NOT NULL DEFAULT CURRENT_DATE',
];

function callsMatching(marker: string): string[] {
  return mockQuery.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes(marker));
}

function allSql(): string[] {
  return mockQuery.mock.calls.map(([sql]) => sql);
}

function versionInserts(): unknown[] {
  return mockQuery.mock.calls
    .filter(([sql]) => sql.includes('INSERT INTO schema_version'))
    .map(([, params]) => params?.[0]);
}

function backfillCall(): { sql: string; index: number } | null {
  const index = allSql().findIndex((sql) => sql.includes('UPDATE fixed_contacts fc'));
  if (index < 0) return null;
  return { sql: allSql()[index], index };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('migration v39 registration (todo 60)', () => {
  it('applies v38 then v39 when the recorded max version is 37', async () => {
    await applyIncrementalMigrations(37);

    const sqls = allSql();
    const v38Index = sqls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS documents'));
    const v39Index = sqls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS interactions'));
    expect(v38Index).toBeGreaterThanOrEqual(0);
    expect(v39Index).toBeGreaterThan(v38Index);

    const v39Sql = sqls[v39Index];
    for (const marker of REQUIRED_V39_MARKERS) {
      expect(v39Sql, `v39 missing ${marker}`).toContain(marker);
    }

    const inserts = versionInserts();
    expect(inserts.indexOf(38)).toBeGreaterThanOrEqual(0);
    // v39 is no longer the newest migration (v40 habits follows it); it is still
    // applied in order and recorded exactly once by this run.
    expect(inserts[inserts.length - 1]).toBeGreaterThanOrEqual(39);
    expect(inserts.filter((v) => v === 39)).toHaveLength(1);
  });

  it('applies only v39 when the recorded max version is 38', async () => {
    await applyIncrementalMigrations(38);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS documents')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS interactions')).toHaveLength(1);
    expect(versionInserts()).not.toContain(38);
    expect(versionInserts()).toContain(39);
  });

  it('stale_state: a recorded v39 row makes the runner skip v39 (no re-apply, no skip)', async () => {
    // Runner gates with `currentVersion < migration.version` and only writes the version
    // row after success, so a stale/enlarged schema_version cannot skip v39; re-running
    // the SQL by hand is still safe because every statement is IF NOT EXISTS-guarded.
    await applyIncrementalMigrations(39);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS interactions')).toHaveLength(0);
    expect(versionInserts()).not.toContain(39);
  });

  it('does not record v39 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS interactions')) {
        throw new Error('permission denied for table interactions');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(38);

    expect(versionInserts()).not.toContain(39);
  });

  it('keeps every v39 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(38);
    const [v39Sql] = callsMatching('CREATE TABLE IF NOT EXISTS interactions');

    expect(v39Sql).not.toMatch(/\bCREATE TABLE(?! IF NOT EXISTS)/);
    expect(v39Sql).not.toMatch(/\bCREATE INDEX(?! IF NOT EXISTS)/);
    expect(v39Sql).not.toMatch(/\bCREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
    expect(v39Sql).not.toMatch(/\bDROP\b/i);
    expect(v39Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v39Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v39Sql).not.toMatch(/\bUPDATE\s+/i);
    // Every ALTER must be an additive ADD COLUMN IF NOT EXISTS (no type changes/drops).
    const alterStatements = v39Sql.match(/ALTER TABLE[^;]+;/g) ?? [];
    expect(alterStatements).toHaveLength(3);
    for (const alter of alterStatements) {
      expect(alter).toMatch(/^ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS /);
    }
    // contact_methods (v30 JSONB) is not duplicated here.
    expect(v39Sql).not.toContain('contact_methods');
  });

  it('postMigrate backfills last_contact_at from the newest interaction, guarded by IS NULL', async () => {
    await applyIncrementalMigrations(38);

    const backfill = backfillCall();
    expect(backfill, 'v39 postMigrate backfill UPDATE not issued').not.toBeNull();
    expect(backfill!.sql).toContain('MAX(occurred_at)');
    expect(backfill!.sql).toContain('last_contact_at IS NULL');

    // It must run after the DDL created the interactions table, and before the
    // schema_version row is written (so a failure keeps v39 unrecorded).
    const sqls = allSql();
    const ddlIndex = sqls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS interactions'));
    const versionIndex = sqls.findIndex((sql) => sql.includes('INSERT INTO schema_version'));
    expect(ddlIndex).toBeGreaterThanOrEqual(0);
    expect(backfill!.index).toBeGreaterThan(ddlIndex);
    expect(backfill!.index).toBeLessThan(versionIndex);
  });

  it('does not record v39 when the postMigrate backfill fails', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('UPDATE fixed_contacts fc')) {
        throw new Error('deadlock detected');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(38);

    expect(versionInserts()).not.toContain(39);
  });

  it('a backfill that touched rows is logged (rowCount > 0) without failing the migration', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('UPDATE fixed_contacts fc')) {
        return { rows: [], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await applyIncrementalMigrations(38);

    expect(logSpy.mock.calls.some(([line]) => String(line).includes('Backfilled last_contact_at for 2 contact(s)'))).toBe(true);
    expect(versionInserts()).toContain(39);
    logSpy.mockRestore();
  });

  it('registers v39 once, ascending, immediately after 38 in the source-of-truth list', () => {
    const versions = registeredMigrationVersions(MIGRATE_SOURCE);
    expect(versions).toContain(38);
    expect(versions).toContain(39);
    expect(versions.filter((v) => v === 39)).toHaveLength(1);
    expect(versions[versions.indexOf(38) + 1]).toBe(39);
    expect(versions[versions.length - 1]).toBeGreaterThanOrEqual(39);

    // The migration name is discoverable for the evidence file.
    expect(MIGRATE_SOURCE).toContain(`name: '${CRMCADENCE}'`);
  });

  it('mirrors the CRM tables and the fixed_contacts base definition into shared/src/schema.pg.sql', () => {
    const mirrorMarkers = [
      'CREATE TABLE IF NOT EXISTS fixed_contacts',
      'contact_methods JSONB DEFAULT',
      'cadence_days INT',
      'last_contact_at TIMESTAMPTZ',
      'cadence_enabled BOOLEAN DEFAULT FALSE',
      'CREATE TABLE IF NOT EXISTS interactions',
      'idx_interactions_user_contact_occurred',
      "CHECK (kind IN ('call', 'message', 'meeting', 'meal', 'visit', 'gift', 'other'))",
      'CREATE TABLE IF NOT EXISTS contact_promises',
      'CREATE TABLE IF NOT EXISTS gift_records',
      "CHECK (direction IN ('given', 'received'))",
      'idx_gift_records_contact',
      'Mirrors backend/src/db/migrate.ts v39',
    ];
    for (const marker of mirrorMarkers) {
      expect(SCHEMA_SQL, `schema.pg.sql missing ${marker}`).toContain(marker);
    }
    // The base file runs BEFORE the migrations, so fixed_contacts is defined with its
    // full column set instead of ALTERs; later migrations must stay no-ops on it.
    expect(SCHEMA_SQL).not.toMatch(/ALTER TABLE fixed_contacts/);
    const fixedContactsBlock = SCHEMA_SQL.slice(SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS fixed_contacts')).split(');')[0];
    for (const col of ['user_id', 'preferred_channels', 'contact_methods', 'relationship', 'gender', 'validation_status']) {
      expect(fixedContactsBlock, `fixed_contacts base missing ${col}`).toContain(col);
    }
  });
});
