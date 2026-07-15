import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  getSupportedChannelTemplates,
  getChannelTemplate,
  getSupportedChannelsByMethod,
  type ChannelConfigMethod,
} from '../services/notifications/channels.config.js';
import { isSupportedChannel } from '../services/notifications/supported-channels.js';
import { testConnectionSchema } from '@timemark/shared';
import type { User } from '@timemark/shared';
import { query } from '../db/index.js';
import { testConnection } from '../services/notifications/test-connection.js';
import { checkAllChannels, checkChannel } from '../services/notifications/network-check.js';

const channels = new Hono<{ Variables: { user: User } }>();

channels.use('*', authMiddleware);

channels.get('/templates', async (c) => {
  return c.json({ success: true, data: getSupportedChannelTemplates() });
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
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  if (!isSupportedChannel(parsed.data.type)) {
    return c.json({ success: false, error: '该通知渠道在云端部署中不可用' }, 400);
  }

  const accountId = typeof body.accountId === 'number' ? body.accountId : null;

  let testChatId = parsed.data.chatId || undefined;
  let testWebhook = parsed.data.webhook || undefined;
  if ((parsed.data.type === 'email' || parsed.data.type === 'resend') && !testChatId) {
    const cfg = await query('SELECT default_test_email FROM user_configs WHERE user_id = $1', [Number(user.id)]);
    testChatId = cfg.rows[0]?.default_test_email || testChatId;
  }

  try {
    const result = await testConnection({
      type: parsed.data.type,
      configMethod: parsed.data.configMethod || 'webhook',
      webhook: testWebhook,
      token: parsed.data.token || undefined,
      chatId: testChatId,
      secret: parsed.data.secret || undefined,
    });

    if (accountId) {
      const testResult = result.success ? 'success' : 'failed';
      const connStatus = result.success ? 'healthy' : 'unhealthy';
      await query(
        'UPDATE notification_accounts SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP, connection_status = $2 WHERE id = $3',
        [testResult, connStatus, accountId],
      );
    }

    return c.json({
      success: true,
      data: { success: result.success, message: result.message, details: result.details },
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
