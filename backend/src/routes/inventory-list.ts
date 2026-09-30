import { Hono } from 'hono';
import { z } from 'zod';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  addHouseholdListItem,
  createHouseholdList,
  createHouseholdListShare,
  deleteHouseholdList,
  deleteHouseholdListItem,
  getHouseholdList,
  listHouseholdLists,
  listHouseholdListShares,
  revokeHouseholdListShare,
  setHouseholdListItemChecked,
  updateHouseholdList,
  updateHouseholdListItem,
} from '../services/agent/inventory-list.service.js';

/**
 * Task 158: household collaborative list API, mounted at `/api/inventory-list`
 * (integrator). Separate from the `inventory_items` stock domain.
 *
 *   GET    /api/inventory-list                    lists with item/checked counts
 *   POST   /api/inventory-list                    create a list
 *   GET    /api/inventory-list/:id                one list + its items
 *   PATCH  /api/inventory-list/:id                rename / re-note
 *   DELETE /api/inventory-list/:id                delete list (items + shares cascade)
 *   POST   /api/inventory-list/:id/items          add item (name/quantity/note/assignee)
 *   PATCH  /api/inventory-list/:id/items/:itemId  edit item fields
 *   POST   /api/inventory-list/:id/items/:itemId/check    idempotent check
 *   POST   /api/inventory-list/:id/items/:itemId/uncheck  idempotent uncheck
 *   DELETE /api/inventory-list/:id/items/:itemId  remove item
 *   GET    /api/inventory-list/:id/shares         active share links for the list
 *   POST   /api/inventory-list/:id/shares         mint a share link (raw token once)
 *   DELETE /api/inventory-list/:id/shares/:shareId  revoke a share link
 *
 * Check / uncheck are no-ops when the item is already in the target state: the
 * same item comes back with unchanged checked_at - callers can re-issue safely.
 */
const inventoryList = new Hono<{ Variables: { user: User } }>();
inventoryList.use('*', authMiddleware);

const listCreateSchema = z.object({
  name: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
});

const listUpdateSchema = listCreateSchema.partial();

const itemCreateSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.string().max(40).optional(),
  note: z.string().max(300).optional(),
  assignee: z.string().max(80).optional(),
});

const itemUpdateSchema = itemCreateSchema.partial();

const shareSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  passcode: z.string().max(128).nullable().optional(),
  label: z.string().max(120).nullable().optional(),
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

inventoryList.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const lists = await listHouseholdLists(userId);
  return c.json({ success: true, data: { lists, count: lists.length } });
});

inventoryList.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = listCreateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const name = parsed.data.name.trim();
  if (name === '') return c.json({ success: false, error: '请求参数无效' }, 400);

  const list = await createHouseholdList(userId, { name, note: parsed.data.note });
  return c.json({ success: true, data: list }, 201);
});

inventoryList.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的清单 ID' }, 400);
  const detail = await getHouseholdList(userId, id);
  if (!detail) return c.json({ success: false, error: '清单不存在' }, 404);
  return c.json({ success: true, data: detail });
});

inventoryList.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的清单 ID' }, 400);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = listUpdateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const patch = {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
  };
  if (Object.keys(patch).length === 0) {
    return c.json({ success: false, error: '没有可更新的字段' }, 400);
  }

  const list = await updateHouseholdList(userId, id, patch);
  if (!list) return c.json({ success: false, error: '清单不存在' }, 404);
  return c.json({ success: true, data: list });
});

inventoryList.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的清单 ID' }, 400);
  const removed = await deleteHouseholdList(userId, id);
  if (!removed) return c.json({ success: false, error: '清单不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

inventoryList.post('/:id/items', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的清单 ID' }, 400);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = itemCreateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const name = parsed.data.name.trim();
  if (name === '') return c.json({ success: false, error: '请求参数无效' }, 400);

  const item = await addHouseholdListItem(userId, id, {
    name,
    quantity: parsed.data.quantity,
    note: parsed.data.note,
    assignee: parsed.data.assignee,
  });
  if (!item) return c.json({ success: false, error: '清单不存在' }, 404);
  return c.json({ success: true, data: item }, 201);
});

inventoryList.patch('/:id/items/:itemId', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  const itemId = parseId(c.req.param('itemId'));
  if (id === null || itemId === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = itemUpdateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const patch = {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
    ...(parsed.data.quantity !== undefined ? { quantity: parsed.data.quantity } : {}),
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    ...(parsed.data.assignee !== undefined ? { assignee: parsed.data.assignee } : {}),
  };
  if (Object.keys(patch).length === 0) {
    return c.json({ success: false, error: '没有可更新的字段' }, 400);
  }

  const item = await updateHouseholdListItem(userId, id, itemId, patch);
  if (!item) return c.json({ success: false, error: '条目不存在' }, 404);
  return c.json({ success: true, data: item });
});

for (const action of ['check', 'uncheck'] as const) {
  const checked = action === 'check';
  inventoryList.post(`/:id/items/:itemId/${action}`, async (c) => {
    const userId = Number(c.get('user').id);
    const id = parseId(c.req.param('id'));
    const itemId = parseId(c.req.param('itemId'));
    if (id === null || itemId === null) return c.json({ success: false, error: '无效的 ID' }, 400);
    const item = await setHouseholdListItemChecked(userId, id, itemId, checked);
    if (!item) return c.json({ success: false, error: '条目不存在' }, 404);
    return c.json({ success: true, data: { item } });
  });
}

inventoryList.delete('/:id/items/:itemId', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  const itemId = parseId(c.req.param('itemId'));
  if (id === null || itemId === null) return c.json({ success: false, error: '无效的 ID' }, 400);
  const removed = await deleteHouseholdListItem(userId, id, itemId);
  if (!removed) return c.json({ success: false, error: '条目不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

inventoryList.get('/:id/shares', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的清单 ID' }, 400);
  const detail = await getHouseholdList(userId, id);
  if (!detail) return c.json({ success: false, error: '清单不存在' }, 404);
  const shares = await listHouseholdListShares(userId, id);
  return c.json({ success: true, data: { shares, count: shares.length } });
});

inventoryList.post('/:id/shares', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的清单 ID' }, 400);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = shareSchema.safeParse(raw ?? {});
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const share = await createHouseholdListShare(userId, id, {
    expiresInDays: parsed.data.expiresInDays,
    passcode: parsed.data.passcode,
    label: parsed.data.label,
  });
  if (!share) return c.json({ success: false, error: '清单不存在' }, 404);
  return c.json({ success: true, data: share }, 201);
});

inventoryList.delete('/:id/shares/:shareId', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  const shareId = parseId(c.req.param('shareId'));
  if (id === null || shareId === null) return c.json({ success: false, error: '无效的 ID' }, 400);
  const revoked = await revokeHouseholdListShare(userId, id, shareId);
  if (!revoked) return c.json({ success: false, error: '分享不存在' }, 404);
  return c.json({ success: true, data: { revoked: true } });
});

export default inventoryList;
