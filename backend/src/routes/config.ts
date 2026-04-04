import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { getUserConfig, saveUserConfig, getNotificationAccounts, createNotificationAccount, updateNotificationAccount, deleteNotificationAccount, getRelationshipMappings, createRelationshipMapping, updateRelationshipMapping, deleteRelationshipMapping, getReminderSettings, saveReminderSettings } from '../services/config.service.js';
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
  await saveUserConfig(Number(user.id), body || {});
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
  
  if (!body.type || !body.name) {
    return c.json({ success: false, error: 'type and name are required' }, 400);
  }
  
  const account = await createNotificationAccount(Number(user.id), {
    type: body.type,
    name: body.name,
    webhook: body.webhook,
    token: body.token,
    secret: body.secret,
    chat_id: body.chatId,
  });
  
  return c.json({ success: true, data: account }, 201);
});

config.put('/accounts/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  
  const account = await updateNotificationAccount(id, Number(user.id), {
    name: body.name,
    webhook: body.webhook,
    token: body.token,
    secret: body.secret,
    chat_id: body.chatId,
    is_active: body.isActive,
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
  
  if (!body.event_id || !body.from_relation || !body.to_relation) {
    return c.json({ success: false, error: 'event_id, from_relation, and to_relation are required' }, 400);
  }
  
  const mapping = await createRelationshipMapping(Number(user.id), {
    event_id: body.event_id,
    from_relation: body.from_relation,
    to_relation: body.to_relation,
    recipient_email: body.recipient_email,
    recipient_type: body.recipient_type,
  });
  
  return c.json({ success: true, data: mapping }, 201);
});

config.put('/relationships/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  
  const mapping = await updateRelationshipMapping(id, Number(user.id), {
    from_relation: body.from_relation,
    to_relation: body.to_relation,
    recipient_email: body.recipient_email,
    recipient_type: body.recipient_type,
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
  
  await saveReminderSettings(Number(user.id), {
    enabled: body.enabled,
    dailyTime: body.dailyTime,
    daysBeforeList: body.daysBeforeList,
    emailAddresses: body.emailAddresses,
  });
  
  return c.json({ success: true });
});

export default config;
