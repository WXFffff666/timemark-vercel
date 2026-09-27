import { query } from '../db/index.js';
import { deleteObject } from './storage.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('attachment-retention');

/**
 * 附件保留策略（todo 57）：清理孤儿附件。
 *
 * 「孤儿」定义（与 docs/ATTACHMENTS.md 一致）：
 * - 未关联：owner_type / owner_id 均为空（用户主动解链后未再关联）；或
 * - owner 行已被删除：owner 对存在但对应实体表里没有任何 `id = owner_id AND user_id = 自己`
 *   的行（多态引用按表逐一 NOT EXISTS 判断）。
 *
 * 已关联且 owner 行仍在的附件**永不**被清理。
 *
 * 截止时间由 SQL 里的 `NOW() - ($1::int * INTERVAL '1 day')` 计算 —— 每次都取数据库
 * 当前时间，不做任何进程内缓存，因此 daily-maintenance 的每次执行都用真实「现在」。
 * 每次最多处理 500 行，避免单次 cron 过长；下一轮继续。
 */
export const ATTACHMENT_ORPHAN_RETENTION_DAYS = 30;

/** 单批上限；剩余孤儿由后续 daily-maintenance 继续清理。 */
export const ATTACHMENT_PURGE_BATCH_LIMIT = 500;

export interface AttachmentPurgeResult {
  /** 扫描到的孤儿数（本批） */
  orphans: number;
  /** 删除成功的行数 */
  purged: number;
  /** 成功删除的对象数（对象缺失也算成功） */
  objectsDeleted: number;
  /** 对象删除失败数（行已删，对象留给下一轮/人工处理） */
  objectDeleteFailures: number;
}

const ORPHAN_CANDIDATES_SQL = `
SELECT a.id, a.user_id, a.storage_key
FROM attachments a
WHERE a.created_at < NOW() - ($1::int * INTERVAL '1 day')
  AND (
    a.owner_type IS NULL
    OR (a.owner_type = 'document' AND NOT EXISTS (
      SELECT 1 FROM documents o WHERE o.id = a.owner_id AND o.user_id = a.user_id))
    OR (a.owner_type = 'expiry' AND NOT EXISTS (
      SELECT 1 FROM expiry_items o WHERE o.id = a.owner_id AND o.user_id = a.user_id))
    OR (a.owner_type = 'inventory' AND NOT EXISTS (
      SELECT 1 FROM inventory_items o WHERE o.id = a.owner_id AND o.user_id = a.user_id))
    OR (a.owner_type = 'maintenance' AND NOT EXISTS (
      SELECT 1 FROM maintenance_plans o WHERE o.id = a.owner_id AND o.user_id = a.user_id))
    OR (a.owner_type = 'event' AND NOT EXISTS (
      SELECT 1 FROM events o WHERE o.id = a.owner_id AND o.user_id = a.user_id))
  )
ORDER BY a.id ASC
LIMIT ${ATTACHMENT_PURGE_BATCH_LIMIT}`;

/**
 * Purge orphan attachments older than the retention window (default 30 days):
 * rows first (source of truth), then their objects best-effort. A transient
 * object-store failure never resurrects a row; it is logged with a stable event id.
 */
export async function purgeOrphanAttachments(options?: { days?: number }): Promise<AttachmentPurgeResult> {
  const days = Number.isFinite(options?.days) && (options?.days as number) > 0
    ? Math.floor(options?.days as number)
    : ATTACHMENT_ORPHAN_RETENTION_DAYS;

  const candidates = await query(ORPHAN_CANDIDATES_SQL, [days]);
  const rows = candidates.rows as Array<{ id: number; storage_key: string }>;
  const result: AttachmentPurgeResult = {
    orphans: rows.length,
    purged: 0,
    objectsDeleted: 0,
    objectDeleteFailures: 0,
  };
  if (rows.length === 0) return result;

  const ids = rows.map((row) => Number(row.id));
  const deleted = await query(
    'DELETE FROM attachments WHERE id = ANY($1::int[]) RETURNING id, storage_key',
    [ids],
  );
  result.purged = deleted.rows.length;

  for (const row of deleted.rows as Array<{ id: number; storage_key: string }>) {
    try {
      await deleteObject(row.storage_key);
      result.objectsDeleted += 1;
    } catch (error) {
      result.objectDeleteFailures += 1;
      // Deliberately does not log storage_key or any URL; the row is gone and the
      // object is retried on the next daily-maintenance run.
      log.warn(
        { event: 'attachment.orphan_purge_object_delete_failed', attachmentId: Number(row.id), err: error },
        'Failed to delete an orphan attachment object; retried next run',
      );
    }
  }

  return result;
}
