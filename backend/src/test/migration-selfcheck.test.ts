import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';

import {
  MIGRATION_VERSIONS,
  MAX_MIGRATION_VERSION,
  UNALLOCATED_MIGRATION_VERSIONS,
} from '../db/migration-versions.js';
import { computeSchemaHealth, describeSchemaHealth, isSchemaHealthy } from '../services/schema-health.js';
import { registeredMigrationVersions } from './helpers.js';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: mockQuery, waitForDb: vi.fn() }));
vi.mock('../middleware/auth.middleware.js', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', { id: '1', username: 'admin' });
    return next();
  },
}));

import securityRoutes from '../routes/security.js';

/** Answer `SELECT version FROM schema_version` with the given recorded versions. */
function schemaVersionRows(versions: number[]) {
  return versions.map((version) => ({ version }));
}

async function deployInfoBody(recorded: number[]): Promise<Record<string, unknown>> {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM schema_version')) {
      return { rows: schemaVersionRows(recorded), rowCount: recorded.length };
    }
    if (sql.includes('password_changed_at')) return { rows: [{ password_changed_at: null }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const app = new Hono();
  app.route('/api/security', securityRoutes);
  const res = await app.request('/api/security/deploy-info');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  return body.data;
}

beforeEach(() => {
  mockQuery.mockReset();
});

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');

/** Every recorded version except the last `count` — the shape of a database that stopped short. */
function recordedUpTo(version: number): number[] {
  return MIGRATION_VERSIONS.filter((v) => v <= version);
}

describe('schema health', () => {
  it('keeps the generated version file in sync with migrate.ts', () => {
    // The whole point of the generated module: migrate.ts stays the source of truth and a
    // stale generated file fails here rather than silently reporting a wrong expected version.
    expect([...registeredMigrationVersions(MIGRATE_SOURCE)]).toEqual([...MIGRATION_VERSIONS]);
    expect(Math.max(...MIGRATION_VERSIONS)).toBe(MAX_MIGRATION_VERSION);
  });

  it('records the versions this project never allocated', () => {
    // v1 is the base schema (shared/src/schema.pg.sql); 15/66/68 were skipped.
    expect([...UNALLOCATED_MIGRATION_VERSIONS]).toEqual([15, 66, 68]);
  });

  it('reports up_to_date when every registered version is present', () => {
    const health = computeSchemaHealth([...MIGRATION_VERSIONS]);
    expect(health.status).toBe('up_to_date');
    expect(isSchemaHealthy(health)).toBe(true);
    expect(health.missingVersions).toEqual([]);
  });

  it('reports behind and names the exact missing versions when the max is short', () => {
    const health = computeSchemaHealth(recordedUpTo(70));
    expect(health.status).toBe('behind');
    expect(health.missingVersions).toEqual([71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81]);
    expect(isSchemaHealthy(health)).toBe(false);
    expect(describeSchemaHealth(health)).toContain('缺 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81');
  });

  it('reports ahead when the database has a version newer than the code', () => {
    // Deploy rollback: the code is older than the schema.
    const health = computeSchemaHealth([...MIGRATION_VERSIONS, MAX_MIGRATION_VERSION + 1]);
    expect(health.status).toBe('ahead');
    expect(health.futureVersions).toEqual([MAX_MIGRATION_VERSION + 1]);
    expect(isSchemaHealthy(health)).toBe(false);
  });

  it('reports failed_gap, not behind, when a version below the max is missing', () => {
    // The state the old `>=` comparison could never express: v71 errored, the runner logged
    // and walked on, so MAX(version) is 75 and the hole underneath it was invisible.
    const recorded = MIGRATION_VERSIONS.filter((v) => v !== 71);
    const health = computeSchemaHealth(recorded);

    expect(health.current).toBe(MAX_MIGRATION_VERSION);
    expect(health.missingVersions).toEqual([71]);
    expect(health.status).toBe('failed_gap');
    expect(isSchemaHealthy(health)).toBe(false);
  });

  it('treats an empty schema_version as behind rather than healthy', () => {
    const health = computeSchemaHealth([]);
    expect(health.status).toBe('behind');
    expect(health.current).toBeNull();
    expect(health.missingVersions).toHaveLength(MIGRATION_VERSIONS.length);
  });

  it('never says "up to date" in the hint for any unhealthy state', () => {
    for (const recorded of [[], recordedUpTo(58), recordedUpTo(74), [...MIGRATION_VERSIONS]]) {
      const health = computeSchemaHealth(recorded);
      if (isSchemaHealthy(health)) {
        expect(describeSchemaHealth(health)).toContain('已是最新');
      } else {
        expect(describeSchemaHealth(health)).not.toContain('已是最新');
      }
    }
  });
});
describe('GET /api/security/deploy-info (real surface)', () => {
  it('reports up_to_date and a green envCheck when the chain is complete', async () => {
    const data = await deployInfoBody([...MIGRATION_VERSIONS]);
    expect(data.schemaStatus).toBe('up_to_date');
    expect(data.schemaUpToDate).toBe(true);
    expect(data.expectedSchemaVersion).toBe(MAX_MIGRATION_VERSION);
    expect(data.schemaMissingVersions).toEqual([]);
    const schemaCheck = (data.envChecks as Array<{ id: string; ok: boolean }>).find((c) => c.id === 'schema');
    expect(schemaCheck?.ok).toBe(true);
  });

  it('reports behind with the exact missing list when the database is short', async () => {
    const data = await deployInfoBody(recordedUpTo(70));
    expect(data.schemaStatus).toBe('behind');
    expect(data.schemaUpToDate).toBe(false);
    expect(data.schemaMissingVersions).toEqual([71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81]);
    expect(data.schemaHint).toContain('缺 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81');
    const schemaCheck = (data.envChecks as Array<{ id: string; ok: boolean }>).find((c) => c.id === 'schema');
    expect(schemaCheck?.ok).toBe(false);
  });

  it('reports ahead when the database is newer than the build', async () => {
    const data = await deployInfoBody([...MIGRATION_VERSIONS, 82]);
    expect(data.schemaStatus).toBe('ahead');
    expect(data.schemaFutureVersions).toEqual([82]);
  });

  it('reports failed_gap as an error envCheck, not a green one', async () => {
    // v71 errored and the runner logged-and-continued, so MAX(version) is a healthy-looking 75.
    const data = await deployInfoBody(MIGRATION_VERSIONS.filter((v) => v !== 71));
    expect(data.schemaVersion).toBe(MAX_MIGRATION_VERSION);
    expect(data.schemaStatus).toBe('failed_gap');
    expect(data.schemaMissingVersions).toEqual([71]);
    const schemaCheck = (data.envChecks as Array<{ id: string; ok: boolean; severity?: string }>).find(
      (c) => c.id === 'schema',
    );
    expect(schemaCheck?.ok).toBe(false);
    expect(schemaCheck?.severity).toBe('error');
  });
});
