/**
 * v2.26 日志保留扩展表：此前从未被清理的记录表（审计报告确认的 8+ 张）。
 *
 * 每张表一条完整静态 DELETE 语句——表名/列名全部是本文件白名单字面量，
 * 零拼接、零插值；条件值全部走 $n 占位符。
 *
 * 保留期依据：
 * - reminder_send_claims 90 天：纯去重账本，年度幂等只需要当前年窗口
 * - scheduler_ticks 90 天：agent 工作流心跳 144 行/天，无业务回查价值
 * - audit_events 365 天 / security_events 365 天：安全审计最长保留（对齐 agent_audit_logs）
 * - audit_undo_snapshots：按自身 expires_at 过期清
 * - bot_updates / bot_audit_logs 30 天：telegram 去重与命令日志
 * - webhook_idempotency_keys 30 天：幂等窗口无需更长
 * - feed_ingest_seen / proposals 90 天：订阅源轮询窗口
 * - greeting_history 1095 天（3 年）：祝福最终文案是轮换依据 + 审计
 * - cron_execution_logs 30 天：成功路径已迁 cron_job_status，这里只剩失败明细
 */

export const RETENTION_TABLES_V26 = [
  'reminder_send_claims',
  'scheduler_ticks',
  'audit_events',
  'audit_undo_snapshots',
  'security_events',
  'audit_logs',
  'bot_updates',
  'bot_audit_logs',
  'webhook_idempotency_keys',
  'feed_ingest_seen',
  'feed_ingest_proposals',
  'greeting_history',
  'cron_execution_logs',
  // v2.28 C13：此前写入即累积、从未清理的 5 张
  'scheduler_runs',
  'rate_limits',
  'collaboration_activity',
  'data_health_repairs',
  'calendar_sync_events',
] as const;

export type RetentionTableV26 = (typeof RETENTION_TABLES_V26)[number];

/** 与既有 retentionCutoff 同一实现（本文件自带，避免旧文件大改） */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function retentionCutoff(days: unknown, now: Date = new Date()): Date | null {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return null;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  return new Date(now.getTime() - days * MS_PER_DAY);
}

export interface PurgeEntryV26 {
  days: number;
  sql: string;
  extraParams?: unknown[];
}

export const PURGE_SQL_V26: Record<RetentionTableV26, PurgeEntryV26> = {
  reminder_send_claims: { days: 90, sql: "DELETE FROM reminder_send_claims WHERE claimed_at < $1" },
  scheduler_ticks: { days: 90, sql: "DELETE FROM scheduler_ticks WHERE created_at < $1" },
  audit_events: { days: 365, sql: "DELETE FROM audit_events WHERE created_at < $1" },
  audit_undo_snapshots: { days: 7, sql: "DELETE FROM audit_undo_snapshots WHERE expires_at < $1" },
  security_events: { days: 365, sql: "DELETE FROM security_events WHERE created_at < $1" },
  audit_logs: { days: 365, sql: "DELETE FROM audit_logs WHERE created_at < $1" },
  bot_updates: { days: 30, sql: "DELETE FROM bot_updates WHERE created_at < $1" },
  bot_audit_logs: { days: 30, sql: "DELETE FROM bot_audit_logs WHERE created_at < $1" },
  webhook_idempotency_keys: { days: 30, sql: "DELETE FROM webhook_idempotency_keys WHERE created_at < $1" },
  feed_ingest_seen: { days: 90, sql: "DELETE FROM feed_ingest_seen WHERE seen_at < $1" },
  feed_ingest_proposals: { days: 90, sql: "DELETE FROM feed_ingest_proposals WHERE created_at < $1" },
  greeting_history: { days: 1095, sql: "DELETE FROM greeting_history WHERE created_at < $1" },
  cron_execution_logs: { days: 30, sql: "DELETE FROM cron_execution_logs WHERE executed_at < $1" },
  // v2.28 C13：调度运行账本 90 天（ticks 已 90，runs 对齐）
  scheduler_runs: { days: 90, sql: "DELETE FROM scheduler_runs WHERE started_at < $1" },
  // 限流窗口行 7 天（window_start 过期即无意义；key 无 user 维度，全实例级）
  rate_limits: { days: 7, sql: "DELETE FROM rate_limits WHERE window_start < $1" },
  // 协作活动流水 180 天
  collaboration_activity: { days: 180, sql: "DELETE FROM collaboration_activity WHERE created_at < $1" },
  // 数据健康修复记录 365 天（审计价值，保留一年足够）
  data_health_repairs: { days: 365, sql: "DELETE FROM data_health_repairs WHERE created_at < $1" },
  // 日历同步流水 90 天（对账问题一般两周内提出）
  calendar_sync_events: { days: 90, sql: "DELETE FROM calendar_sync_events WHERE created_at < $1" },
};

/** 单表清理返回的行数；query 不可用时返回 0（与既有 purgeLogTable 同契约） */
export async function purgeTableV26(
  table: RetentionTableV26,
  run: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }>,
  cutoff: Date,
): Promise<number> {
  const entry = PURGE_SQL_V26[table];
  const result = await run(entry.sql, [cutoff, ...(entry.extraParams ?? [])]);
  return result.rowCount ?? 0;
}

export interface RetentionPurgeResultV26 {
  reminderSendClaims: number;
  schedulerTicks: number;
  auditEvents: number;
  auditUndoSnapshots: number;
  securityEvents: number;
  auditLogs: number;
  botUpdates: number;
  botAuditLogs: number;
  webhookIdempotencyKeys: number;
  feedIngestSeen: number;
  feedIngestProposals: number;
  greetingHistory: number;
  cronExecutionLogs: number;
  /** v2.28 C13 新接入的 5 张 */
  schedulerRuns: number;
  rateLimits: number;
  collaborationActivity: number;
  dataHealthRepairs: number;
  calendarSyncEvents: number;
}
