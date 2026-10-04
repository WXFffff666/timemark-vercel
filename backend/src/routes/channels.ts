import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  getSupportedChannelTemplates,
  getChannelTemplate,
  getSupportedChannelsByMethod,
  type ChannelConfigMethod,
} from '../services/notifications/channels.config.js';
import { isSupportedChannel } from '../services/notifications/supported-channels.js';
import { testConnectionSchema, formatZodError } from '@timemark/shared';
import type { User } from '@timemark/shared';
import { resolveEmailRecipientForTest } from '../utils/notification-recipients.js';
import { query } from '../db/index.js';
import { testConnection } from '../services/notifications/test-connection.js';
import { checkAllChannels, checkChannel } from '../services/notifications/network-check.js';
import { getNotificationAccounts } from '../services/config.service.js';
import { classifyChannelTestResult } from './cron.js';
import { SMTP_PROVIDER_PRESETS } from '@timemark/shared';
import { logFireAndForget } from '../utils/logger.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

const channels = new Hono<{ Variables: { user: User } }>();

channels.use('*', authMiddleware);

channels.get('/templates', async (c) => {
  return c.json({ success: true, data: getSupportedChannelTemplates() });
});

channels.get('/smtp-providers', async (c) => {
  return c.json({ success: true, data: SMTP_PROVIDER_PRESETS });
});

channels.get('/templates/:method', async (c) => {
  const method = c.req.param('method') as ChannelConfigMethod;
  if (!['webhook', 'token'].includes(method)) {
    return c.json({ success: false, error: 'Invalid method. Use webhook or token' }, 400);
  }
  return c.json({ success: true, data: getSupportedChannelsByMethod(method) });
});

channels.get('/template/:id', async (c) => {
  const id = c.req.param('id');
  if (!isSupportedChannel(id)) {
    return c.json({ success: false, error: 'Channel not supported on cloud deploy' }, 404);
  }
  const template = getChannelTemplate(id);
  if (!template) {
    return c.json({ success: false, error: 'Channel template not found' }, 404);
  }
  return c.json({ success: true, data: template });
});

channels.get('/available', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const result = await query(
    `SELECT id, type, name, config_method, is_active, suspended_until, last_test_result, last_test_at, connection_status
     FROM notification_accounts
     WHERE user_id = $1 AND is_active = TRUE`,
    [userId],
  );
  const rows = result.rows.filter((row: { type: string }) => isSupportedChannel(row.type));
  return c.json({ success: true, data: rows });
});

channels.post('/test', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = testConnectionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }
  if (parsed.data.type && !isSupportedChannel(parsed.data.type)) {
    return c.json({ success: false, error: '该通知渠道在云端部署中不可用' }, 400);
  }

  const accountId = parsed.data.accountId ?? null;
  const userId = Number(user.id);

  let testType = parsed.data.type || '';
  let testConfigMethod = parsed.data.configMethod || 'webhook';
  let testToken = parsed.data.token || undefined;
  let testChatId = parsed.data.chatId || undefined;
  let testWebhook = parsed.data.webhook || undefined;
  let testSecret = parsed.data.secret || undefined;

  if (accountId) {
    const accounts = await getNotificationAccounts(userId);
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      return c.json({ success: false, error: '通知渠道不存在' }, 404);
    }
    testType = account.type;
    testConfigMethod = account.config_method || testConfigMethod;
    testToken = testToken || account.token || undefined;
    testChatId = testChatId || account.chat_id || undefined;
    testWebhook = testWebhook || account.webhook || undefined;
    testSecret = testSecret || account.secret || undefined;
  }

  if (!testType) {
    return c.json({ success: false, error: '请指定 accountId 或渠道类型' }, 400);
  }

  if (!isSupportedChannel(testType)) {
    return c.json({ success: false, error: '该通知渠道在云端部署中不可用' }, 400);
  }

  if ((testType === 'email' || testType === 'resend') && !testChatId) {
    testChatId = await resolveEmailRecipientForTest(userId, testType, testChatId);
  }

  if ((testType === 'email' || testType === 'resend') && !testChatId) {
    return c.json({
      success: false,
      error: '未配置收件邮箱：请在渠道中填写收件人邮箱，或在「设置 → 通知默认邮箱」中填写默认测试邮箱',
    }, 400);
  }

  if ((testType === 'email' || testType === 'resend') && !testToken) {
    return c.json({ success: false, error: 'Resend API Key 不能为空' }, 400);
  }

  if (testType === 'smtp') {
    if (!testWebhook?.trim()) {
      return c.json({ success: false, error: 'SMTP 服务器不能为空' }, 400);
    }
    if (!testChatId?.trim() || !testChatId.includes('@')) {
      return c.json({ success: false, error: '请填写完整的发件人邮箱地址' }, 400);
    }
    if (!testToken?.trim() && !accountId) {
      return c.json({ success: false, error: '请填写邮箱授权码或应用专用密码' }, 400);
    }
  }

  try {
    const result = await testConnection({
      type: testType,
      configMethod: testConfigMethod,
      webhook: testWebhook,
      token: testToken,
      chatId: testChatId,
      secret: testSecret,
    });

    if (accountId) {
      // Same truthfulness contract as the channel-health cron: a channel without a
      // test path is 'unknown'/'unsupported', real outcomes keep healthy/unhealthy.
      // A successful test also clears any 24h failure suspension.
      const { connectionStatus, lastTestResult } = classifyChannelTestResult(result);
      if (result.success) {
        await query(
          `UPDATE notification_accounts
           SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP, connection_status = $2, suspended_until = NULL
           WHERE id = $3`,
          [lastTestResult, connectionStatus, accountId],
        );
      } else {
        await query(
          `UPDATE notification_accounts
           SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP, connection_status = $2
           WHERE id = $3`,
          [lastTestResult, connectionStatus, accountId],
        );
      }
    }

    if (!result.success) {
      return c.json({
        success: false,
        error: result.message,
        data: { success: false, message: result.message, details: result.details },
      }, 400);
    }

    return c.json({
      success: true,
      data: { success: true, message: result.message, details: result.details },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '测试连接失败';
    if (accountId) {
      await query(
        'UPDATE notification_accounts SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP, connection_status = $2 WHERE id = $3',
        ['error', 'unknown', accountId],
      ).catch(
        logFireAndForget(
          'channels.test_result_persist_failed',
          'Failed to persist failed test result for account',
        ),
      );
    }
    return c.json({ success: false, error: message }, 500);
  }
});

// v78: 手动恢复被 24h 暂停的渠道账户（清空 suspended_until，不动 is_active）
channels.post('/resume', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const body = await c.req.json().catch(() => ({}));
  const accountId = Number(body.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return c.json({ success: false, error: '缺少有效的 accountId' }, 400);
  }
  const result = await query(
    `UPDATE notification_accounts
     SET suspended_until = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND user_id = $2`,
    [accountId, userId],
  );
  if (result.rowCount === 0) {
    return c.json({ success: false, error: '通知渠道不存在' }, 404);
  }
  return c.json({ success: true });
});

// v78: 渠道发送统计 —— 聚合近 30 天 event_trigger_logs.channel_results（ChannelResultMap JSON），
// 按渠道给出 成功/失败/成功率，供渠道页健康概览卡展示。全静态 SQL（无插值）。
channels.get('/stats', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const result = await query(
    `SELECT channel_results, created_at
     FROM event_trigger_logs
     WHERE user_id = $1 AND channel_results IS NOT NULL
       AND created_at > NOW() - INTERVAL '30 days'`,
    [userId],
  );

  type Entry = { success?: boolean };
  const perChannel = new Map<string, { sent: number; ok: number }>();
  let runs = 0;
  for (const row of result.rows as Array<{ channel_results: unknown }>) {
    let parsed: Record<string, Entry> | null = null;
    try {
      const raw = typeof row.channel_results === 'string'
        ? JSON.parse(row.channel_results)
        : row.channel_results;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsed = raw as Record<string, Entry>;
      }
    } catch {
      continue;
    }
    if (!parsed) continue;
    runs++;
    for (const [channel, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      // `_`-prefixed keys are internal markers (e.g. fallback attempts), not real channels
      if (channel.startsWith('_')) continue;
      const stat = perChannel.get(channel) ?? { sent: 0, ok: 0 };
      stat.sent += 1;
      if (entry.success === true) stat.ok += 1;
      perChannel.set(channel, stat);
    }
  }

  const channels = [...perChannel.entries()]
    .map(([channel, stat]) => ({
      channel,
      sent: stat.sent,
      ok: stat.ok,
      failed: stat.sent - stat.ok,
      successRate: stat.sent > 0 ? Math.round((stat.ok / stat.sent) * 100) : 0,
    }))
    .sort((a, b) => b.sent - a.sent);

  return c.json({ success: true, data: { windowDays: 30, runs, channels } });
});

// v78: 一键全渠道自检 —— 并发测试该用户全部启用渠道账户，逐个落库测试结果，
// 并在成功时清除 24h 暂停（与单渠道 /test 完全同一套真实性契约）。
channels.post('/test-all', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const accounts = (await getNotificationAccounts(userId)).filter((a) => a.is_active !== false);

  if (accounts.length === 0) {
    return c.json({ success: true, data: { results: [], summary: { total: 0, passed: 0, failed: 0 } } });
  }

  const defaultEmail = await resolveEmailRecipientForTest(userId, 'resend', undefined);
  const results = await mapWithConcurrency(accounts, 4, async (account) => {
    const type = String(account.type);
    const webhook = account.webhook || undefined;
    const token = account.token || undefined;
    let chatId = account.chat_id || undefined;
    const secret = account.secret || undefined;
    const configMethod = account.config_method || 'webhook';

    if ((type === 'email' || type === 'resend') && !chatId) {
      chatId = defaultEmail || undefined;
    }

    const result = await testConnection({
      type,
      configMethod,
      webhook,
      token,
      chatId,
      secret,
    }).catch((err: unknown) => ({
      success: false,
      message: err instanceof Error ? err.message : '测试连接失败',
      details: undefined as string | undefined,
    }));

    const { connectionStatus, lastTestResult } = classifyChannelTestResult(result);
    if (result.success) {
      await query(
        `UPDATE notification_accounts
         SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP, connection_status = $2, suspended_until = NULL
         WHERE id = $3`,
        [lastTestResult, connectionStatus, account.id],
      ).catch(() => undefined);
    } else {
      await query(
        `UPDATE notification_accounts
         SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP, connection_status = $2
         WHERE id = $3`,
        [lastTestResult, connectionStatus, account.id],
      ).catch(() => undefined);
    }

    return {
      accountId: account.id,
      accountName: String(account.name || type),
      channel: type,
      success: result.success,
      message: result.message,
    };
  });

  const passed = results.filter((r) => r.success).length;
  return c.json({
    success: true,
    data: {
      results,
      summary: { total: results.length, passed, failed: results.length - passed },
    },
  });
});

channels.get('/network-check', async (c) => {
  const results = await checkAllChannels();
  return c.json({ success: true, data: results });
});channels.get('/network-check/:channel', async (c) => {
  const channel = c.req.param('channel');
  if (!isSupportedChannel(channel)) {
    return c.json({ success: false, error: 'Channel not supported' }, 400);
  }
  const result = await checkChannel(channel);
  return c.json({ success: true, data: result });
});

export default channels;
