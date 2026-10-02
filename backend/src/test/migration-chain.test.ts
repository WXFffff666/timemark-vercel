import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { registeredMigrationVersions } from './helpers.js';

/**
 * The ONE authoritative pin on the shape of the migration chain in
 * `backend/src/db/migrate.ts`.
 *
 * Before this file existed, 24 sibling `migration-vNN.test.ts` files each carried their
 * own copy of the same whole-chain assertions (strictly ascending, `versions[last] === 75`,
 * absolute `versionInserts()` tail arrays) over their own naive parse of the source.
 * Appending a migration therefore meant editing ~20 files - which is exactly why
 * migrations got appended without the tail pins being updated, and why that staleness
 * turned into a red suite once the folded pending SQL landed.
 *
 * The per-migration files keep what is per-migration (this migration's SQL, its markers,
 * its runner behaviour, its `_vNN` name). The whole-chain invariants live here, once.
 *
 * Adding a migration = append one entry to the `migrations` array in migrate.ts and run
 * `node scripts/gen-migration-versions.mjs`. Nothing else in the suite needs to move: the
 * expected version used by the health check is read from that generated manifest, not from a
 * second hand-maintained number, and the drift guard below fails if the manifest and migrate.ts
 * disagree.
 */

/**
 * The highest registered migration version. Imported, not restated: it used to be a literal
 * `75` here and a different literal in routes/security.ts (31) and a third in
 * migration-selfcheck.service.ts (58) — three "expected schema version" constants that all
 * disagreed while every one of them reported a green check.
 */
const { MAX_MIGRATION_VERSION } = await import('../db/migration-versions.js');

/**
 * The numbers that were never allocated: 1 predates the chain (v2 is the first entry) and
 * 15 / 66 / 68 were claimed by plans that never landed. Do not allocate them - leaving
 * them open is what keeps `indexOf(n + 1) === indexOf(n) + 1` true for every registered
 * consecutive pair.
 */
const UNALLOCATED_VERSIONS = [1, 15, 66, 68];

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const VERSIONS = registeredMigrationVersions(MIGRATE_SOURCE);

describe('migration chain (single source of truth)', () => {
  it('registers every version from 2 to MAX_MIGRATION_VERSION except the unallocated ones', () => {
    // 75 - the 4 never-allocated numbers = the 71 real registrations.
    expect(VERSIONS).toHaveLength(MAX_MIGRATION_VERSION - UNALLOCATED_VERSIONS.length);
    expect(VERSIONS[0]).toBe(2);
  });

  it('is strictly ascending - no reuse, no renumber, no gap left for another lane to collide with', () => {
    for (let i = 1; i < VERSIONS.length; i += 1) {
      expect(VERSIONS[i], `version ${VERSIONS[i]} is not greater than ${VERSIONS[i - 1]}`).toBeGreaterThan(VERSIONS[i - 1]);
    }
  });

  it('registers every version exactly once', () => {
    expect(new Set(VERSIONS).size, `duplicate version in ${VERSIONS.join(',')}`).toBe(VERSIONS.length);
  });

  it('places n+1 immediately after n wherever both are registered', () => {
    for (const version of VERSIONS) {
      if (!VERSIONS.includes(version + 1)) continue;
      expect(VERSIONS.indexOf(version + 1), `version ${version + 1} is not directly after ${version}`).toBe(
        VERSIONS.indexOf(version) + 1,
      );
    }
  });

  it('leaves only the never-allocated numbers unused', () => {
    const unused: number[] = [];
    for (let n = 1; n <= MAX_MIGRATION_VERSION; n += 1) {
      if (!VERSIONS.includes(n)) unused.push(n);
    }
    expect(unused).toEqual(UNALLOCATED_VERSIONS);
  });

  it('ends at MAX_MIGRATION_VERSION', () => {
    expect(Math.max(...VERSIONS)).toBe(MAX_MIGRATION_VERSION);
    expect(VERSIONS[VERSIONS.length - 1]).toBe(MAX_MIGRATION_VERSION);
  });

  it('pins the parser root cause: the old naive whole-file regex over-counts', () => {
    // Commit b7c9122 folded backend/src/db/pending/*.sql verbatim into the migrations
    // array, and those files carry `Register as: { version: N, ... }` doc comments. The
    // old `/version:\s*(\d+)\s*,/g` therefore matched 76 times instead of 71 and
    // invented phantom duplicates of 61, 67, 69, 70 and 74 plus phantom order
    // violations. If this ever regresses to 71 for both, the parser is naive again.
    const naive = [...MIGRATE_SOURCE.matchAll(/version:\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(VERSIONS).toHaveLength(71);
    expect(naive.length).toBeGreaterThan(VERSIONS.length);
  });
});