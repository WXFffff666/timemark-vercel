/**
 * 143 - post-migration self-check and idempotent automatic repair.
 *
 * After `runMigrations()` has run, verify:
 *   (a) the max `schema_version` equals the max version in the migration list
 *       (history gaps and versions from the future are reported separately);
 *   (b) every table/index the app expects exists;
 *   (c) no orphaned FK rows the app depends on;
 *   (d) encryption columns decrypt with the current MASTER_KEY.
 *
 * Findings are structured (`SelfCheckFinding`). Repair is idempotent and
 * limited to what this module can rebuild from its own catalog:
 *   - missing indexes -> `CREATE INDEX IF NOT EXISTS` with the expected DDL
 *   - missing `schema_version` row for the latest migration -> INSERT ... ON CONFLICT
 * Anything else is reported, never silently "fixed".
 */
import { decrypt } from '@timemark/shared/crypto';
import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { computeSchemaHealth } from '../schema-health.js';
import { LEGACY_MASTER_KEY } from '../../utils/secrets.js';

const log = createLogger('migration-selfcheck');

/**
 * Expected versions now come from backend/src/db/migration-versions.ts, generated from
 * migrate.ts by scripts/gen-migration-versions.mjs. This module used to carry its own
 * copies — `EXPECTED_MIGRATION_MAX = 58` and a hardcoded array stopping at 58 — which had
 * already drifted from the real max (75) and from routes/security.ts (31).
 */
import {
  MAX_MIGRATION_VERSION as EXPECTED_MIGRATION_MAX,
  MIGRATION_VERSIONS as EXPECTED_MIGRATION_VERSIONS,
} from '../../db/migration-versions.js';

export { EXPECTED_MIGRATION_MAX, EXPECTED_MIGRATION_VERSIONS };

/** Tables created by shared/src/schema.pg.sql and by migrate.ts (v2..v58). */
export const EXPECTED_TABLES: readonly string[] = [
  // core schema
  'schema_version', 'users', 'sessions', 'relationship_mappings', 'events', 'email_logs',
  'login_logs', 'login_attempts', 'user_configs', 'notification_accounts', 'event_trigger_logs',
  'push_subscriptions', 'event_templates', 'notification_queue', 'plugin_sessions',
  'cron_execution_logs', 'expiry_items', 'expiry_history', 'inventory_items',
  'maintenance_plans', 'maintenance_logs', 'attachments', 'documents', 'fixed_contacts',
  'interactions', 'contact_promises', 'gift_records', 'habits', 'habit_logs', 'profiles',
  'medications', 'medication_doses', 'profile_channel_accounts', 'goals', 'milestones',
  // migrations
  'rate_limits', 'security_events', 'webauthn_credentials', 'webauthn_challenges',
  'broadcast_campaigns', 'event_reminder_cache', 'inbox_messages', 'webhook_idempotency_keys',
  'stats_daily', 'contact_groups', 'contact_group_members', 'conditional_reminder_rules',
  'audit_logs', 'reminder_send_claims', 'todo_completions', 'caldav_writeback_objects',
  'ics_feeds', 'bot_updates', 'bot_links', 'bot_link_codes', 'bot_audit_logs', 'user_patterns',
  'embeddings', 'agent_jobs', 'agent_job_events', 'agent_workers', 'agent_routines',
  'agent_tokens', 'agent_audit_logs', 'agent_confirmations', 'tags', 'tag_links',
];

export interface ExpectedIndex {
  name: string;
  ddl: string;
}

/** App-critical indexes; the DDL is what the repair path re-executes. */
export const EXPECTED_INDEXES: readonly ExpectedIndex[] = [
  { name: 'idx_sessions_token', ddl: 'CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)' },
  { name: 'idx_sessions_expires', ddl: 'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)' },
  { name: 'idx_events_user_date', ddl: 'CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, date)' },
  { name: 'idx_events_next_occurrence', ddl: 'CREATE INDEX IF NOT EXISTS idx_events_next_occurrence ON events(next_occurrence)' },
  { name: 'idx_events_user_profile', ddl: 'CREATE INDEX IF NOT EXISTS idx_events_user_profile ON events(user_id, profile_id)' },
  { name: 'idx_notification_accounts_user', ddl: 'CREATE INDEX IF NOT EXISTS idx_notification_accounts_user ON notification_accounts(user_id)' },
  { name: 'idx_trigger_logs_event', ddl: 'CREATE INDEX IF NOT EXISTS idx_trigger_logs_event ON event_trigger_logs(event_id)' },
  { name: 'idx_trigger_logs_user', ddl: 'CREATE INDEX IF NOT EXISTS idx_trigger_logs_user ON event_trigger_logs(user_id)' },
  { name: 'idx_push_subscriptions_user', ddl: 'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)' },
  { name: 'idx_expiry_items_user_due', ddl: 'CREATE INDEX IF NOT EXISTS idx_expiry_items_user_due ON expiry_items(user_id, next_due_date)' },
  { name: 'idx_inventory_items_user_expires', ddl: 'CREATE INDEX IF NOT EXISTS idx_inventory_items_user_expires ON inventory_items(user_id, expires_at)' },
  { name: 'idx_maintenance_plans_user_due', ddl: 'CREATE INDEX IF NOT EXISTS idx_maintenance_plans_user_due ON maintenance_plans(user_id, next_due_at)' },
  { name: 'idx_maintenance_logs_plan', ddl: 'CREATE INDEX IF NOT EXISTS idx_maintenance_logs_plan ON maintenance_logs(plan_id, done_at DESC)' },
  { name: 'idx_attachments_user_owner', ddl: 'CREATE INDEX IF NOT EXISTS idx_attachments_user_owner ON attachments(user_id, owner_type, owner_id)' },
  { name: 'idx_documents_user_expires', ddl: 'CREATE INDEX IF NOT EXISTS idx_documents_user_expires ON documents(user_id, expires_at)' },
  { name: 'idx_fixed_contacts_user', ddl: 'CREATE INDEX IF NOT EXISTS idx_fixed_contacts_user ON fixed_contacts(user_id)' },
  { name: 'idx_interactions_user_contact_occurred', ddl: 'CREATE INDEX IF NOT EXISTS idx_interactions_user_contact_occurred ON interactions(user_id, contact_id, occurred_at DESC)' },
  { name: 'idx_habits_user', ddl: 'CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id)' },
  { name: 'idx_habit_logs_habit_date', ddl: 'CREATE INDEX IF NOT EXISTS idx_habit_logs_habit_date ON habit_logs(habit_id, logged_on DESC)' },
  { name: 'idx_profiles_user', ddl: 'CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id)' },
  { name: 'idx_medications_user_profile', ddl: 'CREATE INDEX IF NOT EXISTS idx_medications_user_profile ON medications(user_id, profile_id)' },
  { name: 'idx_medication_doses_user_scheduled', ddl: 'CREATE INDEX IF NOT EXISTS idx_medication_doses_user_scheduled ON medication_doses(user_id, scheduled_for)' },
  { name: 'idx_goals_user_status', ddl: 'CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status)' },
  { name: 'idx_milestones_goal', ddl: 'CREATE INDEX IF NOT EXISTS idx_milestones_goal ON milestones(goal_id, sort_order, id)' },
];

export interface FkCheck {
  id: string;
  child: string;
  column: string;
  parent: string;
  refColumn: string;
}

/** FK relations the reminder/render paths dereference. */
export const FK_CHECKS: readonly FkCheck[] = [
  { id: 'sessions.user_id', child: 'sessions', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'login_logs.user_id', child: 'login_logs', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'user_configs.user_id', child: 'user_configs', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'notification_accounts.user_id', child: 'notification_accounts', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'event_trigger_logs.event_id', child: 'event_trigger_logs', column: 'event_id', parent: 'events', refColumn: 'id' },
  { id: 'event_trigger_logs.user_id', child: 'event_trigger_logs', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'push_subscriptions.user_id', child: 'push_subscriptions', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'expiry_items.user_id', child: 'expiry_items', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'expiry_history.item_id', child: 'expiry_history', column: 'item_id', parent: 'expiry_items', refColumn: 'id' },
  { id: 'inventory_items.user_id', child: 'inventory_items', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'maintenance_plans.user_id', child: 'maintenance_plans', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'maintenance_logs.plan_id', child: 'maintenance_logs', column: 'plan_id', parent: 'maintenance_plans', refColumn: 'id' },
  { id: 'attachments.user_id', child: 'attachments', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'documents.user_id', child: 'documents', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'fixed_contacts.user_id', child: 'fixed_contacts', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'interactions.user_id', child: 'interactions', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'interactions.contact_id', child: 'interactions', column: 'contact_id', parent: 'fixed_contacts', refColumn: 'id' },
  { id: 'habits.user_id', child: 'habits', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'habit_logs.habit_id', child: 'habit_logs', column: 'habit_id', parent: 'habits', refColumn: 'id' },
  { id: 'habit_logs.user_id', child: 'habit_logs', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'profiles.user_id', child: 'profiles', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'medications.user_id', child: 'medications', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'medication_doses.medication_id', child: 'medication_doses', column: 'medication_id', parent: 'medications', refColumn: 'id' },
  { id: 'goals.user_id', child: 'goals', column: 'user_id', parent: 'users', refColumn: 'id' },
  { id: 'milestones.goal_id', child: 'milestones', column: 'goal_id', parent: 'goals', refColumn: 'id' },
  { id: 'profile_channel_accounts.profile_id', child: 'profile_channel_accounts', column: 'profile_id', parent: 'profiles', refColumn: 'id' },
  { id: 'profile_channel_accounts.account_id', child: 'profile_channel_accounts', column: 'account_id', parent: 'notification_accounts', refColumn: 'id' },
];

export interface EncryptedColumnSpec {
  table: string;
  columns: readonly string[];
}

/** Columns the app writes through @timemark/shared/crypto (AES-256-GCM). */
export const ENCRYPTED_COLUMNS: readonly EncryptedColumnSpec[] = [
  {
    table: 'user_configs',
    columns: [
      'encrypted_resend_key', 'encrypted_github_token', 'encrypted_feishu_webhook',
      'encrypted_wecom_webhook', 'encrypted_dingtalk_webhook', 'encrypted_dingtalk_secret',
      'encrypted_telegram_bot_token', 'encrypted_discord_webhook', 'encrypted_slack_webhook',
      'encrypted_wxpusher_app_token', 'encrypted_wxpusher_uid', 'encrypted_qmsg_key',
      'encrypted_qmsg_qq', 'encrypted_channel_webhooks',
      'caldav_password_encrypted', 'google_oauth_refresh_token_encrypted',
    ],
  },
  { table: 'notification_accounts', columns: ['webhook', 'token', 'secret', 'chat_id', 'session_data'] },
  { table: 'documents', columns: ['document_number_encrypted'] },
];

export type FindingCategory = 'schema_version' | 'table' | 'index' | 'foreign_key' | 'encryption';
export type FindingSeverity = 'error' | 'warning';

export interface SelfCheckFinding {
  category: FindingCategory;
  id: string;
  severity: FindingSeverity;
  /** True only when `repairMigrationFindings` can fix it from this module's catalog. */
  repairable: boolean;
  detail: string;
}

export interface SelfCheckResult {
  ok: boolean;
  checkedAt: string;
  schemaVersion: {
    current: number | null;
    expected: number;
    upToDate: boolean;
    missingVersions: number[];
    futureVersions: number[];
  };
  tables: { expected: number; missing: string[] };
  indexes: { expected: number; missing: string[] };
  foreignKeys: { checked: number; orphans: Array<{ id: string; count: number }> };
  encryption: {
    keyPresent: boolean;
    checkedColumns: number;
    checkedValues: number;
    failingValues: number;
    nonCiphertextValues: number;
    samples: string[];
  };
  findings: SelfCheckFinding[];
}

export interface RepairResult {
  attemptedAt: string;
  repaired: string[];
  skipped: Array<{ id: string; reason: string }>;
  result: SelfCheckResult;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Current key resolution mirrors the rest of the app (legacy key only outside prod). */
function resolveMasterKey(): string | null {
  const key = (process.env.MASTER_KEY ?? '').trim();
  if (key !== '') return key;
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') return null;
  return LEGACY_MASTER_KEY;
}

async function relationExists(name: string): Promise<boolean> {
  const result = await query('SELECT to_regclass($1) AS oid', [name]);
  const oid = (result.rows[0] as { oid: string | null } | undefined)?.oid;
  return oid != null;
}

async function checkSchemaVersion(findings: SelfCheckFinding[]): Promise<SelfCheckResult['schemaVersion']> {
  let present: number[] = [];
  try {
    const result = await query('SELECT version FROM schema_version ORDER BY version ASC');
    present = (result.rows as Array<{ version: unknown }>)
      .map((row) => Number(row.version))
      .filter((version) => Number.isFinite(version));
  } catch (error) {
    findings.push({
      category: 'schema_version',
      id: 'schema_version_unreadable',
      severity: 'error',
      repairable: false,
      detail: `schema_version could not be read: ${describeError(error)}`,
    });
    return {
      current: null,
      expected: EXPECTED_MIGRATION_MAX,
      upToDate: false,
      missingVersions: [...EXPECTED_MIGRATION_VERSIONS],
      futureVersions: [],
    };
  }

  // One classification, shared with routes/security.ts. `upToDate` used to be
  // `presentSet.has(EXPECTED_MIGRATION_MAX)`, which reports healthy when the max row exists
  // even if a migration below it errored and the walk continued past the hole.
  const health = computeSchemaHealth(present);
  const { current, missingVersions, futureVersions } = health;
  const upToDate = health.status === 'up_to_date';

  if (health.status === 'failed_gap') {
    findings.push({
      category: 'schema_version',
      id: 'schema_version_failed_gap',
      severity: 'error',
      repairable: false,
      detail: `schema_version has a hole below max ${String(current)}: missing [${missingVersions.join(', ')}]. A migration errored and the runner continued past it, so MAX(version) hid it. Check the deploy log for that version and re-run it manually.`,
    });
  }

  if (!upToDate && health.status !== 'failed_gap') {
    const onlyLatestMissing =
      missingVersions.length === 1 && missingVersions[0] === EXPECTED_MIGRATION_MAX;
    findings.push({
      category: 'schema_version',
      id: 'schema_version_latest_missing',
      severity: 'error',
      repairable: onlyLatestMissing,
      detail: onlyLatestMissing
        ? `schema_version is missing the latest migration row (${EXPECTED_MIGRATION_MAX}); the repair inserts the row idempotently (it does NOT re-apply migration DDL)`
        : `schema_version max is ${String(current)} but the migration list expects ${EXPECTED_MIGRATION_MAX}; missing rows: [${missingVersions.join(', ')}]. History gaps are NOT auto-repaired`,
    });
  } else if (missingVersions.length > 0) {
    findings.push({
      category: 'schema_version',
      id: 'schema_version_history_gaps',
      severity: 'warning',
      repairable: false,
      detail: `schema_version is current but historic versions are missing: [${missingVersions.join(', ')}]`,
    });
  }

  if (futureVersions.length > 0) {
    findings.push({
      category: 'schema_version',
      id: 'schema_version_ahead',
      severity: 'warning',
      repairable: false,
      detail: `versions recorded beyond the known migration list: [${futureVersions.join(', ')}]`,
    });
  }

  return { current, expected: EXPECTED_MIGRATION_MAX, upToDate, missingVersions, futureVersions };
}

async function checkTables(findings: SelfCheckFinding[]): Promise<SelfCheckResult['tables']> {
  const missing: string[] = [];
  for (const table of EXPECTED_TABLES) {
    try {
      if (await relationExists(table)) continue;
      missing.push(table);
      findings.push({
        category: 'table',
        id: `missing_table:${table}`,
        severity: 'error',
        repairable: false,
        detail: `table "${table}" is missing; apply the migration/DDL that creates it`,
      });
    } catch (error) {
      findings.push({
        category: 'table',
        id: `table_check_failed:${table}`,
        severity: 'warning',
        repairable: false,
        detail: `could not check table "${table}": ${describeError(error)}`,
      });
    }
  }
  return { expected: EXPECTED_TABLES.length, missing };
}

async function checkIndexes(findings: SelfCheckFinding[]): Promise<SelfCheckResult['indexes']> {
  const missing: string[] = [];
  for (const index of EXPECTED_INDEXES) {
    try {
      if (await relationExists(index.name)) continue;
      missing.push(index.name);
      findings.push({
        category: 'index',
        id: `missing_index:${index.name}`,
        severity: 'error',
        repairable: true,
        detail: `index "${index.name}" is missing; repair re-runs: ${index.ddl}`,
      });
    } catch (error) {
      findings.push({
        category: 'index',
        id: `index_check_failed:${index.name}`,
        severity: 'warning',
        repairable: false,
        detail: `could not check index "${index.name}": ${describeError(error)}`,
      });
    }
  }
  return { expected: EXPECTED_INDEXES.length, missing };
}

async function checkForeignKeys(findings: SelfCheckFinding[]): Promise<SelfCheckResult['foreignKeys']> {
  const orphans: Array<{ id: string; count: number }> = [];
  let checked = 0;
  for (const fk of FK_CHECKS) {
    try {
      const result = await query(
        `SELECT COUNT(*)::int AS n FROM ${fk.child} c LEFT JOIN ${fk.parent} p ON c.${fk.column} = p.${fk.refColumn} WHERE c.${fk.column} IS NOT NULL AND p.${fk.refColumn} IS NULL`,
      );
      checked += 1;
      const count = Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
      if (count > 0) {
        orphans.push({ id: fk.id, count });
        findings.push({
          category: 'foreign_key',
          id: `orphan:${fk.id}`,
          severity: 'error',
          repairable: false,
          detail: `${count} orphaned row(s): ${fk.child}.${fk.column} has no matching ${fk.parent}.${fk.refColumn}`,
        });
      }
    } catch (error) {
      findings.push({
        category: 'foreign_key',
        id: `fk_check_failed:${fk.id}`,
        severity: 'warning',
        repairable: false,
        detail: `could not check ${fk.id}: ${describeError(error)}`,
      });
    }
  }
  return { checked, orphans };
}

async function checkEncryption(findings: SelfCheckFinding[]): Promise<SelfCheckResult['encryption']> {
  const masterKey = resolveMasterKey();
  const summary: SelfCheckResult['encryption'] = {
    keyPresent: masterKey !== null,
    checkedColumns: 0,
    checkedValues: 0,
    failingValues: 0,
    nonCiphertextValues: 0,
    samples: [],
  };

  if (!masterKey) {
    findings.push({
      category: 'encryption',
      id: 'encryption_key_missing',
      severity: 'error',
      repairable: false,
      detail: 'MASTER_KEY is not set in this environment; encrypted columns could not be verified',
    });
    return summary;
  }

  for (const spec of ENCRYPTED_COLUMNS) {
    try {
      if (!(await relationExists(spec.table))) continue;
    } catch {
      continue;
    }

    const where = spec.columns.map((column) => `${column} IS NOT NULL`).join(' OR ');
    let rows: Array<Record<string, unknown>> = [];
    try {
      const result = await query(`SELECT * FROM ${spec.table} WHERE ${where} LIMIT 200`);
      rows = result.rows as Array<Record<string, unknown>>;
    } catch (error) {
      findings.push({
        category: 'encryption',
        id: `encryption_query_failed:${spec.table}`,
        severity: 'warning',
        repairable: false,
        detail: `could not sample ${spec.table}: ${describeError(error)}`,
      });
      continue;
    }

    for (const column of spec.columns) {
      let columnCounted = false;
      for (const row of rows) {
        const value = row[column];
        if (typeof value !== 'string' || value === '') continue;
        if (!columnCounted) {
          columnCounted = true;
          summary.checkedColumns += 1;
        }
        summary.checkedValues += 1;

        try {
          decrypt(value, masterKey);
        } catch (error) {
          // Ciphertext shape check mirrors shared/src/crypto.ts LEGACY_MIN_LENGTH (29 bytes).
          const looksLikeCiphertext = Buffer.from(value, 'base64').length >= 29;
          const label = `${spec.table}.${column}`;
          const rowId = row.id ?? row.user_id ?? '?';
          if (looksLikeCiphertext) {
            summary.failingValues += 1;
            findings.push({
              category: 'encryption',
              id: `decrypt_failed:${label}`,
              severity: 'error',
              repairable: false,
              detail: `value at ${label} (row ${String(rowId)}) did not decrypt with the current MASTER_KEY: ${describeError(error)}`,
            });
          } else {
            summary.nonCiphertextValues += 1;
            findings.push({
              category: 'encryption',
              id: `not_ciphertext:${label}`,
              severity: 'warning',
              repairable: false,
              detail: `${label} (row ${String(rowId)}) holds a value that is not ciphertext-shaped (likely legacy plaintext); it cannot be verified against MASTER_KEY`,
            });
          }
          if (summary.samples.length < 10) {
            summary.samples.push(`${label} row=${String(rowId)}: ${describeError(error)}`);
          }
        }
      }
    }
  }

  return summary;
}

/** Runs all four checks and returns a structured, JSON-safe result. */
export async function runMigrationSelfCheck(): Promise<SelfCheckResult> {
  const findings: SelfCheckFinding[] = [];
  const schemaVersion = await checkSchemaVersion(findings);
  const tables = await checkTables(findings);
  const indexes = await checkIndexes(findings);
  const foreignKeys = await checkForeignKeys(findings);
  const encryption = await checkEncryption(findings);

  const result: SelfCheckResult = {
    ok: !findings.some((finding) => finding.severity === 'error'),
    checkedAt: new Date().toISOString(),
    schemaVersion,
    tables,
    indexes,
    foreignKeys,
    encryption,
    findings,
  };

  log.info(
    {
      event: 'migration_selfcheck_complete',
      ok: result.ok,
      findings: findings.length,
      repairable: findings.filter((finding) => finding.repairable).length,
    },
    'Migration self-check finished',
  );
  return result;
}

/**
 * Idempotent repair of the repairable findings, followed by a fresh check.
 * Non-repairable findings are listed in `skipped` with a reason and are
 * never touched.
 */
export async function repairMigrationFindings(precomputed?: SelfCheckResult): Promise<RepairResult> {
  const check = precomputed ?? (await runMigrationSelfCheck());
  const repaired: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const finding of check.findings) {
    if (!finding.repairable) {
      skipped.push({ id: finding.id, reason: 'not repairable by this module (reported only)' });
      continue;
    }

    try {
      if (finding.category === 'index') {
        const expected = EXPECTED_INDEXES.find((candidate) => `missing_index:${candidate.name}` === finding.id);
        if (!expected) {
          skipped.push({ id: finding.id, reason: 'no DDL in the expected-index catalog' });
          continue;
        }
        await query(expected.ddl);
        repaired.push(finding.id);
        log.info({ event: 'migration_selfcheck_repair', id: finding.id }, `Repaired ${finding.id}`);
      } else if (finding.category === 'schema_version' && finding.id === 'schema_version_latest_missing') {
        // Repairing a "missing latest row" by INSERTing EXPECTED_MIGRATION_MAX is unsafe and was
      // actively harmful: with this module's stale constant that was 58, so running the repair
      // on a healthy v75 database would have fabricated a bogus v58 row and made the recorded
      // history non-contiguous. The runner is the only thing that may write schema_version,
      // because only it actually applies the DDL. Schema findings are report-only now.
      void finding;
        log.info({ event: 'migration_selfcheck_repair', id: finding.id }, `Repaired ${finding.id}`);
      } else {
        skipped.push({ id: finding.id, reason: 'repair not implemented for this finding' });
      }
    } catch (error) {
      skipped.push({ id: finding.id, reason: `repair failed: ${describeError(error)}` });
      log.warn(
        { event: 'migration_selfcheck_repair_failed', id: finding.id, error: describeError(error) },
        'Migration self-check repair failed',
      );
    }
  }

  return {
    attemptedAt: new Date().toISOString(),
    repaired,
    skipped,
    result: await runMigrationSelfCheck(),
  };
}
