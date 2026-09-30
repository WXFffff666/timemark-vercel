import { Hono } from 'hono';
import { z } from 'zod';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  createFuelRecord,
  createMaintenanceRecord,
  createVehicle,
  deleteFuelRecord,
  deleteMaintenanceRecord,
  deleteVehicle,
  getFuelLedger,
  getMaintenanceLedger,
  getVehicle,
  listVehicleDueReminders,
  listVehicles,
  updateVehicle,
} from '../services/agent/vehicle.service.js';

/**
 * Task 156: vehicle fuel & maintenance API, mounted at `/api/vehicles` (integrator).
 *
 *   GET    /api/vehicles                     list vehicles
 *   GET    /api/vehicles/reminders           computed maintenance due/overdue reminders
 *   POST   /api/vehicles                     create a vehicle profile
 *   GET    /api/vehicles/:id                 one vehicle
 *   PATCH  /api/vehicles/:id                 update profile / odometer
 *   DELETE /api/vehicles/:id                 remove vehicle (fuel + maintenance cascade)
 *   GET    /api/vehicles/:id/fuel            fuel ledger + consumption / cost-per-km summary
 *   POST   /api/vehicles/:id/fuel            add a fuel / kWh record
 *   DELETE /api/vehicles/:id/fuel/:recordId  remove a fuel record
 *   GET    /api/vehicles/:id/maintenance     maintenance ledger with due status
 *   POST   /api/vehicles/:id/maintenance     add a maintenance record
 *   DELETE /api/vehicles/:id/maintenance/:recordId
 *
 * Plates are stored verbatim but the service only ever logs the masked form.
 */
const vehicles = new Hono<{ Variables: { user: User } }>();
vehicles.use('*', authMiddleware);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ODOMETER = 100_000_000;

const vehicleCreateSchema = z.object({
  make: z.string().min(1).max(64),
  model: z.string().max(64).optional(),
  year: z.number().int().min(1886).max(2100).nullable().optional(),
  plate: z.string().max(32).optional(),
  odometer: z.number().int().min(0).max(MAX_ODOMETER).optional(),
});

const vehicleUpdateSchema = vehicleCreateSchema.partial();

const fuelSchema = z.object({
  date: z.string().regex(DATE_PATTERN),
  energyType: z.enum(['fuel', 'electric']).optional(),
  quantity: z.number().positive().max(100_000),
  unitPrice: z.number().min(0).max(1_000_000).optional(),
  totalCost: z.number().min(0).max(100_000_000).optional(),
  odometer: z.number().int().min(0).max(MAX_ODOMETER),
  note: z.string().max(300).optional(),
});

const maintenanceSchema = z.object({
  item: z.string().min(1).max(120),
  date: z.string().regex(DATE_PATTERN),
  odometer: z.number().int().min(0).max(MAX_ODOMETER).nullable().optional(),
  cost: z.number().min(0).max(100_000_000).optional(),
  nextDueDate: z.string().regex(DATE_PATTERN).nullable().optional(),
  nextDueOdometer: z.number().int().min(0).max(MAX_ODOMETER).nullable().optional(),
  note: z.string().max(300).optional(),
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

vehicles.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const items = await listVehicles(userId);
  return c.json({ success: true, data: { vehicles: items, count: items.length } });
});

// Registered before `/:id` so the literal path wins.
vehicles.get('/reminders', async (c) => {
  const userId = Number(c.get('user').id);
  const reminders = await listVehicleDueReminders(userId);
  return c.json({ success: true, data: { reminders, count: reminders.length } });
});

vehicles.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = vehicleCreateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const make = parsed.data.make.trim();
  if (make === '') return c.json({ success: false, error: '请求参数无效' }, 400);

  const vehicle = await createVehicle(userId, {
    make,
    model: (parsed.data.model ?? '').trim(),
    year: parsed.data.year ?? null,
    plate: (parsed.data.plate ?? '').trim(),
    odometer: parsed.data.odometer ?? 0,
  });
  return c.json({ success: true, data: vehicle }, 201);
});

vehicles.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的车辆 ID' }, 400);
  const vehicle = await getVehicle(userId, id);
  if (!vehicle) return c.json({ success: false, error: '车辆不存在' }, 404);
  return c.json({ success: true, data: vehicle });
});

vehicles.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的车辆 ID' }, 400);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = vehicleUpdateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const patch = {
    ...(parsed.data.make !== undefined ? { make: parsed.data.make.trim() } : {}),
    ...(parsed.data.model !== undefined ? { model: parsed.data.model.trim() } : {}),
    ...(parsed.data.year !== undefined ? { year: parsed.data.year } : {}),
    ...(parsed.data.plate !== undefined ? { plate: parsed.data.plate.trim() } : {}),
    ...(parsed.data.odometer !== undefined ? { odometer: parsed.data.odometer } : {}),
  };
  if (Object.keys(patch).length === 0) {
    return c.json({ success: false, error: '没有可更新的字段' }, 400);
  }

  const vehicle = await updateVehicle(userId, id, patch);
  if (!vehicle) return c.json({ success: false, error: '车辆不存在' }, 404);
  return c.json({ success: true, data: vehicle });
});

vehicles.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的车辆 ID' }, 400);
  const removed = await deleteVehicle(userId, id);
  if (!removed) return c.json({ success: false, error: '车辆不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

vehicles.get('/:id/fuel', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的车辆 ID' }, 400);
  const ledger = await getFuelLedger(userId, id);
  if (!ledger) return c.json({ success: false, error: '车辆不存在' }, 404);
  return c.json({ success: true, data: ledger });
});

vehicles.post('/:id/fuel', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的车辆 ID' }, 400);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = fuelSchema.safeParse(raw);
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const record = await createFuelRecord(userId, id, {
    date: parsed.data.date,
    energyType: parsed.data.energyType,
    quantity: parsed.data.quantity,
    unitPrice: parsed.data.unitPrice,
    totalCost: parsed.data.totalCost,
    odometer: parsed.data.odometer,
    note: parsed.data.note,
  });
  if (!record) return c.json({ success: false, error: '车辆不存在' }, 404);
  return c.json({ success: true, data: record }, 201);
});

vehicles.delete('/:id/fuel/:recordId', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  const recordId = parseId(c.req.param('recordId'));
  if (id === null || recordId === null) return c.json({ success: false, error: '无效的 ID' }, 400);
  const removed = await deleteFuelRecord(userId, id, recordId);
  if (!removed) return c.json({ success: false, error: '记录不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

vehicles.get('/:id/maintenance', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的车辆 ID' }, 400);
  const ledger = await getMaintenanceLedger(userId, id);
  if (!ledger) return c.json({ success: false, error: '车辆不存在' }, 404);
  return c.json({ success: true, data: ledger });
});

vehicles.post('/:id/maintenance', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的车辆 ID' }, 400);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = maintenanceSchema.safeParse(raw);
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const record = await createMaintenanceRecord(userId, id, {
    item: parsed.data.item.trim(),
    date: parsed.data.date,
    odometer: parsed.data.odometer,
    cost: parsed.data.cost,
    nextDueDate: parsed.data.nextDueDate,
    nextDueOdometer: parsed.data.nextDueOdometer,
    note: parsed.data.note,
  });
  if (!record) return c.json({ success: false, error: '车辆不存在' }, 404);
  return c.json({ success: true, data: record }, 201);
});

vehicles.delete('/:id/maintenance/:recordId', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  const recordId = parseId(c.req.param('recordId'));
  if (id === null || recordId === null) return c.json({ success: false, error: '无效的 ID' }, 400);
  const removed = await deleteMaintenanceRecord(userId, id, recordId);
  if (!removed) return c.json({ success: false, error: '记录不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

export default vehicles;
