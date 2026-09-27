import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Todo 49/50 acceptance (plan checkboxes 49, 50): the inventory and maintenance
 * migrations are registered at 35 and 36 - NOT 33/34 as the plan text claimed,
 * because 33 (logging indexes) and 34 (expiry_items, the expiry lane) were already
 * taken when this landed. Both are appended in order after 34, picked up by the
 * runner, idempotent (IF NOT EXISTS everywhere) and purely additive.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const SCHEMA_SQL = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');

const REQUIRED_V35_MARKERS = [
  'CREATE TABLE IF NOT EXISTS inventory_items',
  'idx_inventory_items_user_expires',
  'idx_inventory_items_user_category',
  'idx_inventory_items_active_expires',
  "CHECK (category IN ('food', 'medicine', 'supply', 'other'))",
  'quantity NUMERIC NOT NULL DEFAULT 1 CHECK (quantity >= 0)',
  'low_stock_threshold NUMERIC',
  'purchased_at DATE',
  'expires_at DATE',
  'reminder_config JSONB',
  'is_active BOOLEAN NOT NULL DEFAULT TRUE',
];

const REQUIRED_V36_MARKERS = [
  'CREATE TABLE IF NOT EXISTS maintenance_plans',
  'CREATE TABLE IF NOT EXISTS maintenance_logs',
  'idx_maintenance_plans_user_due',
  'idx_maintenance_plans_user_kind',
  'idx_maintenance_plans_active_due',
  'idx_maintenance_logs_plan',
  "CHECK (asset_kind IN ('vehicle', 'appliance', 'device', 'other'))",
  "CHECK (usage_unit IS NULL OR usage_unit IN ('km', 'hours', 'cycles'))",
  'interval_days INTEGER',
  'interval_usage INTEGER',
  'current_usage NUMERIC',
  'last_done_at DATE',
  'next_due_at DATE',
  'next_due_usage NUMERIC',
  'CONSTRAINT maintenance_plans_interval_present CHECK (interval_days IS NOT NULL OR interval_usage IS NOT NULL)',
  'usage_at NUMERIC',
  'cost_cents BIGINT',
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

describe('migration v35 + v36 registration (todos 49, 50)', () => {
  it('applies v35 then v36 when the recorded max version is 34 (the pre-existing max)', async () => {
    await applyIncrementalMigrations(34);

    const sqls = mockQuery.mock.calls.map(([sql]) => sql);
    const v35Index = sqls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS inventory_items'));
    const v36Index = sqls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS maintenance_plans'));
    expect(v35Index).toBeGreaterThanOrEqual(0);
    expect(v36Index).toBeGreaterThan(v35Index);

    const v35Sql = sqls[v35Index];
    for (const marker of REQUIRED_V35_MARKERS) {
      expect(v35Sql, `v35 missing ${marker}`).toContain(marker);
    }
    const v36Sql = sqls[v36Index];
    for (const marker of REQUIRED_V36_MARKERS) {
      expect(v36Sql, `v36 missing ${marker}`).toContain(marker);
    }

    // Version rows are written only after their migration SQL ran, in ascending order.
    expect(versionInserts()).toEqual([35, 36]);
  });

  it('applies only v36 when the recorded max version is 35', async () => {
    await applyIncrementalMigrations(35);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS inventory_items')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS maintenance_plans')).toHaveLength(1);
    expect(versionInserts()).toEqual([36]);
  });

  it('stale_state: a recorded v36 row makes the runner a no-op (nothing is skipped or re-applied)', async () => {
    // The runner gates each migration with `currentVersion < migration.version`, so a
    // stale/enlarged schema_version cannot silently skip 35/36; re-running the SQL by
    // hand is still safe because every statement is IF NOT EXISTS-guarded.
    await applyIncrementalMigrations(36);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not record a version when its SQL fails, so a later cold start retries', async () => {
    // Fail the LAST migration (v36): v35 is recorded, v36 must not be.
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS maintenance_plans')) {
        throw new Error('permission denied for table maintenance_plans');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(34);

    expect(versionInserts()).toEqual([35]);
  });

  it('keeps every v35/v36 statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(34);
    const [v35Sql, v36Sql] = [
      callsMatching('CREATE TABLE IF NOT EXISTS inventory_items')[0],
      callsMatching('CREATE TABLE IF NOT EXISTS maintenance_plans')[0],
    ];

    for (const sql of [v35Sql, v36Sql]) {
      expect(sql).not.toMatch(/\bCREATE TABLE(?! IF NOT EXISTS)/);
      expect(sql).not.toMatch(/\bCREATE INDEX(?! IF NOT EXISTS)/);
      expect(sql).not.toMatch(/\bCREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
      expect(sql).not.toMatch(/\bDROP\b/i);
      expect(sql).not.toMatch(/\bTRUNCATE\b/i);
      expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(sql).not.toMatch(/\bALTER\b/i);
      expect(sql).not.toMatch(/\bUPDATE\s+maintenance/i);
      expect(sql).not.toMatch(/\bUPDATE\s+inventory/i);
    }
  });

  it('bumps the source-of-truth migration list to exactly 36, ascending, with 34 immediately before 35', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[versions.length - 1]).toBe(36);
    expect(Math.max(...versions)).toBe(36);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }

    // The pre-existing max was 34 (the expiry lane owns it); 35/36 were appended right after.
    const idx34 = versions.indexOf(34);
    expect(idx34).toBeGreaterThanOrEqual(0);
    expect(versions[idx34 + 1]).toBe(35);
    expect(versions[idx34 + 2]).toBe(36);
    expect(versions.filter((v) => v === 34)).toHaveLength(1);
    expect(versions.filter((v) => v === 35)).toHaveLength(1);
    expect(versions.filter((v) => v === 36)).toHaveLength(1);
  });

  it('mirrors both migrations into shared/src/schema.pg.sql with the same markers', () => {
    const mirrorMarkers = [
      'CREATE TABLE IF NOT EXISTS inventory_items',
      'idx_inventory_items_user_expires',
      'idx_inventory_items_active_expires',
      'CREATE TABLE IF NOT EXISTS maintenance_plans',
      'CREATE TABLE IF NOT EXISTS maintenance_logs',
      'idx_maintenance_plans_user_due',
      'idx_maintenance_logs_plan',
      'CONSTRAINT maintenance_plans_interval_present',
    ];
    for (const marker of mirrorMarkers) {
      expect(SCHEMA_SQL, `schema.pg.sql missing ${marker}`).toContain(marker);
    }
  });
});
