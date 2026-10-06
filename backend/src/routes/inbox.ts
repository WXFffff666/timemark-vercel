import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  listInboxMessages,
  markInboxRead,
  markAllInboxRead,
  deleteInboxMessage,
  batchMarkInboxRead,
  batchDeleteInboxMessages,
  getInboxReceiveTokens,
} from '../services/inbox.service.js';

const inbox = new Hono<{ Variables: { user: User } }>();
inbox.use('*', authMiddleware);

inbox.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  // v2.27：limit 上限与服务层（100）保持一致，否则分页 offset 会跳行
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);
  const unreadOnly = c.req.query('unread') === '1';
  // v2.30：来源标签页（all/inbound/broadcast，默认 all）
  const sourceParam = c.req.query('source');
  const source = sourceParam === 'inbound' || sourceParam === 'broadcast' ? sourceParam : 'all';

  // v2.27 A-13：文本搜索 + since 增量拉取
  const data = await listInboxMessages(userId, {
    limit,
    offset,
    unreadOnly,
    q: c.req.query('q') || undefined,
    since: c.req.query('since') || undefined,
    source,
  });
  return c.json({ success: true, data: data.messages, pagination: { total: data.total, unreadCount: data.unreadCount, limit, offset } });
});

// v2.30：批量已读 / 批量删除（ids 全量做 user_id 归属过滤）
inbox.post('/batch-read', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length === 0) return c.json({ success: false, error: 'ids 不能为空' }, 400);
  if (ids.length > 200) return c.json({ success: false, error: '单次最多 200 条' }, 400);
  const affected = await batchMarkInboxRead(userId, ids);
  return c.json({ success: true, data: { affected } });
});

inbox.post('/batch-delete', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length === 0) return c.json({ success: false, error: 'ids 不能为空' }, 400);
  if (ids.length > 200) return c.json({ success: false, error: '单次最多 200 条' }, 400);
  const affected = await batchDeleteInboxMessages(userId, ids);
  return c.json({ success: true, data: { affected } });
});

inbox.get('/info', async (c) => {
  const userId = Number(c.get('user').id);
  const tokens = await getInboxReceiveTokens(userId);
  const host = c.req.header('Host') || 'localhost';
  const protocol = c.req.header('X-Forwarded-Proto') || 'https';
  const receiveUrl = tokens.inboxReceiveToken
    ? `${protocol}://${host}/api/inbox/receive/${tokens.inboxReceiveToken}`
    : null;

  return c.json({
    success: true,
    data: {
      receiveUrl,
      hasSecret: !!tokens.inboxReceiveSecret,
      // v2.30：签名强制时外部发送方必须拿到密钥才能计算 X-Timemark-Signature，
      // 而此前密钥从未对用户展示过——收件功能实际上无人可用。密钥属于所有者，
      // 在鉴权后的 /info 里下发（与 API Token 管理同一暴露级别）。
      receiveSecret: tokens.inboxReceiveSecret,
      retentionDays: 30,
    },
  });
});

inbox.patch('/:id/read', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseInt(c.req.param('id'), 10);
  if (Number.isNaN(id)) {
    return c.json({ success: false, error: '无效的消息 ID' }, 400);
  }
  const ok = await markInboxRead(userId, id);
  if (!ok) return c.json({ success: false, error: '消息不存在' }, 404);
  return c.json({ success: true });
});

inbox.post('/read-all', async (c) => {
  const userId = Number(c.get('user').id);
  const count = await markAllInboxRead(userId);
  return c.json({ success: true, data: { marked: count } });
});

inbox.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseInt(c.req.param('id'), 10);
  if (Number.isNaN(id)) {
    return c.json({ success: false, error: '无效的消息 ID' }, 400);
  }
  const ok = await deleteInboxMessage(userId, id);
  if (!ok) return c.json({ success: false, error: '消息不存在' }, 404);
  return c.json({ success: true });
});

export default inbox;
