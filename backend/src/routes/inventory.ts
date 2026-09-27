import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  consumeInventoryItemSchema,
  createInventoryItemSchema,
  formatZodError,
  updateInventoryItemSchema,
  INVENTORY_CATEGORIES,
} from '@timemark/shared';
import {
  consumeInventoryItem,
  createInventoryItem,
  deleteInventoryItem,
  getInventoryItem,
  listExpiringInventoryItems,
  listInventoryItems,
  listLowStockInventoryItems,
  updateInventoryItem,
  type InventoryItemFilters,
} from '../services/inventory.service.js';
import { parseProfileFilter } from './profile-filter.js';

/**
 * 库存 API（D12，todo 49）。
 *
 * 约定与 /api/expiry（todo 45）一致：`new Hono<{Variables:{user:User}}>()` +
 * `use('*', authMiddleware)`，分页返回 `{ success, data, pagination }`。
 * 全部查询按 user_id 限定；「不存在」与「他人的行」都是 404。
 * 消耗不足时返回 400（绝不静默夹到 0）。不做条码扫描。
 */
const inventory = new Hono<{ Variables: { user: User } }>();
inventory.use('*', authMiddleware);

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

inventory.get('/', async (c) => {
  const userId = Number(c.get('user').id);

  const categoryRaw = c.req.query('category');
  if (categoryRaw && !(INVENTORY_CATEGORIES as readonly string[]).includes(categoryRaw)) {
    return c.json({ success: false, error: `未知的库存分类: ${categoryRaw}` }, 400);
  }
  const activeRaw = c.req.query('active');
  let active: boolean | undefined;
  if (activeRaw === 'true') active = true;
  else if (activeRaw === 'false') active = false;
  else if (activeRaw !== undefined && activeRaw !== '') {
    return c.json({ success: false, error: "active 只能为 'true' 或 'false'" }, 400);
  }
  const lowStockRaw = c.req.query('lowStock');
  let lowStock: boolean | undefined;
  if (lowStockRaw === 'true') lowStock = true;
  else if (lowStockRaw === 'false') lowStock = false;
  else if (lowStockRaw !== undefined && lowStockRaw !== '') {
    return c.json({ success: false, error: "lowStock 只能为 'true' 或 'false'" }, 400);
  }

  // 可选档案过滤（checkbox 69）：省略 = 全部档案；他人的档案一律 404。
  const profileFilter = await parseProfileFilter(c, userId);
  if (profileFilter instanceof Response) return profileFilter;

  const filters: InventoryItemFilters = {
    category: categoryRaw,
    active,
    lowStock,
    q: c.req.query('q') || undefined,
    profileId: profileFilter,
  };
  const page = parsePage(c.req.query('page'));
  const limit = parseLimit(c.req.query('limit'));

  const { items, total } = await listInventoryItems(userId, filters, page, limit);
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

inventory.get('/expiring', async (c) => {
  const userId = Number(c.get('user').id);
  const raw = parseInt(c.req.query('days') ?? '', 10);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3650) : 30;
  const items = await listExpiringInventoryItems(userId, days);
  return c.json({ success: true, data: items, days });
});

inventory.get('/low-stock', async (c) => {
  const userId = Number(c.get('user').id);
  const items = await listLowStockInventoryItems(userId);
  return c.json({ success: true, data: items });
});

inventory.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createInventoryItemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }
  const item = await createInventoryItem(userId, parsed.data);
  return c.json({ success: true, data: item }, 201);
});

inventory.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const item = await getInventoryItem(userId, id);
  if (!item) return c.json({ success: false, error: '库存项不存在' }, 404);
  return c.json({ success: true, data: item });
});

inventory.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateInventoryItemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const item = await updateInventoryItem(userId, id, parsed.data);
  if (!item) return c.json({ success: false, error: '库存项不存在' }, 404);
  return c.json({ success: true, data: item });
});

inventory.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const deleted = await deleteInventoryItem(userId, id);
  // 404（而非 403）：他人的行与不存在的行不可区分，避免存在性泄露
  if (!deleted) return c.json({ success: false, error: '库存项不存在' }, 404);
  return c.json({ success: true });
});

inventory.post('/:id/consume', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = consumeInventoryItemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const result = await consumeInventoryItem(userId, id, parsed.data.quantity);
  if (result.status === 'not_found') {
    return c.json({ success: false, error: '库存项不存在' }, 404);
  }
  if (result.status === 'insufficient') {
    // 明确拒绝，绝不静默夹到 0
    return c.json({
      success: false,
      error: `库存不足：当前 ${result.item.quantity}${result.item.unit ?? ''}，无法消耗 ${parsed.data.quantity}`,
      data: result.item,
    }, 400);
  }
  return c.json({ success: true, data: result.item });
});

export default inventory;
