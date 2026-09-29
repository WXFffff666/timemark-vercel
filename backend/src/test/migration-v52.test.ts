import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 105 acceptance: migration v52 creates the deterministic behavioural-pattern
 * store (`user_patterns`). The real chain max before this lane was 51
 * (`event_snoozed_until_v51`), so v52 is appended immediately after it.
 *
 * v52 is purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
 * no ALTER of existing tables, no backfill, no data migration. Re-running 52 (or applying
 * on top of a recorded 52) must not re-execute it, and a failing v52 must not be recorded
 * so the next cold start retries.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const MIGRATION_NAME = 'user_patterns_v52';

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

describe('migration v52 registration (checkbox 105)', () => {
  it('applies v52 when the recorded max version is 51 - proving the previous max was 51', async () => {
    await applyIncrementalMigrations(51);
    const [v52Sql] = callsMatching('CREATE TABLE IF NOT EXISTS user_patterns');
    expect(v52Sql).toBeDefined();
    expect(v52Sql).toContain('user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(v52Sql).toContain('kind TEXT NOT NULL');
    expect(v52Sql).toContain('key TEXT NOT NULL');
    expect(v52Sql).toContain('value JSONB NOT NULL');
    expect(v52Sql).toContain('confidence NUMERIC(4,3)');
    expect(v52Sql).toContain('evidence_count INTEGER');
    expect(v52Sql).toContain('computed_at TIMESTAMP');
    expect(v52Sql).toContain('UNIQUE (user_id, kind, key)');
    expect(v52Sql).not.toMatch(/\bDROP\b/i);
    expect(v52Sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(v52Sql).not.toMatch(/\bINSERT INTO\b/i);
    // v51 and earlier must not re-run on top of a recorded 51.
    expect(callsMatching('snoozed_until')).toHaveLength(0);
    expect(versionInserts()).toContain(52);
    expect(versionInserts()).not.toContain(51);
  });

  it('is idempotent: a recorded v52 row makes the runner skip v52 entirely', async () => {
    await applyIncrementalMigrations(52);
    expect(callsMatching('user_patterns')).toHaveLength(0);
    expect(versionInserts()).toEqual([53, 54]);
  });

  it('does not record v52 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('user_patterns')) throw new Error('permission denied for table users');
      return { rows: [], rowCount: 0 };
    });
    await applyIncrementalMigrations(51);
    expect(versionInserts()).not.toContain(52);
  });

  it('registers v52 once, ascending, immediately after 51 in the source-of-truth list', () => {
    const versions = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(versions).toContain(51);
    expect(versions).toContain(52);
    expect(versions.filter((v) => v === 52)).toHaveLength(1);
    expect(versions.indexOf(52)).toBe(versions.indexOf(51) + 1);
    expect(versions[versions.length - 1]).toBe(54);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${MIGRATION_NAME}'`);
    // Migrations 1-51 are untouched.
    expect(MIGRATE_SOURCE).toContain("name: 'event_snoozed_until_v51'");
  });

  it('keeps the miner deterministic: no LLM / network path in the service that writes the table', () => {
    const service = readFileSync(new URL('../services/patterns.service.ts', import.meta.url), 'utf8');
    expect(service).not.toContain('services/ai');
    expect(service).not.toMatch(/\bfetch\s*\(/);
    expect(service).not.toMatch(/openai|anthropic|gemini/i);
    expect(service).not.toMatch(/\bas any\b|@ts-ignore/);
    expect(service).not.toMatch(/console\.log/);
  });
});
