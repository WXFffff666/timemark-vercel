import { Hono } from 'hono';
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
import { SMTP_PROVIDER_PRESETS } from '@timemark/shared';

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
    `SELECT id, type, name, config_method, is_active, last_test_result, last_test_at, connection_status
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
      details: parsed.error.flatten(),
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
      const testResult = result.success ? 'success' : 'failed';
      const connStatus = result.success ? 'healthy' : 'unhealthy';
      await query(
        'UPDATE notification_accounts SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP, connection_status = $2 WHERE id = $3',
        [testResult, connStatus, accountId],
      );
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
        'UPDATE notification_accounts SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP WHERE id = $2',
        ['failed', accountId],
      ).catch(() => {});
    }
    return c.json({ success: false, error: message }, 500);
  }
});

channels.get('/network-check', async (c) => {
  const results = await checkAllChannels();
  return c.json({ success: true, data: results });
});

channels.get('/network-check/:channel', async (c) => {
  const channel = c.req.param('channel');
  if (!isSupportedChannel(channel)) {
    return c.json({ success: false, error: 'Channel not supported' }, 400);
  }
  const result = await checkChannel(channel);
  return c.json({ success: true, data: result });
});

export default channels;
