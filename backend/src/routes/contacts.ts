import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  createFixedContactSchema,
  updateFixedContactSchema,
} from '@timemark/shared';
import {
  listFixedContacts,
  createFixedContact,
  updateFixedContact,
  deleteFixedContact,
  validateContactFields,
} from '../services/contact.service.js';

const contacts = new Hono<{ Variables: { user: User } }>();
contacts.use('*', authMiddleware);

contacts.get('/', async (c) => {
  const user = c.get('user');
  const data = await listFixedContacts(Number(user.id));
  return c.json({ success: true, data });
});

contacts.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = createFixedContactSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const row = await createFixedContact(Number(user.id), parsed.data);
    return c.json({ success: true, data: row }, 201);
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : '创建失败' }, 400);
  }
});

contacts.put('/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const parsed = updateFixedContactSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const row = await updateFixedContact(Number(user.id), id, parsed.data);
    if (!row) return c.json({ success: false, error: '联系人不存在' }, 404);
    return c.json({ success: true, data: row });
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : '更新失败' }, 400);
  }
});

contacts.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'), 10);
  const ok = await deleteFixedContact(Number(user.id), id);
  if (!ok) return c.json({ success: false, error: '联系人不存在' }, 404);
  return c.json({ success: true });
});

contacts.post('/validate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = validateContactFields({
    email: body.email,
    phone: body.phone,
    telegram_chat_id: body.telegramChatId,
    qq: body.qq,
    wxpusher_uid: body.wxpusherUid,
  });
  return c.json({ success: true, data: result });
});

export default contacts;
