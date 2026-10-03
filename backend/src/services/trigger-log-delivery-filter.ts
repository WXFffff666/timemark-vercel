import { query } from '../db/index.js';
import { readDelivery, type DeliveryOutcome } from '@timemark/shared';

/**
 * 提醒日志按「真实投递结果」筛选。
 *
 * event_trigger_logs.status 只有 success/failed/skipped，而「部分失败」落库时
 * status='success'，所以按裸 status 筛不出来（选"成功"会混入部分失败、选"失败"返回空）。
 *
 * 推导用 shared 的 readDelivery 在应用层做（与重试闸门、界面展示是同一份判定，不会漂移）：
 * 先按时间倒序取一个分析窗口内的行，再逐行推导并过滤、分页。单用户应用的日志量级下，
 * 窗口足够覆盖；超出窗口的更早历史不参与 outcome 筛选（按其它条件筛选不受影响）。
 */

/** outcome 筛选时参与推导的最大行数（按 created_at 倒序取最近的）。 */
const OUTCOME_SCAN_WINDOW = 1000;

export async function fetchLogsByOutcome(
  userId: number,
  outcome: string,
  limit: number,
  offset: number,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const result = await query(
    'SELECT id, status, channel_results, error_message, created_at FROM event_trigger_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, OUTCOME_SCAN_WINDOW],
  );

  const matching = (result.rows as Array<Record<string, unknown>>).filter((row) => {
    const report = readDelivery({
      status: row.status as string | null,
      channelResults: row.channel_results,
      errorMessage: row.error_message as string | null,
    });
    return report.outcome === (outcome as DeliveryOutcome);
  });

  const total = matching.length;
  const page = matching.slice(offset, offset + limit);
  if (page.length === 0) return { rows: [], total };

  // 再按这页的 id 取完整行（含事件名），保持原有列表形状。
  const ids = page.map((row) => row.id as number);
  const fullResult = await query(
    'SELECT tl.*, e.name as event_name, e.type as event_type FROM event_trigger_logs tl LEFT JOIN events e ON tl.event_id = e.id WHERE tl.user_id = $1 AND tl.id = ANY($2::int[]) ORDER BY tl.created_at DESC',
    [userId, ids],
  );
  return { rows: fullResult.rows as Record<string, unknown>[], total };
}
