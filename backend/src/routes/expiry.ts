import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  createExpiryItemSchema,
  updateExpiryItemSchema,
  formatZodError,
  EXPIRY_KINDS,
} from '@timemark/shared';
import {
  createExpiryItem,
  deleteExpiryItem,
  getExpiryCosts,
  listExpiryItems,
  listOverdueExpiryItems,
  listUpcomingExpiryItems,
  renewExpiryItem,
  updateExpiryItem,
  type ExpiryCostGranularity,
  type ExpiryItemFilters,
} from '../services/expiry.service.js';
import { parseProfileFilter } from './profile-filter.js';

/**
 * 到期中心 API（D1，todo 45）。
 *
 * 约定与既有路由一致：`new Hono<{Variables:{user:User}}>()` + `use('*', authMiddleware)`，
 * 分页返回 `{ success, data, pagination: { page, limit, total, totalPages } }`。
 * 全部查询按 user_id 限定；「不存在」与「他人的行」都是 404，不区分（防存在性泄露）。
 * 不提供批量删除。
 */
const expiry = new Hono<{ Variables: { user: User } }>();
expiry.use('*', authMiddleware);

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePage(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

expiry.get('/', async (c) => {
  const userId = Number(c.get('user').id);

  const kindRaw = c.req.query('kind');
  if (kindRaw && !(EXPIRY_KINDS as readonly string[]).includes(kindRaw)) {
    return c.json({ success: false, error: `未知的到期项类型: ${kindRaw}` }, 400);
  }
  const activeRaw = c.req.query('active');
  let active: boolean | undefined;
  if (activeRaw === 'true') active = true;
  else if (activeRaw === 'false') active = false;
  else if (activeRaw !== undefined && activeRaw !== '') {
    return c.json({ success: false, error: "active 只能为 'true' 或 'false'" }, 400);
  }
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from && !YMD_RE.test(from)) return c.json({ success: false, error: 'from 必须为 YYYY-MM-DD' }, 400);
  if (to && !YMD_RE.test(to)) return c.json({ success: false, error: 'to 必须为 YYYY-MM-DD' }, 400);

  // 可选档案过滤（checkbox 69）：省略 = 全部档案；他人的档案一律 404。
  const profileFilter = await parseProfileFilter(c, userId);
  if (profileFilter instanceof Response) return profileFilter;

  const filters: ExpiryItemFilters = {
    kind: kindRaw,
    active,
    from,
    to,
    q: c.req.query('q') || undefined,
    profileId: profileFilter,
  };
  const page = parsePage(c.req.query('page'));
  const limit = parseLimit(c.req.query('limit'));

  const { items, total } = await listExpiryItems(userId, filters, page, limit);
  return c.json({
    success: true,
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

expiry.get('/upcoming', async (c) => {
  const userId = Number(c.get('user').id);
  const raw = parseInt(c.req.query('days') ?? '', 10);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365) : 30;
  const items = await listUpcomingExpiryItems(userId, days);
  return c.json({ success: true, data: items, days });
});

expiry.get('/overdue', async (c) => {
  const userId = Number(c.get('user').id);
  const items = await listOverdueExpiryItems(userId);
  return c.json({ success: true, data: items });
});

expiry.get('/costs', async (c) => {
  const userId = Number(c.get('user').id);
  const granularityRaw = c.req.query('granularity') ?? 'month';
  if (granularityRaw !== 'month' && granularityRaw !== 'year') {
    return c.json({ success: false, error: "granularity 只能为 'month' 或 'year'" }, 400);
  }
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from && !YMD_RE.test(from)) return c.json({ success: false, error: 'from 必须为 YYYY-MM-DD' }, 400);
  if (to && !YMD_RE.test(to)) return c.json({ success: false, error: 'to 必须为 YYYY-MM-DD' }, 400);

  const costs = await getExpiryCosts(userId, {
    granularity: granularityRaw as ExpiryCostGranularity,
    from,
    to,
  });
  return c.json({ success: true, data: costs });
});

expiry.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createExpiryItemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }
  const item = await createExpiryItem(userId, parsed.data);
  return c.json({ success: true, data: item }, 201);
});

expiry.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateExpiryItemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const item = await updateExpiryItem(userId, id, parsed.data);
  if (!item) return c.json({ success: false, error: '到期项不存在' }, 404);
  return c.json({ success: true, data: item });
});

expiry.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const deleted = await deleteExpiryItem(userId, id);
  // 404（而非 403）：他人的行与不存在的行不可区分，避免存在性泄露
  if (!deleted) return c.json({ success: false, error: '到期项不存在' }, 404);
  return c.json({ success: true });
});

expiry.post('/:id/renew', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const result = await renewExpiryItem(userId, id);
  if (result.status === 'not_found') {
    // 他人的行同样 404，不泄露存在性
    return c.json({ success: false, error: '到期项不存在' }, 404);
  }
  if (result.status === 'not_renewable') {
    return c.json({
      success: false,
      error: '一次性到期项不能续期（cycle=once）：请手动修改下次到期日，或先将其改为周期型',
    }, 400);
  }
  return c.json({ success: true, data: result.item, history: result.history });
});

export default expiry;
