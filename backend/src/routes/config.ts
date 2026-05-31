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
} from '@timemark/shared';
import type { User } from '@timemark/shared';

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
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  await saveUserConfig(Number(user.id), parsed.data);
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
    return c.json({ success: false, error: 'Invalid input', details: parsed.error.flatten() }, 400);
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
  
  return c.json({ success: true, data: account }, 201);
});

config.put('/accounts/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  
  const parsed = updateNotificationAccountSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid input', details: parsed.error.flatten() }, 400);
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
  
  return c.json({ success: true, data: account });
});

config.delete('/accounts/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'));
  
  const deleted = await deleteNotificationAccount(id, Number(user.id));
  
  if (!deleted) {
    return c.json({ success: false, error: 'Account not found' }, 404);
  }
  
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
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
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
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
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
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  
  await saveReminderSettings(Number(user.id), {
    enabled: parsed.data.enabled,
    dailyTime: parsed.data.dailyTime ?? undefined,
    daysBeforeList: parsed.data.daysBeforeList,
    emailAddresses: parsed.data.emailAddresses,
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
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
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
