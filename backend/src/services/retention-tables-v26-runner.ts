/**
 * v2.26 保留清理执行器：把 retention-tables-v26 的 13 张此前从未清理的表
 * 接入 daily-maintenance。SQL 全部来自 retention-tables-v26 的静态白名单
 * （本文件不含任何 SQL 字面量，只有执行与计数）。
 */
import { query } from '../db/index.js';
import { retentionCutoff, RETENTION_TABLES_V26, type RetentionPurgeResultV26, type RetentionTableV26 } from './retention-tables-v26.js';

export async function purgeTablesV26(options?: { now?: Date }): Promise<RetentionPurgeResultV26> {
  const now = options?.now === undefined ? new Date() : options.now;
  const out: RetentionPurgeResultV26 = {
    reminderSendClaims: 0,
    schedulerTicks: 0,
    auditEvents: 0,
    auditUndoSnapshots: 0,
    securityEvents: 0,
    auditLogs: 0,
    botUpdates: 0,
    botAuditLogs: 0,
    webhookIdempotencyKeys: 0,
    feedIngestSeen: 0,
    feedIngestProposals: 0,
    greetingHistory: 0,
    cronExecutionLogs: 0,
  };

  for (const table of RETENTION_TABLES_V26) {
    const entry = (await import('./retention-tables-v26.js')).PURGE_SQL_V26[table as RetentionTableV26];
    const cutoff = retentionCutoff(entry.days, now);
    if (!cutoff) continue;
    try {
      const result = await query(entry.sql, [cutoff, ...(entry.extraParams ?? [])]);
      const key = table.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof RetentionPurgeResultV26;
      if (key in out) out[key] = result.rowCount ?? 0;
    } catch (error) {
      // 单表失败（列名漂移/表未建）不阻断其余表的清理——下一轮 maintenance 再试
      console.warn(`[retention-v26] purge ${table} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return out;
}
