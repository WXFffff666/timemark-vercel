import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Todo 44 acceptance (plan checkbox 44): the expiry domain migration is registered
 * at version 34 - NOT 32 as the plan text claimed, because 32 and 33 were already
 * taken when this landed - it is appended after 33, picked up by the runner,
 * idempotent (IF NOT EXISTS everywhere) and purely additive.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');

const REQUIRED_V34_MARKERS = [
  'CREATE TABLE IF NOT EXISTS expiry_items',
  'CREATE TABLE IF NOT EXISTS expiry_history',
  'idx_expiry_items_user_due',
  'idx_expiry_items_user_kind',
  'idx_expiry_items_active_due',
  'idx_expiry_history_item',
  "CHECK (kind IN ('subscription', 'bill', 'insurance', 'domain', 'warranty', 'custom'))",
  "CHECK (cycle IN ('once', 'monthly', 'quarterly', 'yearly', 'custom'))",
  'profile_id INTEGER',
  'amount_cents BIGINT',
  'tags TEXT[]',
  'reminder_config JSONB',
  'is_active BOOLEAN NOT NULL DEFAULT TRUE',
];

function versionInserts(): unknown[] {
  return mockQuery.mock.calls
    .filter(([sql]) => sql.includes('INSERT INTO schema_version'))
    .map(([, params]) => params?.[0]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('migration v34 registration (todo 44)', () => {
  it('applies v34 when the recorded max version is 33 (the pre-existing max)', async () => {
    await applyIncrementalMigrations(33);

    const [v34Sql] = mockQuery.mock.calls[0];
    for (const marker of REQUIRED_V34_MARKERS) {
      expect(v34Sql, `missing ${marker}`).toContain(marker);
    }
    // The version row is written only after the migration SQL ran.
    expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO schema_version');
    // Later migrations (v35/v36 inventory/maintenance) may follow; v34 itself must be
    // applied first and exactly once.
    const inserts = versionInserts();
    expect(inserts[0]).toBe(34);
    expect(inserts.filter((v) => v === 34)).toHaveLength(1);
  });

  it('applies v33 before v34 in ascending order when the recorded max version is 32', async () => {
    await applyIncrementalMigrations(32);

    const sqls = mockQuery.mock.calls.map(([sql]) => sql);
    const v33Index = sqls.findIndex((sql) => sql.includes('pg_trgm'));
    const v34Index = sqls.findIndex((sql) => sql.includes('expiry_items_v34') || sql.includes('CREATE TABLE IF NOT EXISTS expiry_items'));
    expect(v33Index).toBeGreaterThanOrEqual(0);
    expect(v34Index).toBeGreaterThan(v33Index);
    expect(versionInserts().slice(0, 2)).toEqual([33, 34]);
  });

  it('is a runner-level no-op for v34 when version 34 is already recorded', async () => {
    // Runner behaviour: `currentVersion < migration.version` gates each migration and the
    // version row is INSERTed only after the SQL succeeds, so v34 cannot be skipped by a
    // stale row unless a human tampered with schema_version; re-running the SQL by hand is
    // still safe because every statement is IF NOT EXISTS-guarded. Only later migrations
    // (v35/v36) are pending once 34 is recorded.
    await applyIncrementalMigrations(34);
    const sqls = mockQuery.mock.calls.map(([sql]) => sql);
    expect(sqls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS expiry_items'))).toBe(false);
    expect(versionInserts()).not.toContain(34);
  });

  it('does not record v34 when the migration SQL fails, so a later startup retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS expiry_items')) {
        throw new Error('permission denied for table expiry_items');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(33);

    expect(versionInserts()).not.toContain(34);
  });

  it('keeps every v34 statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(33);
    const [v34Sql] = mockQuery.mock.calls[0];

    expect(v34Sql).not.toMatch(/\bCREATE TABLE(?! IF NOT EXISTS)/);
    expect(v34Sql).not.toMatch(/\bCREATE INDEX(?! IF NOT EXISTS)/);
    expect(v34Sql).not.toMatch(/\bCREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
    expect(v34Sql).not.toMatch(/\bDROP\b/i);
    expect(v34Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v34Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v34Sql).not.toMatch(/\bALTER\b/i);
    // No data rewrite in a schema migration; the only UPDATE-ish token is updated_at.
    expect(v34Sql).not.toMatch(/\bUPDATE\s+expiry/i);
  });

  it('bumps the source-of-truth migration list with v34 once, in ascending order', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions.length).toBeGreaterThan(0);
    // Strictly ascending: no reuse, no renumber, no gap left for another lane to collide with.
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    // The pre-existing max was 33 (v32 = session_data_text, v33 = logging indexes), which is
    // why the plan's "version: 32" instruction could not be followed literally.
    expect(versions).toContain(33);
    expect(versions).toContain(34);
    expect(versions.filter((v) => v === 34)).toHaveLength(1);
  });
});
