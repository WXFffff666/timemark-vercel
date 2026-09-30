import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createEvent, getEventsByUserIdPaginated, updateEvent, deleteEvent, deleteEventsByIds } from '../services/event.service.js';
import { createEventSchema, updateEventSchema, batchDeleteSchema, csvImportSchema, formatZodError } from '@timemark/shared';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';
import { createLogger, logFireAndForget } from '../utils/logger.js';
import { parseProfileFilter } from './profile-filter.js';

const events = new Hono<{ Variables: { user: User } }>();

events.use('*', authMiddleware);

events.get('/', async (c) => {
  const user = c.get('user');
  
  // 解析分页参数
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = (page - 1) * limit;

  // 可选档案过滤（checkbox 69）：省略 = 全部档案；他人的档案一律 404。
  const profileFilter = await parseProfileFilter(c, Number(user.id));
  if (profileFilter instanceof Response) return profileFilter;
  
  // 获取分页数据
  const result = await getEventsByUserIdPaginated(user.id, limit, offset, profileFilter);
  
  return c.json({
    success: true,
    data: result.events,
    pagination: {
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    },
  });
});

events.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createEventSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }

  // Validate notification_account_ids if provided
  const accountIds = parsed.data.reminderConfig?.accountIds;
  if (accountIds && accountIds.length > 0) {
    const userId = Number(user.id);
    const numericIds = accountIds.map((id: string) => Number(id)).filter((id: number) => !isNaN(id));
    
    if (numericIds.length > 0) {
      const placeholders = numericIds.map((_: number, i: number) => `$${i + 2}`).join(', ');
      const result = await query(
        `SELECT id FROM notification_accounts WHERE user_id = $1 AND is_active = TRUE AND id IN (${placeholders})`,
        [userId, ...numericIds]
      );
      const validIds = new Set(result.rows.map((r: any) => r.id));
      const invalidIds = numericIds.filter((id: number) => !validIds.has(id));
      
      if (invalidIds.length > 0) {
        return c.json({ 
          success: false, 
          error: `Invalid notification account IDs: ${invalidIds.join(', ')}. Accounts must exist and be active.` 
        }, 400);
      }
    }
  }

  const event = await createEvent(user.id, parsed.data);
  const { refreshUserEventCache } = await import('../services/event-cache.service.js');
  refreshUserEventCache(Number(user.id)).catch(
  logFireAndForget('events.cache_refresh_failed', 'Failed to refresh user event cache'),
);
  
  // 事件创建后立即检查是否需要发送提醒
  // 这样可以确保不会错过即将到来的提醒时间
  try {
    const { sendReminders } = await import('../jobs/tasks.js');
    await sendReminders();
  } catch (error) {
    console.error('[POST /events] Failed to check reminders after event creation:', error);
  }
  
  return c.json({ success: true, data: event }, 201);
});

events.get('/reminder-logs', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);

  // Display contract: trigger_date is TEXT since migration 51 and holds two families of ids.
  // A row's first 10 chars are a calendar day `YYYY-MM-DD` ONLY for legacy rows (exactly
  // 10 chars) and for normal dedup tokens `YYYY-MM-DD#d<n>#tHH:mm`; namespaced keys such as
  // `snooze:event#<id>#<ISO>` (buildSnoozeSendKey -> recordEventTrigger) carry NO leading
  // date - `LEFT('snooze:event#...', 10)` is `snooze:eve`. An unguarded LEFT would mangle
  // those rows, so expose the 10-char ymd only when the prefix really is one; otherwise
  // return the raw key unchanged. Raw dedup keys stay available via /trigger-logs + its CSV
  // export, and the UI never parses trigger_date into a Date.
  const result = await query(
    `SELECT tl.id, tl.event_id, tl.trigger_type,
            CASE WHEN tl.trigger_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN LEFT(tl.trigger_date, 10) ELSE tl.trigger_date END AS trigger_date,
            tl.status,
            tl.error_message, tl.channel_results, tl.created_at,
            e.name AS event_name, e.type AS event_type
     FROM event_trigger_logs tl
     LEFT JOIN events e ON e.id = tl.event_id
     WHERE tl.user_id = $1
     ORDER BY tl.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );

  return c.json({ success: true, data: result.rows });
});

const testSendLog = createLogger('events.test-send');

/** 解析事件行上的通知账号绑定（JSONB 数组或 JSON 字符串；与 sendNotifications 的容错一致）。 */
function parseBoundAccountIds(raw: unknown): number[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      // 损坏的绑定字段 -> 无绑定（与 sendNotifications 的解析一致，不放大成 500）。
      return [];
    }
  }
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((accountId) => Number.isInteger(accountId) && accountId > 0)
    : [];
}

/**
 * checkbox 167（QA 失败场景）：手动测试发送全部失败且事件显式绑定了通知账号时，
 * 找出「已停用」且对应渠道 no_configuration 的账号并点名，而不是只返回通用错误。
 * 查询失败只记日志并退回通用错误 —— 辅助信息绝不能让 400 变成 500。
 */
async function describeUnavailableBoundAccounts(
  event: Record<string, unknown>,
  channelResults: Record<string, { success: boolean; error?: string }>,
  userId: number,
): Promise<string | null> {
  const boundIds = parseBoundAccountIds(event.notification_account_ids);
  if (boundIds.length === 0) return null;
  const failedChannels = new Set(
    Object.entries(channelResults)
      .filter(([, result]) => !result.success && result.error === 'no_configuration')
      .map(([channel]) => channel),
  );
  if (failedChannels.size === 0) return null;
  try {
    const accounts = await query(
      `SELECT id, name, type, is_active FROM notification_accounts
       WHERE user_id = $1 AND id = ANY($2::int[])`,
      [userId, boundIds],
    );
    const inactive = (accounts.rows as Array<Record<string, unknown>>).filter(
      (row) => row.is_active === false && failedChannels.has(String(row.type)),
    );
    if (inactive.length === 0) return null;
    return inactive
      .map((row) => `账号「${String(row.name || row.type)}」(#${String(row.id)}, ${String(row.type)}) 已停用`)
      .join('、');
  } catch (error) {
    testSendLog.error(
      { event: 'manual_test_send.bound_accounts_lookup_failed', userId, err: error },
      'Failed to describe unavailable bound notification accounts',
    );
    return null;
  }
}

events.post('/:id/test-send', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const { sendNotifications } = await import('../services/notifications/index.js');
  const { recordEventTrigger } = await import('../services/trigger-log.service.js');
  const { query } = await import('../db/index.js');
  
  const result = await query('SELECT * FROM events WHERE id = $1 AND user_id = $2', [id, user.id]);
  if (result.rows.length === 0) {
    return c.json({ success: false, error: 'Event not found' }, 404);
  }
  
  const event = result.rows[0];
  const rawChannels = event.notification_channels;
  const baseChannels = typeof rawChannels === 'string' ? JSON.parse(rawChannels) : (rawChannels || []);
  const today = new Date().toISOString().slice(0, 10);

  // checkbox 167：手动测试发送必须和定时路径使用同一套渠道解析
  // （条件规则 > 套餐分级 > 事件渠道 > 用户自己的启用账号）。事件没有显式勾选渠道时，
  // 单用户安装也应回退到 owner 已配置的账号；优先级不在这里重写 —— 一律调用 resolver。
  const { resolveReminderChannels } = await import('../services/reminder-channel-resolver.service.js');
  const channels = await resolveReminderChannels(Number(user.id), baseChannels, 0);

  if (channels.length === 0) {
    // 与 checkbox 165 的定时路径一致：无渠道可用时绝不静默消失 —— 写入同款 skipped 记录
    // （status='skipped' + 机器可读原因，同一 reminder_send_claims 去重），并返回点名设置
    // 的可操作错误。recordSkippedTrigger 自身绝不抛出/growl，失败会打 error 日志。
    const { recordSkippedTrigger, NO_CHANNEL_RESOLVED_REASON } = await import('../jobs/tasks.js');
    await recordSkippedTrigger(Number(event.id), Number(event.id), Number(user.id), today, 'manual_test');
    return c.json({
      success: false,
      error: '未找到可用的通知渠道：请先在「设置 → 通知渠道」启用至少一个通知账号，或在事件中勾选渠道后重试。',
      data: { reason: NO_CHANNEL_RESOLVED_REASON },
    }, 400);
  }

  try {
    const channelResults = await sendNotifications(event, Number(user.id), channels, { skipQuietHours: true });
    const values = Object.values(channelResults);
    if (values.length === 0) {
      return c.json({
        success: false,
        error: '未找到可用通知账号。请在「通知渠道」配置并测试通过，或在事件中勾选渠道。',
        data: { channelResults },
      }, 400);
    }
    const hasFailure = values.some((r) => !r.success);
    const allFailed = values.length > 0 && values.every((r) => !r.success);
    const status = allFailed ? 'failed' : hasFailure ? 'partial' : 'success';
    // checkbox 167（QA 失败场景）：绑定账号已停用时点名该账号；同时写进提醒日志的错误信息。
    const boundAccountNote = allFailed
      ? await describeUnavailableBoundAccounts(event, channelResults, Number(user.id))
      : null;
    const errorMessage = boundAccountNote
      ? `绑定通知账号不可用：${boundAccountNote}。请在「设置 → 通知渠道」重新启用或改绑其他账号后重试。`
      : hasFailure
        ? Object.entries(channelResults).filter(([, r]) => !r.success).map(([ch, r]) => `${ch}: ${r.error}`).join('; ')
        : undefined;

    await recordEventTrigger(
      Number(event.id),
      Number(user.id),
      'manual_test',
      today,
      status === 'partial' ? 'failed' : status,
      errorMessage,
      JSON.stringify(channelResults),
      hasFailure
        ? {
            channel_type: Object.entries(channelResults).filter(([, r]) => !r.success).map(([ch]) => ch).join(','),
            details: Object.entries(channelResults).filter(([, r]) => !r.success).map(([ch, r]) => ({ channel: ch, error: r.error })),
          }
        : undefined,
    );

    if (allFailed) {
      return c.json({ success: false, error: errorMessage || '所有渠道发送失败', data: { channelResults } }, 400);
    }

    return c.json({
      success: true,
      message: hasFailure ? '部分渠道发送成功' : '测试通知已发送',
      data: { channelResults, status },
    });
  } catch (error) {
    console.error('[test-send] Error:', error);
    const errMsg = error instanceof Error ? error.message : 'Failed to send notification';
    await recordEventTrigger(Number(event.id), Number(user.id), 'manual_test', today, 'failed', errMsg);
    return c.json({ success: false, error: errMsg }, 500);
  }
});

events.put('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateEventSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }

  // Validate notification_account_ids if provided
  const accountIds = parsed.data.reminderConfig?.accountIds;
  if (accountIds && accountIds.length > 0) {
    const userId = Number(user.id);
    const numericIds = accountIds.map((id: string) => Number(id)).filter((id: number) => !isNaN(id));
    
    if (numericIds.length > 0) {
      const placeholders = numericIds.map((_: number, i: number) => `$${i + 2}`).join(', ');
      const result = await query(
        `SELECT id FROM notification_accounts WHERE user_id = $1 AND is_active = TRUE AND id IN (${placeholders})`,
        [userId, ...numericIds]
      );
      const validIds = new Set(result.rows.map((r: any) => r.id));
      const invalidIds = numericIds.filter((id: number) => !validIds.has(id));
      
      if (invalidIds.length > 0) {
        return c.json({ 
          success: false, 
          error: `Invalid notification account IDs: ${invalidIds.join(', ')}. Accounts must exist and be active.` 
        }, 400);
      }
    }
  }

  const success = await updateEvent(id, user.id, parsed.data);
  if (!success) {
    return c.json({ success: false, error: 'Event not found' }, 404);
  }
  const { refreshUserEventCache } = await import('../services/event-cache.service.js');
  refreshUserEventCache(Number(user.id)).catch(
  logFireAndForget('events.cache_refresh_failed', 'Failed to refresh user event cache'),
);

  // 事件更新后立即检查是否需要发送提醒
  // 这样可以确保不会错过即将到来的提醒时间
  try {
    const { sendReminders } = await import('../jobs/tasks.js');
    await sendReminders();
  } catch (error) {
    console.error('[PUT /events/:id] Failed to check reminders after event update:', error);
  }

  return c.json({ success: true });
});

events.delete('/batch', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = batchDeleteSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }

  const deleted = await deleteEventsByIds(parsed.data.ids, user.id);
  const { refreshUserEventCache } = await import('../services/event-cache.service.js');
  refreshUserEventCache(Number(user.id)).catch(
  logFireAndForget('events.cache_refresh_failed', 'Failed to refresh user event cache'),
);
  return c.json({ success: true, data: { deleted } });
});

events.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const success = await deleteEvent(id, user.id);

  if (!success) {
    return c.json({ success: false, error: 'Event not found' }, 404);
  }
  const { refreshUserEventCache } = await import('../services/event-cache.service.js');
  refreshUserEventCache(Number(user.id)).catch(
  logFireAndForget('events.cache_refresh_failed', 'Failed to refresh user event cache'),
);

  return c.json({ success: true });
});

// CSV Import endpoint
events.post('/import-csv', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  
  try {
    const body = await c.req.json();
    const parsed = csvImportSchema.safeParse(body);
    
    if (!parsed.success) {
      return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
    }
    
    const { csvData } = parsed.data;
    
    const lines = csvData.split('\n').filter((line: string) => line.trim());
    const headers = lines[0].split(',').map((h: string) => h.trim().toLowerCase());
    
    let imported = 0;
    const errors: string[] = [];
    
    for (let i = 1; i < lines.length; i++) {
      try {
        const values = lines[i].split(',').map((v: string) => v.trim());
        const row: Record<string, string> = {};
        headers.forEach((h: string, idx: number) => { row[h] = values[idx] || ''; });
        
        if (!row.name || !row.date) {
          errors.push(`Row ${i + 1}: missing name or date`);
          continue;
        }
        
        await query(
          `INSERT INTO events (user_id, name, type, date, calendar_type, reminder_config, notification_channels)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [userId, row.name, row.type || 'other', row.date, row.calendar_type || 'gregorian',
           JSON.stringify({ enabled: true, daysBeforeList: [1, 3, 7] }), JSON.stringify([])]
        );
        imported++;
      } catch (rowError: any) {
        errors.push(`Row ${i + 1}: ${rowError.message}`);
      }
    }
    
    return c.json({ success: true, data: { imported, errors } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'CSV import failed' }, 500);
  }
});

export default events;
