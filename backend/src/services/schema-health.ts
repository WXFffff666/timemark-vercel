/**
 * Schema health: is the database's migration state actually where the code expects it?
 *
 * This used to be three independent stale constants — `EXPECTED_SCHEMA_VERSION = 31` in
 * routes/security.ts, `EXPECTED_MIGRATION_MAX = 58` plus a hardcoded version array in
 * migration-selfcheck.service.ts — each compared with `>=`, so a database on any version
 * at or above the smallest constant rendered a green "up to date".
 *
 * The expected list now comes from one generated module (scripts/gen-migration-versions.mjs),
 * and the answer is one of four states rather than a boolean.
 */
import { MIGRATION_VERSIONS, MAX_MIGRATION_VERSION } from '../db/migration-versions.js';

export type SchemaHealthStatus =
  /** Every registered version is recorded. */
  | 'up_to_date'
  /** Missing versions are all above the recorded max: the runner will apply them next cold start. */
  | 'behind'
  /** A recorded version is newer than this build — e.g. after a deploy rollback. */
  | 'ahead'
  /** A version is missing *below* the recorded max: a migration errored and the walk continued. */
  | 'failed_gap';

export interface SchemaHealth {
  status: SchemaHealthStatus;
  /** Highest recorded version, or null when schema_version is empty/unreadable. */
  current: number | null;
  expected: number;
  /** Registered versions with no schema_version row, ascending. */
  missingVersions: number[];
  /** Recorded versions this build does not know about, ascending. */
  futureVersions: number[];
}

/**
 * Classify the recorded versions.
 *
 * The `failed_gap` case is the one the old `>=` comparison could never express: the runner
 * gates on `currentVersion < migration.version` with `currentVersion` frozen before the loop
 * and its `catch` only logs, so a migration that errored leaves a hole underneath a
 * perfectly healthy-looking `MAX(version)`. A missing version *below* the max is that hole.
 */
export function computeSchemaHealth(recordedVersions: readonly number[]): SchemaHealth {
  const present = [...new Set(recordedVersions.filter((v) => Number.isFinite(v)))].sort((a, b) => a - b);
  const presentSet = new Set(present);
  const current = present.length > 0 ? present[present.length - 1] : null;

  const missingVersions = MIGRATION_VERSIONS.filter((version) => !presentSet.has(version));
  const futureVersions = present.filter((version) => !MIGRATION_VERSIONS.includes(version));

  let status: SchemaHealthStatus;
  if (current !== null && current > MAX_MIGRATION_VERSION) {
    status = 'ahead';
  } else if (missingVersions.length === 0) {
    status = 'up_to_date';
  } else if (current === null || missingVersions.every((version) => version > current)) {
    // Everything missing sits above the max, so the next cold start applies them in order.
    status = 'behind';
  } else {
    status = 'failed_gap';
  }

  return { status, current, expected: MAX_MIGRATION_VERSION, missingVersions, futureVersions };
}

/** One-line operator-facing summary. Never says "up to date" unless it is. */
export function describeSchemaHealth(health: SchemaHealth): string {
  const missing = health.missingVersions.length ? `，缺 ${health.missingVersions.join(', ')}` : '';
  switch (health.status) {
    case 'up_to_date':
      return `数据库结构 v${health.expected}（已是最新）`;
    case 'behind':
      return `数据库结构 v${health.current ?? 0}，期望 v${health.expected}${missing}。重新部署或访问站点触发迁移`;
    case 'ahead':
      return `数据库结构 v${health.current}，比当前代码期望的 v${health.expected} 还新${missing}。通常是回滚了部署`;
    case 'failed_gap':
      return `数据库结构 v${health.current}，中间有迁移未成功${missing}。查看部署日志中该版本的报错`;
  }
}

/** Whether the state should render as a healthy check. */
export function isSchemaHealthy(health: SchemaHealth): boolean {
  return health.status === 'up_to_date';
}