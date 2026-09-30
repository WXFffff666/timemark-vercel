import { Hono } from 'hono';
import { z } from 'zod';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  createParcel,
  deleteParcel,
  getParcel,
  listParcelReminders,
  listParcels,
  refreshParcel,
  updateParcel,
  ParcelConflictError,
  PARCEL_STATUSES,
} from '../services/agent/parcel.service.js';

/**
 * Task 152: parcel / logistics API, mounted at `/api/parcels` (integrator).
 *
 *   GET    /api/parcels              list tracked parcels (tracking numbers masked for display)
 *   GET    /api/parcels/reminders    due reminders: out for delivery / stalled
 *   POST   /api/parcels              start tracking a parcel
 *   GET    /api/parcels/:id          one parcel
 *   PATCH  /api/parcels/:id          manual status / label / ETA / last-event update
 *   DELETE /api/parcels/:id          stop tracking
 *   POST   /api/parcels/:id/refresh  optional carrier poll (CarrierAdapter seam; may be unsupported)
 *
 * Tracking numbers are secrets: logs only ever carry the masked form.
 */
const parcels = new Hono<{ Variables: { user: User } }>();
parcels.use('*', authMiddleware);

const ETA_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const createSchema = z.object({
  carrier: z.string().min(1).max(64),
  trackingNumber: z.string().min(1).max(128),
  label: z.string().max(80).optional(),
  eta: z.string().regex(ETA_PATTERN).optional(),
  lastEvent: z.string().max(200).optional(),
});

const updateSchema = z.object({
  status: z.enum(PARCEL_STATUSES).optional(),
  label: z.string().max(80).optional(),
  eta: z.string().regex(ETA_PATTERN).nullable().optional(),
  lastEvent: z.string().max(200).optional(),
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

parcels.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const items = await listParcels(userId);
  return c.json({ success: true, data: { parcels: items, count: items.length } });
});

// Registered before `/:id` so the literal path wins.
parcels.get('/reminders', async (c) => {
  const userId = Number(c.get('user').id);
  const reminders = await listParcelReminders(userId);
  return c.json({ success: true, data: { reminders, count: reminders.length } });
});

parcels.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ success: false, error: '请求参数无效' }, 400);
  }
  const carrier = parsed.data.carrier.trim();
  const trackingNumber = parsed.data.trackingNumber.trim();
  if (carrier === '' || trackingNumber === '') {
    return c.json({ success: false, error: '请求参数无效' }, 400);
  }
  const input = {
    carrier,
    trackingNumber,
    label: (parsed.data.label ?? '').trim(),
    ...(parsed.data.eta !== undefined ? { eta: parsed.data.eta } : {}),
    ...(parsed.data.lastEvent !== undefined ? { lastEvent: parsed.data.lastEvent.trim() } : {}),
  };
  try {
    const parcel = await createParcel(userId, input);
    return c.json({ success: true, data: parcel }, 201);
  } catch (error) {
    if (error instanceof ParcelConflictError) {
      return c.json({ success: false, error: '该包裹已在跟踪中' }, 409);
    }
    throw error;
  }
});

parcels.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的包裹 ID' }, 400);
  const parcel = await getParcel(userId, id);
  if (!parcel) return c.json({ success: false, error: '包裹不存在' }, 404);
  return c.json({ success: true, data: parcel });
});

parcels.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的包裹 ID' }, 400);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ success: false, error: '请求参数无效' }, 400);
  }
  const patch = {
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.label !== undefined ? { label: parsed.data.label.trim() } : {}),
    ...(parsed.data.eta !== undefined ? { eta: parsed.data.eta } : {}),
    ...(parsed.data.lastEvent !== undefined ? { lastEvent: parsed.data.lastEvent.trim() } : {}),
  };
  if (Object.keys(patch).length === 0) {
    return c.json({ success: false, error: '没有可更新的字段' }, 400);
  }

  const parcel = await updateParcel(userId, id, patch);
  if (!parcel) return c.json({ success: false, error: '包裹不存在' }, 404);
  return c.json({ success: true, data: parcel });
});

parcels.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的包裹 ID' }, 400);
  const removed = await deleteParcel(userId, id);
  if (!removed) return c.json({ success: false, error: '包裹不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

parcels.post('/:id/refresh', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的包裹 ID' }, 400);
  const result = await refreshParcel(userId, id);
  if (!result.updated && result.reason === 'not_found') {
    return c.json({ success: false, error: '包裹不存在' }, 404);
  }
  return c.json({ success: true, data: result });
});

export default parcels;
