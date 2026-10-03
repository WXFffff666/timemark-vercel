import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { sendNotifications } from '../services/notifications/index.js';
import { readDelivery } from '@timemark/shared';
import { fetchLogsByOutcome } from '../services/trigger-log-delivery-filter.js';
import type { User } from '@timemark/shared';

// GET / 的 outcome 筛选与重试合并写回见各 handler 内注释。

/**
 * events.notification_channels 是数组还是 JSON 字符串取决于写入方，这里两种都收。
 * 损坏的值返回空数组而不是抛异常 —— 它只用来决定「有没有渠道可补发」。
 */
function configuredChannels(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((c) => String(c).trim()).filter(Boolean);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((c) => String(c).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const triggerLogs = new Hono<{ Variables: { user: User } }>();

triggerLogs.use('*', authMiddleware);

// 获取事件触发日志
triggerLogs.get('/', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');
  const status = c.req.query('status');
  const outcome = c.req.query('outcome');
  const channel = c.req.query('channel');
  const eventId = c.req.query('eventId');

  const conditions = ['tl.user_id = $1'];
  const params: unknown[] = [userId];
  if (status) {
    params.push(status);
    conditions.push(`tl.status = $${params.length}`);
  }
  if (channel) {
    params.push(`%${channel}%`);
    conditions.push(`tl.channel_type ILIKE $${params.length}`);
  }
  if (eventId) {
    params.push(parseInt(eventId, 10));
    conditions.push(`tl.event_id = $${params.length}`);
  }
  const where = conditions.join(' AND ');

  // outcome 筛选（成功/部分失败/失败/跳过）：「部分失败」落库时 status='success'，
  // 按裸 status 筛不出来，推导逻辑在 service 里与 shared 的 readDelivery 共用同一份判定。
  if (outcome && ['partial', 'failed', 'delivered', 'skipped'].includes(outcome)) {
    const { rows: outcomeRows, total: outcomeTotal } = await fetchLogsByOutcome(userId, outcome, limit, offset);
    return c.json({
      success: true,
      data: outcomeRows,
      pagination: { total: outcomeTotal, limit, offset },
    });
  }

  try {
    const result = await query(
      `SELECT tl.*, e.name as event_name, e.type as event_type
       FROM event_trigger_logs tl
       LEFT JOIN events e ON tl.event_id = e.id
       WHERE ${where}
       ORDER BY tl.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    const countResult = await query(
      `SELECT COUNT(*) as total FROM event_trigger_logs tl WHERE ${where}`,
      params,
    );

    return c.json({
      success: true,
      data: result.rows,
      pagination: {
        total: countResult.rows[0]?.total || 0,
        limit,
        offset,
      },
    });
  } catch (error: any) {
    console.error('[TriggerLogs] Failed to fetch:', error);
    return c.json({ success: false, error: error.message || 'Failed to fetch logs' }, 500);
  }
});

// B18: CSV 导出
triggerLogs.get('/export.csv', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const result = await query(
    `SELECT tl.id, tl.event_id, e.name AS event_name, tl.trigger_type, tl.trigger_date,
            tl.status, tl.channel_type, tl.error_message, tl.created_at
     FROM event_trigger_logs tl
     LEFT JOIN events e ON tl.event_id = e.id
     WHERE tl.user_id = $1 ORDER BY tl.created_at DESC LIMIT 5000`,
    [userId],
  );
  const header = 'id,event_id,event_name,trigger_type,trigger_date,status,channel,error,created_at';
  const rows = result.rows.map((r: Record<string, unknown>) =>
    [r.id, r.event_id, r.event_name, r.trigger_type, r.trigger_date, r.status, r.channel_type, r.error_message, r.created_at]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','),
  );
  const csv = [header, ...rows].join('\n');
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', 'attachment; filename="trigger-logs.csv"');
  return c.body(csv);
});

// 重试失败的通知
triggerLogs.post('/:id/retry', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const logId = parseInt(c.req.param('id'));

  if (isNaN(logId)) {
    return c.json({ success: false, error: 'Invalid log ID' }, 400);
  }

  try {
    // Read the trigger log entry
    const logResult = await query(
      `SELECT tl.*, e.name as event_name, e.type as event_type, e.date as event_date,
              e.reminder_config, e.notification_channels, e.notification_account_ids,
              e.person_name, e.reminder_recipient_name, e.reminder_recipient_email
       FROM event_trigger_logs tl
       LEFT JOIN events e ON tl.event_id = e.id
       WHERE tl.id = $1 AND tl.user_id = $2`,
      [logId, userId]
    );

    if (logResult.rows.length === 0) {
      return c.json({ success: false, error: 'Trigger log not found' }, 404);
    }

    const logEntry = logResult.rows[0];

    // 部分失败（3 成功 1 失败）落库时 status='success'，旧代码因此直接 400 把重试挡掉，
    // 用户既看不到失败也补不了。真实结果从 channel_results 推导。
    const delivery = readDelivery({
      status: logEntry.status,
      channelResults: logEntry.channel_results,
      errorMessage: logEntry.error_message,
    });

    if (delivery.outcome === 'delivered') {
      return c.json({ success: false, error: 'Cannot retry a successful notification' }, 400);
    }

    // 重试只补真实失败渠道：_quiet_hours / _skipped 是内部标记，补发它们没有意义。
    // channel_results 是 JSONB，pg 已解析成对象（历史 TEXT 列才是字符串），交给 readDelivery
    // 两种形状都能处理——旧代码对对象做 JSON.parse 会抛异常并被静默吞掉。
    //
    // 两者都空时不能再 400：channel_type 只有「存在真实失败渠道」时才写（两个写入点都来自
    // failedEntries），所以 skipped 行、投递后异常、农历换算失败、测试发送抛异常这些行的
    // channel_type 与 channel_results 同时为空。界面按 outcome !== 'delivered' 渲染重试按钮
    // （和这里的 400 闸门同一条规则），这里再挡一次就等于给用户一个必然失败的按钮。
    // 回落到事件自己配置的渠道，让按钮真的能兑现。
    const channelsToRetry: string[] = logEntry.channel_type
      ? logEntry.channel_type.split(',').map((s: string) => s.trim()).filter(Boolean)
      : delivery.failed.length > 0
        ? delivery.failed
        : configuredChannels(logEntry.notification_channels);

    if (channelsToRetry.length === 0) {
      return c.json({ success: false, error: 'No failed channels to retry' }, 400);
    }

    // Re-activate the account if it was disabled
    if (logEntry.account_id) {
      await query(
        `UPDATE notification_accounts SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2`,
        [logEntry.account_id, userId]
      );
    }

    // Build event object for sendNotifications
    const event = {
      id: logEntry.event_id,
      name: logEntry.event_name,
      type: logEntry.event_type,
      date: logEntry.event_date,
      reminder_config: logEntry.reminder_config,
      notification_channels: logEntry.notification_channels,
      notification_account_ids: logEntry.notification_account_ids,
      person_name: logEntry.person_name,
      reminder_recipient_name: logEntry.reminder_recipient_name,
      reminder_recipient_email: logEntry.reminder_recipient_email,
    };

    // Re-send the notification
    const channelResults = await sendNotifications(event, userId, channelsToRetry);

    // Update the trigger log with new result
    // 重试同样只看真实渠道：重试发生在安静时段时 sendNotifications 会回一个
    // _quiet_hours 标记，它是 success:false 但不是渠道。旧代码把它算进失败，于是
    // 重试一次就把 error_message 写成 "_quiet_hours: quiet_hours"，并把这个假渠道
    // 存进 error_details。判定与 jobs/tasks.ts 用同一个 readDelivery。
    const sentDelivery = readDelivery({ channelResults });
    // status 仍只取 success/failed（去重、连续失败计数、清理都按它工作）。
    // 部分失败记 success：已送达的渠道不能因为另一个渠道失败而被重复投递。
    const newStatus = sentDelivery.outcome === 'delivered' || sentDelivery.outcome === 'partial' ? 'success' : 'failed';
    const newRetryCount = (logEntry.retry_count || 0) + 1;
    const newErrorMessage = newStatus === 'success' ? null : sentDelivery.reason;

    const sent = channelResults as Record<string, { error?: string; accountId?: number }>;
    const failedEntries = sentDelivery.failed
      .map((channel) => [channel, sent[channel]] as const)
      .filter((entry): entry is readonly [string, { error?: string; accountId?: number }] => !!entry[1]);

    // 合并而不是覆盖：重试只补发失败渠道，直接写回会把原本次数里已成功渠道的条目抹掉，
    // 前端从界面看不到它们，审计轨迹退化。本次结果按渠道覆盖旧条目。
    let previousResults: Record<string, unknown> = {};
    const rawPrevious = logEntry.channel_results;
    if (rawPrevious && typeof rawPrevious === 'object') {
      previousResults = rawPrevious as Record<string, unknown>;
    } else if (typeof rawPrevious === 'string') {
      // 历史 TEXT 列时代存的是字符串。
      try {
        const parsed = JSON.parse(rawPrevious);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previousResults = parsed;
      } catch { /* 坏数据当作没有旧结果 */ }
    }
    const mergedResults = { ...previousResults, ...sent };

    await query(
      `UPDATE event_trigger_logs
       SET status = $1, error_message = $2, channel_results = $3, retry_count = $4, error_details = $5
       WHERE id = $6 AND user_id = $7`,
      [
        newStatus,
        newErrorMessage,
        JSON.stringify(mergedResults),
        newRetryCount,
        failedEntries.length > 0
          ? JSON.stringify(failedEntries.map(([ch, r]) => ({ channel: ch, error: r.error, accountId: r.accountId })))
          : null,
        logId,
        userId
      ]
    );

    return c.json({
      success: true,
      data: {
        status: newStatus,
        retry_count: newRetryCount,
        channel_results: channelResults,
      },
    });
  } catch (error: any) {
    console.error('[TriggerLogs] Failed to retry:', error);
    return c.json({ success: false, error: error.message || 'Failed to retry notification' }, 500);
  }
});

// 清除触发日志
triggerLogs.delete('/', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);

  try {
    const result = await query('DELETE FROM event_trigger_logs WHERE user_id = $1', [userId]);
    return c.json({ success: true, data: { deleted: result.rowCount } });
  } catch (error: any) {
    console.error('[TriggerLogs] Failed to clear:', error);
    return c.json({ success: false, error: error.message || 'Failed to clear logs' }, 500);
  }
});

export default triggerLogs;
