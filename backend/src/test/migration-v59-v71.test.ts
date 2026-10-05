import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Integrator tail pin: the pending migrations 59, 60, 61, 62, 63, 64, 65, 67, 69, 70, 71, 72, 73, 74 and 75
 * were folded verbatim from `backend/src/db/pending/*.sql` into the tail of
 * `applyIncrementalMigrations` (one entry per file, ascending numeric order, name ending `_v<N>`).
 *
 * The real max before the fold was 58 (`tags_tag_links_v58`). The runner applies a migration only
 * when `currentVersion < version` while walking the array in order, so the folded block must stay
 * strictly ascending and immediately after 58 - a lower number appended later would never run.
 * Every folded file is additive + idempotent (all statements `IF NOT EXISTS`-guarded), so
 * re-running any of them (or applying on top of a recorded max) is a no-op, and a failing one must
 * not be recorded so the next cold start retries. The migrations' `.sql` files stay on disk under
 * `backend/src/db/pending/` as the record; this pin guards the registration itself.
 *
 * Sibling per-migration pins (`migration-vNN.test.ts`) keep the tail assertion
 * (`versions[versions.length - 1]`) at the current max - bumped 58 -> 75 in the same fold.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';
import { registeredMigrationVersions } from './helpers.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');

/** The folded block: version, registered name and a distinctive DDL marker per file. */
const FOLDED: ReadonlyArray<{ version: number; name: string; marker: string }> = [
  { version: 59, name: 'scheduler_egress_v59', marker: 'scheduler_runs' },
  { version: 60, name: 'notification_budget_v60', marker: 'agent_budget_usage' },
  { version: 61, name: 'routine_artifacts_v61', marker: 'agent_routine_artifacts' },
  { version: 62, name: 'triage_state_v62', marker: 'agent_triage_state' },
  { version: 63, name: 'agent_feedback_v63', marker: 'agent_decision_cards' },
  { version: 64, name: 'dedupe_audit_v64', marker: 'audit_undo_snapshots' },
  { version: 65, name: 'data_health_v65', marker: 'data_health_repairs' },
  { version: 67, name: 'routine_templates_v67', marker: 'routine_template_steps' },
  { version: 69, name: 'feeds_export_v69', marker: 'feed_ingest_proposals' },
  { version: 70, name: 'ocr_share_remote_backup_v70', marker: 'share_tokens' },
  { version: 71, name: 'weather_parcels_v71', marker: 'user_weather_settings' },
  { version: 72, name: 'timesheet_care_pets_v72', marker: 'timesheet_sessions' },
  { version: 73, name: 'vehicle_watchlist_household_v73', marker: 'household_lists' },
  { version: 74, name: 'calendar_sync_collaboration_v74', marker: 'calendar_sync_accounts' },
  { version: 75, name: 'birthday_link_v75', marker: 'greeting_opt_out' },
];

const FOLDED_VERSIONS = FOLDED.map((entry) => entry.version);

function sourceVersions(): number[] {
  return registeredMigrationVersions(MIGRATE_SOURCE);
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

describe('folded pending migrations 59-75 (integrator tail pin)', () => {
  it('registers every folded file exactly once, ascending, with a `_v<N>` name and non-empty SQL', () => {
    const versions = sourceVersions();
    for (const { version, name } of FOLDED) {
      expect(versions.filter((v) => v === version), `version ${version} is not registered exactly once`).toHaveLength(1);
      expect(MIGRATE_SOURCE).toContain(`name: '${name}'`);
      // Every folded entry carries embedded SQL (the pending file, verbatim).
      const nameIndex = MIGRATE_SOURCE.indexOf(`name: '${name}'`);
      const sqlStart = MIGRATE_SOURCE.indexOf('sql: `', nameIndex);
      const sqlEnd = MIGRATE_SOURCE.indexOf('`,\r\n    },', sqlStart);
      expect(sqlStart, `${name} has no sql`).toBeGreaterThan(nameIndex);
      expect(MIGRATE_SOURCE.slice(sqlStart, sqlEnd).length, `${name} sql is empty`).toBeGreaterThan(100);
    }
    // The whole chain stays strictly ascending (the runner walks it in order).
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `version ${versions[i]} is not greater than ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]);
    }
    // 58 keeps its position; v76 (recovery codes), v77 (email fold), v78 (reachability) and v79 (greetings) and v80 (retention) follow.
    expect(versions.indexOf(59)).toBe(versions.indexOf(58) + 1);
    expect(versions[versions.length - 1]).toBe(80);
    expect(versions.filter((v) => v === 75)).toHaveLength(1);
    // Nothing before the fold moved.
    expect(MIGRATE_SOURCE).toContain("name: 'tags_tag_links_v58'");
    expect(MIGRATE_SOURCE).toContain("name: 'search_trgm_remaining_v57'");
  });

  it('applies every folded version on top of a recorded 58 exactly once, in order', async () => {
    await applyIncrementalMigrations(58);
    // v76-v80 sit after the folded block and apply too.
    expect(versionInserts()).toEqual([...FOLDED_VERSIONS, 76, 77, 78, 79, 80]);
    for (const { marker } of FOLDED) {
      expect(callsMatching(marker).length, `${marker} was not applied`).toBeGreaterThan(0);
    }
    // v58 itself (and everything before it) must not re-run on top of a recorded 58.
    expect(callsMatching('CREATE TABLE IF NOT EXISTS tags')).toHaveLength(0);
    expect(callsMatching('idx_tag_links_tag')).toHaveLength(0);
  });

  it('is idempotent: a recorded 80 row makes the runner skip the whole folded block', async () => {
    await applyIncrementalMigrations(80);
    expect(versionInserts()).toEqual([]);
    for (const { marker } of FOLDED) {
      expect(callsMatching(marker)).toHaveLength(0);
    }
  });

  it('does not record a folded version whose SQL fails, and still walks on to 80', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('scheduler_runs')) throw new Error('permission denied for table scheduler_runs');
      return { rows: [], rowCount: 0 };
    });
    await applyIncrementalMigrations(58);
    expect(versionInserts()).not.toContain(59);
    expect(versionInserts()).toContain(78);
    expect(versionInserts()).toEqual([...FOLDED_VERSIONS.filter((v) => v !== 59), 76, 77, 78, 79, 80]);
  });
});
