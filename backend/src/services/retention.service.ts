import { query } from '../db/index.js';

/**
 * Retention windows (days) for the append-only logging tables.
 * Trigger logs stay user-visible (todo 12), so 180 days — not shorter.
 */
export const RETENTION_DAYS = {
  eventTriggerLogs: 180,
  emailLogs: 180,
  loginAttempts: 90,
  notificationQueue: 30,
} as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pure cutoff math: `now - days`.
 *
 * Returns `null` for malformed input (non-finite / non-positive `days`,
 * invalid `now`) so callers MUST skip the purge rather than build a cutoff
 * that would match everything (or nothing).
 */
export function retentionCutoff(days: unknown, now: Date = new Date()): Date | null {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return null;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  return new Date(now.getTime() - days * MS_PER_DAY);
}

export type RetentionTable =
  | 'event_trigger_logs'
  | 'email_logs'
  | 'login_attempts'
  | 'notification_queue';

/**
 * Table -> time column mapping. `email_logs` has `sent_at` (no `created_at`),
 * `login_attempts` has `last_attempt` (no `created_at`); the queue keeps its
 * historical `status IN ('completed','dead')` guard so an active retry row is
 * never purged.
 */
const RETENTION_TABLES: Record<
  RetentionTable,
  { days: number; timeColumn: string; extraWhere?: string }
> = {
  event_trigger_logs: { days: RETENTION_DAYS.eventTriggerLogs, timeColumn: 'created_at' },
  email_logs: { days: RETENTION_DAYS.emailLogs, timeColumn: 'sent_at' },
  login_attempts: { days: RETENTION_DAYS.loginAttempts, timeColumn: 'last_attempt' },
  notification_queue: {
    days: RETENTION_DAYS.notificationQueue,
    timeColumn: 'updated_at',
    extraWhere: `status IN ('completed', 'dead')`,
  },
};

/**
 * Delete rows older than the retention window from one logging table.
 * `options.now`/`options.days` exist for deterministic tests; production
 * callers use the table's configured window.
 */
export async function purgeLogTable(
  table: RetentionTable,
  options?: { now?: Date; days?: number },
): Promise<number> {
  const config = RETENTION_TABLES[table];
  // Only an OMITTED clock defaults to now. A malformed (null/NaN) clock must
  // fall through to retentionCutoff() returning null and skip the DELETE.
  const now = options?.now === undefined ? new Date() : options.now;
  const cutoff = retentionCutoff(options?.days ?? config.days, now);
  if (!cutoff) return 0;
  const where = `${config.timeColumn} < $1${config.extraWhere ? ` AND ${config.extraWhere}` : ''}`;
  const result = await query(`DELETE FROM ${table} WHERE ${where}`, [cutoff]);
  return result.rowCount ?? 0;
}

export interface RetentionPurgeResult {
  triggerLogs: number;
  emailLogs: number;
  loginAttempts: number;
  notificationQueue: number;
}

/**
 * Purge every logging table past its retention window. Called from
 * `/api/cron/daily-maintenance`; counts are surfaced in the JSON summary.
 */
export async function purgeExpiredLogs(options?: { now?: Date }): Promise<RetentionPurgeResult> {
  return {
    triggerLogs: await purgeLogTable('event_trigger_logs', options),
    emailLogs: await purgeLogTable('email_logs', options),
    loginAttempts: await purgeLogTable('login_attempts', options),
    notificationQueue: await purgeLogTable('notification_queue', options),
  };
}
