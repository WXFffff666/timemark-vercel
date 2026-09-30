import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Todo 71 acceptance (plan checkbox 71): the medication domain migration is
 * registered at version 42 - NOT 41 as the plan text claimed, because 41
 * (profiles) was taken by todo 68 when this landed (41 is the previous max in
 * the source list). It is appended after 41, picked up by the runner in order,
 * idempotent (every statement is IF NOT EXISTS-guarded) and purely additive:
 * the only ALTER is ADD COLUMN IF NOT EXISTS and there is no data write at all.
 *
 * `is_critical` is part of v42 from the start (the plan listed it as a later
 * addition, but v42 is the migration that lands). Reminder and log only: no
 * medical advice, no pharmacy integration.
 *
 * The live behaviour (3 daily times -> 3 pending dose rows for today, UNIQUE
 * double-materialisation rejection, past end_date -> zero doses) is proven
 * against PGlite in the live harness.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const SCHEMA_SQL = readFileSync(new URL('../../../shared/src/schema.pg.sql', import.meta.url), 'utf8');

const MEDICATIONS_MIGRATION = 'medications_v42';

const REQUIRED_V42_MARKERS = [
  'CREATE TABLE IF NOT EXISTS medications',
  'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE',
  'profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL',
  'name TEXT NOT NULL',
  'dosage TEXT',
  "CHECK (form IN ('tablet', 'capsule', 'liquid', 'injection', 'patch', 'drops', 'other'))",
  "schedule_times TEXT[] NOT NULL DEFAULT '{}'",
  'schedule_days INTEGER[]',
  'start_date DATE NOT NULL',
  'end_date DATE CHECK (end_date IS NULL OR end_date >= start_date)',
  'stock_quantity NUMERIC',
  'units_per_dose NUMERIC NOT NULL DEFAULT 1 CHECK (units_per_dose > 0)',
  'refill_threshold NUMERIC',
  'is_critical BOOLEAN NOT NULL DEFAULT FALSE',
  'CREATE TABLE IF NOT EXISTS medication_doses',
  'medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE',
  'scheduled_for TIMESTAMPTZ NOT NULL',
  'logged_at TIMESTAMPTZ',
  "CHECK (status IN ('taken', 'skipped', 'missed', 'pending'))",
  'UNIQUE (medication_id, scheduled_for)',
  'CREATE INDEX IF NOT EXISTS idx_medications_user_profile ON medications(user_id, profile_id)',
  'CREATE INDEX IF NOT EXISTS idx_medication_doses_user_scheduled ON medication_doses(user_id, scheduled_for)',
  'CREATE INDEX IF NOT EXISTS idx_medication_doses_med_status ON medication_doses(medication_id, status)',
  'ALTER TABLE medications ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL',
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

describe('migration v42 registration (todo 71)', () => {
  it('applies v42 when the recorded max version is 41 - proving the previous max was 41', async () => {
    await applyIncrementalMigrations(41);

    const [v42Sql] = callsMatching('CREATE TABLE IF NOT EXISTS medications');
    expect(v42Sql).toBeDefined();
    for (const marker of REQUIRED_V42_MARKERS) {
      expect(v42Sql, `v42 missing ${marker}`).toContain(marker);
    }
    // v41 must not re-run on top of a recorded 41.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS profiles')).toHaveLength(0);

    const inserts = versionInserts();
    expect(inserts).toContain(42);
    expect(inserts).not.toContain(41);
  });

  it('stale-state: a recorded v42 row makes the runner skip v42 (no re-apply, no duplicate write)', async () => {
    await applyIncrementalMigrations(42);

    expect(callsMatching('CREATE TABLE IF NOT EXISTS medications')).toHaveLength(0);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS medication_doses')).toHaveLength(0);
    expect(versionInserts()).not.toContain(42);
  });

  it('does not record v42 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE IF NOT EXISTS medication_doses')) {
        throw new Error('permission denied for table medication_doses');
      }
      return { rows: [], rowCount: 0 };
    });

    await applyIncrementalMigrations(41);

    expect(versionInserts()).not.toContain(42);
  });

  it('keeps every v42 DDL statement additive and IF NOT EXISTS-guarded', async () => {
    await applyIncrementalMigrations(41);
    const [v42Sql] = callsMatching('CREATE TABLE IF NOT EXISTS medications');

    expect(v42Sql).not.toMatch(/\bCREATE TABLE(?! IF NOT EXISTS)/);
    expect(v42Sql).not.toMatch(/\bCREATE INDEX(?! IF NOT EXISTS)/);
    expect(v42Sql).not.toMatch(/\bCREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
    expect(v42Sql).not.toMatch(/\bDROP\b/i);
    expect(v42Sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(v42Sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(v42Sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    // Exactly one ALTER, and it is additive.
    const alterStatements = v42Sql.match(/ALTER TABLE[^;]+;/g) ?? [];
    expect(alterStatements).toHaveLength(1);
    expect(alterStatements[0]).toMatch(/^ALTER TABLE medications ADD COLUMN IF NOT EXISTS profile_id /);
    // Reminder + log only: no medical-advice or pharmacy-integration columns.
    expect(v42Sql).not.toMatch(/\badvice\b/i);
    expect(v42Sql).not.toMatch(/\bpharmacy_id\b/i);
  });

  it('registers v42 once, ascending, immediately after 41 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(41);
    expect(versions).toContain(42);
    expect(versions.filter((v) => v === 42)).toHaveLength(1);
    expect(versions.indexOf(42)).toBe(versions.indexOf(41) + 1);
    // v43 (todo 70) and v44 (todo 81, goals/milestones) landed right after v42, so 42 is
    // no longer the tail - assert the chain continues instead of pinning 42 as last.
    expect(versions.filter((v) => v === 43)).toHaveLength(1);
    expect(versions.indexOf(43)).toBe(versions.indexOf(42) + 1);
    expect(versions.filter((v) => v === 44)).toHaveLength(1);
    expect(versions.indexOf(44)).toBe(versions.indexOf(43) + 1);
    // v45 (todo 78) and v46 (checkbox 80, digest preferences) continue the chain.
    expect(versions.indexOf(45)).toBe(versions.indexOf(44) + 1);
    expect(versions.indexOf(46)).toBe(versions.indexOf(45) + 1);
    // v47 (checkbox 86, CalDAV write-back) and v48 (checkbox 89, public ICS feeds)
    // continue the chain; 46 is no longer the tail.
    expect(versions.indexOf(47)).toBe(versions.indexOf(46) + 1);
    expect(versions.indexOf(48)).toBe(versions.indexOf(47) + 1);
    // v49 (checkbox 91, Telegram bot update dedup) then v50 (checkbox 94, chat linking)
    // continue the chain; 49 is no longer the tail.
    expect(versions.indexOf(49)).toBe(versions.indexOf(48) + 1);
    // v51 (checkbox 97, /snooze persistence) is the new tail; 1-50 stay untouched.
    expect(versions[versions.length - 1]).toBe(75);

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${MEDICATIONS_MIGRATION}'`);
    // Migrations 1-40 are untouched: the source still contains every original name.
    expect(MIGRATE_SOURCE).toContain("name: 'profiles_v41'");
    expect(MIGRATE_SOURCE).toContain("name: 'habits_v40'");
  });

  it('mirrors medications and medication_doses into shared/src/schema.pg.sql', () => {
    for (const marker of [
      'CREATE TABLE IF NOT EXISTS medications',
      "CHECK (form IN ('tablet', 'capsule', 'liquid', 'injection', 'patch', 'drops', 'other'))",
      'is_critical BOOLEAN NOT NULL DEFAULT FALSE',
      'CREATE TABLE IF NOT EXISTS medication_doses',
      'UNIQUE (medication_id, scheduled_for)',
      'idx_medication_doses_user_scheduled',
      'idx_medication_doses_med_status',
      'backend/src/db/migrate.ts v42',
    ]) {
      expect(SCHEMA_SQL, `schema.pg.sql missing ${marker}`).toContain(marker);
    }
  });
});
