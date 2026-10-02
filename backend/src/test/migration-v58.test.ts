import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 134 acceptance: migration v58 adds the cross-entity tag schema.
 *
 * The real max before this lane was 57 (`search_trgm_remaining_v57`, read from migrate.ts
 * immediately before appending), so v58 is appended immediately after it - the runner only
 * applies a migration when `currentVersion < version` while walking the array in order, so a
 * lower number appended later would never run.
 *
 * v58 is purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no ALTER
 * of existing tables, no backfill, no data migration. Re-running (or applying on top of a
 * recorded 58) is a no-op, and a failing v58 must not be recorded so the next cold start
 * retries. The DDL is paired with the service's `TAG_ENTITY_TYPES` so the CHECK constraint and
 * the application's allowed values cannot drift apart.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';
import { TAG_ENTITY_TYPES } from '../services/tag.service.js';
import { registeredMigrationVersions } from './helpers.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const MIGRATION_NAME = 'tags_tag_links_v58';

function migrationSql(marker: string): string {
  const nameIndex = MIGRATE_SOURCE.indexOf(`name: '${marker}'`);
  if (nameIndex < 0) throw new Error(`migration ${marker} not found in migrate.ts`);
  const sqlStart = MIGRATE_SOURCE.indexOf('sql: `', nameIndex);
  const sqlEnd = MIGRATE_SOURCE.indexOf('`,', sqlStart);
  return MIGRATE_SOURCE.slice(sqlStart + 'sql: `'.length, sqlEnd);
}

const V58_SQL = migrationSql(MIGRATION_NAME);

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

describe('migration v58 registration (checkbox 134)', () => {
  it('applies v58 when the recorded max version is 57 - proving the previous max was 57', async () => {
    await applyIncrementalMigrations(57);
    const [v58Sql] = callsMatching('CREATE TABLE IF NOT EXISTS tags');
    expect(v58Sql).toBeDefined();
    expect(v58Sql).toContain('CREATE TABLE IF NOT EXISTS tags');
    expect(v58Sql).toContain('CREATE TABLE IF NOT EXISTS tag_links');
    // v57 and earlier must not re-run on top of a recorded 57.
    expect(callsMatching('idx_inbox_messages_body_trgm')).toHaveLength(0);
    expect(callsMatching('search_trgm_embeddings')).toHaveLength(0);
    expect(versionInserts()).toContain(58);
    expect(versionInserts()).not.toContain(57);
  });

  it('is idempotent: a recorded v58 row makes the runner skip v58 entirely', async () => {
    await applyIncrementalMigrations(58);
    expect(callsMatching('CREATE TABLE IF NOT EXISTS tags')).toHaveLength(0);
    expect(callsMatching('tag_links')).toHaveLength(0);
    expect(versionInserts()).toEqual([59, 60, 61, 62, 63, 64, 65, 67, 69, 70, 71, 72, 73, 74, 75]);
  });

  it('does not record v58 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('tag_links_entity_type_check')) throw new Error('permission denied for table tags');
      return { rows: [], rowCount: 0 };
    });
    await applyIncrementalMigrations(57);
    expect(versionInserts()).not.toContain(58);
  });

  it('registers v58 once, ascending, immediately after 57 as the tail of the source-of-truth list', () => {
    const versions = registeredMigrationVersions(MIGRATE_SOURCE);
    expect(versions.filter((v) => v === 58)).toHaveLength(1);
    expect(versions.indexOf(58)).toBe(versions.indexOf(57) + 1);
    expect(versions[versions.length - 1]).toBe(75);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    expect(MIGRATE_SOURCE).toContain(`name: '${MIGRATION_NAME}'`);
    // Migrations 1-57 are untouched.
    expect(MIGRATE_SOURCE).toContain("name: 'search_trgm_remaining_v57'");
    expect(MIGRATE_SOURCE).toContain("name: 'agent_confirmations_v56'");
  });

  it('creates the two tables with the plan columns and the unique keys', () => {
    expect(V58_SQL).toContain('CREATE TABLE IF NOT EXISTS tags (');
    expect(V58_SQL).toContain('user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(V58_SQL).toContain('name TEXT NOT NULL');
    expect(V58_SQL).toContain('color TEXT');
    expect(V58_SQL).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT now()');
    expect(V58_SQL).toContain('UNIQUE (user_id, name)');

    expect(V58_SQL).toContain('CREATE TABLE IF NOT EXISTS tag_links (');
    expect(V58_SQL).toContain('tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE');
    expect(V58_SQL).toContain('entity_type TEXT NOT NULL');
    expect(V58_SQL).toContain('entity_id INTEGER NOT NULL');
    expect(V58_SQL).toContain('UNIQUE (tag_id, entity_type, entity_id)');
  });

  it('pairs the entity_type CHECK with the service vocabulary (drift guard)', () => {
    expect(V58_SQL).toContain('tag_links_entity_type_check');
    for (const entityType of TAG_ENTITY_TYPES) {
      expect(V58_SQL, `CHECK is missing ${entityType}`).toContain(`'${entityType}'`);
    }
    // Exactly the eight plan entity kinds, no more.
    const checkMatch = /CHECK \(entity_type IN \(([^)]+)\)\)/.exec(V58_SQL);
    expect(checkMatch).not.toBeNull();
    const values = checkMatch![1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
    expect(values.sort()).toEqual([...TAG_ENTITY_TYPES].sort());
  });

  it('deleting a tag cascades its links only (entities are other tables, never touched)', () => {
    // The cascade lives on tag_links.tag_id, NOT on entity_id (which has no FK - it spans eight
    // tables). That is what "delete removes links but not the entities" means at the DDL level.
    expect(V58_SQL).toContain('tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE');
    expect(V58_SQL).not.toMatch(/entity_id INTEGER[^,\n]*REFERENCES/i);
  });

  it('ships the filter indexes: (user_id, entity_type, entity_id) and (tag_id, entity_type)', () => {
    expect(V58_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_tag_links_entity ON tag_links (user_id, entity_type, entity_id)');
    expect(V58_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_tag_links_tag ON tag_links (tag_id, entity_type)');
    expect(V58_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_tags_user ON tags (user_id, name)');
  });

  it('is re-runnable: every statement is IF NOT EXISTS and additive-only', () => {
    expect(V58_SQL).not.toMatch(/CREATE TABLE\s+(?!IF NOT EXISTS)/i);
    expect(V58_SQL).not.toMatch(/CREATE INDEX\s+(?!IF NOT EXISTS)/i);
    expect(V58_SQL).not.toMatch(/\bDROP\b/i);
    expect(V58_SQL).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(V58_SQL).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(V58_SQL).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(V58_SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(V58_SQL.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2);
    expect(V58_SQL.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(3);
  });

  it('does not touch the legacy events.tags column or any other entity table', () => {
    expect(V58_SQL).not.toContain('ALTER TABLE events');
    expect(V58_SQL).not.toContain('events.tags');
    expect(V58_SQL).not.toMatch(/\bevents\b/);
    expect(V58_SQL).not.toMatch(/\bfixed_contacts\b/);
    expect(V58_SQL).not.toMatch(/\bdocuments\b/);
    expect(V58_SQL).not.toMatch(/\bgoals\b/);
  });
});
