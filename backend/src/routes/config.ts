import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  saveUserConfig,
  getUserConfig,
  getNotificationAccounts,
  createNotificationAccount,
  updateNotificationAccount,
  deleteNotificationAccount,
  getRelationshipMappings,
  createRelationshipMapping,
  updateRelationshipMapping,
  deleteRelationshipMapping,
  getReminderSettings,
  saveReminderSettings,
  saveNotificationDefaults,
  getEventTemplates,
  getEventTemplate,
  saveEventTemplate,
  deleteEventTemplate,
} from '../services/config.service.js';
import {
  createNotificationAccountSchema,
  updateNotificationAccountSchema,
  saveUserConfigSchema,
  createRelationshipMappingSchema,
  updateRelationshipMappingSchema,
  saveReminderSettingsSchema,
  saveEventTemplateSchema,
  formatZodError,
} from '@timemark/shared';
import type { User } from '@timemark/shared';
import { isSupportedChannel } from '../services/notifications/supported-channels.js';
import { testConnection } from '../services/notifications/test-connection.js';
import { getChannelTemplate } from '../services/notifications/channels.config.js';
import { query } from '../db/index.js';
import { resolveEmailRecipientForTest } from '../utils/notification-recipients.js';
import { logAudit } from '../services/audit.service.js';

const config = new Hono<{ Variables: { user: User } }>();

config.use('*', authMiddleware);

// 获取/保存用户配置
config.get('/', async (c) => {
  const user = c.get('user');
  const data = await getUserConfig(Number(user.id));
  return c.json({ success: true, data: data || {} });
});

config.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = saveUserConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: parsed.error.flatten() }, 400);
  }
  await saveUserConfig(Number(user.id), parsed.data);
  await logAudit(Number(user.id), 'update', 'user_config', user.id, { keys: Object.keys(parsed.data) });
  return c.json({ success: true });
});

// ============ 通知账户管理（支持多账号绑定）============

config.get('/accounts', async (c) => {
  const user = c.get('user');
  const accounts = await getNotificationAccounts(Number(user.id));
  return c.json({ success: true, data: accounts });
});

config.post('/accounts', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  
  const parsed = createNotificationAccountSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: parsed.error.flatten() }, 400);
  }
  if (!isSupportedChannel(parsed.data.type)) {
    return c.json({ success: false, error: '该通知渠道在云端部署中不可用' }, 400);
  }
  if (parsed.data.configMethod === 'plugin') {
    return c.json({ success: false, error: '插件类通知渠道在云端部署中不可用' }, 400);
  }
  
  const account = await createNotificationAccount(Number(user.id), {
    type: parsed.data.type,
    name: parsed.data.name,
    webhook: parsed.data.webhook || undefined,
    token: parsed.data.token || undefined,
    secret: parsed.data.secret || undefined,
    chat_id: parsed.data.chatId || undefined,
    config_method: parsed.data.configMethod || 'webhook',
    session_data: parsed.data.sessionData || undefined,
    plugin_package: parsed.data.pluginPackage || undefined,
  });

  const tpl = getChannelTemplate(parsed.data.type);
  if (tpl) {
    const userId = Number(user.id);
    const testChatId = await resolveEmailRecipientForTest(
      userId,
      parsed.data.type,
      parsed.data.chatId || undefined,
    );
    testConnection({
      type: parsed.data.type,
      configMethod: parsed.data.configMethod || tpl.configMethod,
      webhook: parsed.data.webhook || undefined,
      token: parsed.data.token || undefined,
      chatId: testChatId,
      secret: parsed.data.secret || undefined,
    }).then((result) => {
      const status = result.success ? 'healthy' : 'unhealthy';
      return query(
        `UPDATE notification_accounts SET connection_status = $1, last_test_result = $2, last_test_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [status, result.success ? 'success' : 'failed', account.id],
      );
    }).catch(() => {});
  }
  
  await logAudit(Number(user.id), 'create', 'notification_account', account.id, { type: parsed.data.type, name: parsed.data.name });
  return c.json({ success: true, data: account }, 201);
});

config.put('/accounts/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  
  const parsed = updateNotificationAccountSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: parsed.error.flatten() }, 400);
  }
  if (parsed.data.configMethod === 'plugin') {
    return c.json({ success: false, error: '插件类通知渠道在云端部署中不可用' }, 400);
  }
  
  const account = await updateNotificationAccount(id, Number(user.id), {
    name: parsed.data.name,
    webhook: parsed.data.webhook || undefined,
    token: parsed.data.token || undefined,
    secret: parsed.data.secret || undefined,
    chat_id: parsed.data.chatId || undefined,
    is_active: parsed.data.isActive,
    config_method: parsed.data.configMethod,
    session_data: parsed.data.sessionData || undefined,
    plugin_package: parsed.data.pluginPackage || undefined,
  });
  
  if (!account) {
    return c.json({ success: false, error: 'Account not found' }, 404);
  }

  await logAudit(Number(user.id), 'update', 'notification_account', id, {
    name: parsed.data.name,
    isActive: parsed.data.isActive,
    type: account.type,
  });
  return c.json({ success: true, data: account });
});

config.delete('/accounts/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'));
  
  const deleted = await deleteNotificationAccount(id, Number(user.id));
  
  if (!deleted) {
    return c.json({ success: false, error: 'Account not found' }, 404);
  }

  await logAudit(Number(user.id), 'delete', 'notification_account', id);
  return c.json({ success: true });
});

// ============ 关系映射管理 ============

config.get('/relationships', async (c) => {
  const user = c.get('user');
  const eventId = c.req.query('eventId');
  
  const mappings = await getRelationshipMappings(
    Number(user.id), 
    eventId ? parseInt(eventId) : undefined
  );
  
  return c.json({ success: true, data: mappings });
});

config.post('/relationships', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  
  const parsed = createRelationshipMappingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: parsed.error.flatten() }, 400);
  }
  
  const mapping = await createRelationshipMapping(Number(user.id), {
    event_id: parsed.data.event_id,
    from_relation: parsed.data.from_relation,
    to_relation: parsed.data.to_relation,
    recipient_email: parsed.data.recipient_email || undefined,
    recipient_type: parsed.data.recipient_type || undefined,
  });
  
  return c.json({ success: true, data: mapping }, 201);
});

config.put('/relationships/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  
  const parsed = updateRelationshipMappingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: parsed.error.flatten() }, 400);
  }
  
  const mapping = await updateRelationshipMapping(id, Number(user.id), {
    from_relation: parsed.data.from_relation,
    to_relation: parsed.data.to_relation,
    recipient_email: parsed.data.recipient_email || undefined,
    recipient_type: parsed.data.recipient_type || undefined,
  });
  
  if (!mapping) {
    return c.json({ success: false, error: 'Mapping not found' }, 404);
  }
  
  return c.json({ success: true, data: mapping });
});

config.delete('/relationships/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'));
  
  const deleted = await deleteRelationshipMapping(id, Number(user.id));
  
  if (!deleted) {
    return c.json({ success: false, error: 'Mapping not found' }, 404);
  }
  
  return c.json({ success: true });
});

// ============ 提醒设置 ============

config.get('/reminders', async (c) => {
  const user = c.get('user');
  const settings = await getReminderSettings(Number(user.id));
  return c.json({ success: true, data: settings });
});

config.post('/reminders', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  
  const parsed = saveReminderSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: parsed.error.flatten() }, 400);
  }
  
  await saveReminderSettings(Number(user.id), {
    enabled: parsed.data.enabled,
    dailyTime: parsed.data.dailyTime ?? undefined,
    daysBeforeList: parsed.data.daysBeforeList,
    emailAddresses: parsed.data.emailAddresses,
  });
  
  return c.json({ success: true });
});

config.get('/notification-advanced', async (c) => {
  const user = c.get('user');
  const row = await query(
    `SELECT markdown_email_template, notification_preset, api_scopes
     FROM user_configs WHERE user_id = $1`,
    [Number(user.id)],
  );
  const r = row.rows[0] || {};
  return c.json({
    success: true,
    data: {
      markdown_email_template: r.markdown_email_template ?? null,
      notification_preset: r.notification_preset ?? null,
      api_scopes: r.api_scopes ?? 'read,write',
    },
  });
});

config.post('/notification-advanced', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const userId = Number(user.id);
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (typeof body.markdown_email_template === 'string') {
    sets.push(`markdown_email_template = $${idx++}`);
    params.push(body.markdown_email_template.slice(0, 8000));
  } else if (body.markdown_email_template === null) {
    sets.push(`markdown_email_template = NULL`);
  }

  if (typeof body.notification_preset === 'string') {
    sets.push(`notification_preset = $${idx++}`);
    params.push(body.notification_preset.slice(0, 50));
  } else if (body.notification_preset === null) {
    sets.push(`notification_preset = NULL`);
  }

  if (typeof body.api_scopes === 'string') {
    const allowed = ['read', 'write'];
    const scopes = body.api_scopes.split(',').map((s: string) => s.trim()).filter((s: string) => allowed.includes(s));
    sets.push(`api_scopes = $${idx++}`);
    params.push(scopes.length ? scopes.join(',') : 'read');
  }

  if (sets.length === 0) {
    return c.json({ success: false, error: '无有效字段' }, 400);
  }

  params.push(userId);
  await query(
    `INSERT INTO user_configs (user_id) VALUES ($${idx})
     ON CONFLICT (user_id) DO UPDATE SET ${sets.join(', ')}`,
    params,
  );
  return c.json({ success: true });
});

config.post('/notification-defaults', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const defaultTestEmail = typeof body.default_test_email === 'string' ? body.default_test_email.trim() : undefined;
  const reminderEmails = Array.isArray(body.reminder_emails)
    ? body.reminder_emails.filter((e: unknown) => typeof e === 'string')
    : undefined;

  if (defaultTestEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(defaultTestEmail)) {
    return c.json({ success: false, error: '默认邮箱格式无效' }, 400);
  }

  await saveNotificationDefaults(Number(user.id), {
    default_test_email: defaultTestEmail ?? null,
    reminder_emails: reminderEmails,
  });
  return c.json({ success: true });
});

// ============ 事件模板管理 ============

config.get('/templates', async (c) => {
  const user = c.get('user');
  const templates = await getEventTemplates(Number(user.id));
  return c.json({ success: true, data: templates });
});

config.get('/templates/:type', async (c) => {
  const user = c.get('user');
  const type = c.req.param('type');
  
  const template = await getEventTemplate(Number(user.id), type);
  return c.json({ success: true, data: template });
});

config.post('/templates', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  
  const parsed = saveEventTemplateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: parsed.error.flatten() }, 400);
  }
  
  const template = await saveEventTemplate(
    Number(user.id),
    parsed.data.event_type,
    parsed.data.template_content
  );
  
  return c.json({ success: true, data: template }, 201);
});

config.delete('/templates/:type', async (c) => {
  const user = c.get('user');
  const type = c.req.param('type');
  
  const deleted = await deleteEventTemplate(Number(user.id), type);
  
  if (!deleted) {
    return c.json({ success: false, error: 'Template not found' }, 404);
  }
  
  return c.json({ success: true });
});

export default config;
