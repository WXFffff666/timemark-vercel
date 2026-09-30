import { Hono } from 'hono';
import { z } from 'zod';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { isValidIanaTimezone } from '../utils/timezone.js';
import { getUserTimezone } from '../services/agent/routines/routine.js';
import { isValidYmd } from '../services/agent/local-day.js';
import {
  DEFAULT_PET_REMINDER_WINDOW_DAYS,
  PET_LIST_LIMIT,
  PET_LOG_KINDS,
  PET_SCHEDULE_KINDS,
  completePetSchedule,
  createPet,
  createPetLog,
  createPetSchedule,
  deletePet,
  deletePetLog,
  deletePetSchedule,
  getPet,
  getPetSchedule,
  getPetWeightHistory,
  listPetLogs,
  listPetReminders,
  listPets,
  listPetSchedules,
  updatePet,
  updatePetSchedule,
} from '../services/agent/pet.service.js';

/**
 * Task 155: pet care API, mounted at `/api/pets` (integrator).
 *
 *   GET    /api/pets                              pet profiles (age + latest weight)
 *   POST   /api/pets                              create a pet
 *   GET    /api/pets/reminders                    due vaccination/deworming reminders (?days=)
 *   GET    /api/pets/:id                          one pet
 *   PATCH  /api/pets/:id                          edit a pet
 *   DELETE /api/pets/:id                          delete (cascades logs/schedules)
 *   GET    /api/pets/:id/logs                     weight/feeding/vet history (?kind/?from/?to)
 *   POST   /api/pets/:id/logs                     record a weight/feeding/vet entry
 *   GET    /api/pets/:id/weight                   weight history + trend
 *   GET    /api/pets/:id/schedules                vaccination/deworming schedule
 *   POST   /api/pets/:id/schedules                add a schedule entry
 *   GET    /api/pets/schedules/:id                one schedule entry
 *   PATCH  /api/pets/schedules/:id                edit / reopen a schedule entry
 *   POST   /api/pets/schedules/:id/complete       complete (recurring rolls due_date forward)
 *   DELETE /api/pets/schedules/:id
 *   DELETE /api/pets/logs/:id
 *
 * Literal-prefix routes are registered before `/:id` so they win. `?timezone=`
 * overrides the user's configured IANA timezone for reminder windows.
 */
const pets = new Hono<{ Variables: { user: User } }>();
pets.use('*', authMiddleware);

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const petSchema = z.object({
  name: z.string().min(1).max(80),
  species: z.string().max(40).optional(),
  breed: z.string().max(80).optional(),
  birthDate: ymd.nullable().optional(),
  weightKg: z.number().nullable().optional(),
  notes: z.string().max(1000).optional(),
});
const petPatchSchema = petSchema.partial();
const petLogSchema = z.object({
  kind: z.enum(PET_LOG_KINDS),
  loggedAt: z.string().min(1).max(64).optional(),
  weightKg: z.number().nullable().optional(),
  detail: z.string().max(1000).optional(),
});
const scheduleSchema = z.object({
  kind: z.enum(PET_SCHEDULE_KINDS),
  name: z.string().min(1).max(120),
  dueDate: ymd,
  intervalDays: z.number().int().positive().nullable().optional(),
  reminderDaysBefore: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(1000).optional(),
});
const schedulePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  dueDate: ymd.optional(),
  intervalDays: z.number().int().positive().nullable().optional(),
  reminderDaysBefore: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(1000).optional(),
  completed: z.boolean().optional(),
});
const completeSchema = z.object({
  at: z.string().min(1).max(64).optional(),
  nextDueDate: ymd.optional(),
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function resolveTimezone(raw: string | undefined, userId: number): Promise<string> {
  if (raw && isValidIanaTimezone(raw)) return raw;
  return getUserTimezone(userId);
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? Math.min(value, PET_LIST_LIMIT) : undefined;
}

/* Static-prefix routes first (registration order wins in this router). */

pets.get('/reminders', async (c) => {
  const userId = Number(c.get('user').id);
  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const daysRaw = c.req.query('days');
  let days: number | undefined;
  if (daysRaw !== undefined && daysRaw !== '') {
    const value = Number(daysRaw);
    if (!Number.isInteger(value) || value < 0 || value > 366) {
      return c.json({ success: false, error: 'days 必须为 0-366 的整数' }, 400);
    }
    days = value;
  }
  const reminders = await listPetReminders(userId, {
    timezone,
    ...(days !== undefined ? { days } : {}),
  });
  return c.json({
    success: true,
    data: { reminders, count: reminders.length, days: days ?? DEFAULT_PET_REMINDER_WINDOW_DAYS, timezone },
  });
});

pets.get('/schedules/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的日程 ID' }, 400);
  const schedule = await getPetSchedule(userId, id);
  if (!schedule) return c.json({ success: false, error: '疫苗/驱虫日程不存在' }, 404);
  return c.json({ success: true, data: schedule });
});

pets.patch('/schedules/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的日程 ID' }, 400);

  const parsed = schedulePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await updatePetSchedule(userId, id, {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.dueDate !== undefined ? { dueDate: parsed.data.dueDate } : {}),
    ...(parsed.data.intervalDays !== undefined ? { intervalDays: parsed.data.intervalDays } : {}),
    ...(parsed.data.reminderDaysBefore !== undefined
      ? { reminderDaysBefore: parsed.data.reminderDaysBefore }
      : {}),
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    ...(parsed.data.completed !== undefined ? { completed: parsed.data.completed } : {}),
  });
  switch (result.status) {
    case 'ok':
      return c.json({ success: true, data: result.data });
    case 'not_found':
      return c.json({ success: false, error: '疫苗/驱虫日程不存在' }, 404);
    case 'invalid':
      return c.json({ success: false, error: '请求参数无效' }, 400);
  }
});

pets.post('/schedules/:id/complete', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的日程 ID' }, 400);

  const parsed = completeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await completePetSchedule(userId, id, {
    ...(parsed.data.at !== undefined ? { at: parsed.data.at } : {}),
    ...(parsed.data.nextDueDate !== undefined ? { nextDueDate: parsed.data.nextDueDate } : {}),
  });
  switch (result.status) {
    case 'ok':
      return c.json({ success: true, data: result.data });
    case 'not_found':
      return c.json({ success: false, error: '疫苗/驱虫日程不存在' }, 404);
    case 'invalid':
      return c.json({ success: false, error: '请求参数无效' }, 400);
  }
});

pets.delete('/schedules/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的日程 ID' }, 400);
  const removed = await deletePetSchedule(userId, id);
  if (!removed) return c.json({ success: false, error: '疫苗/驱虫日程不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

pets.delete('/logs/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的记录 ID' }, 400);
  const removed = await deletePetLog(userId, id);
  if (!removed) return c.json({ success: false, error: '宠物记录不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

/* Collection + per-pet routes. */

pets.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const items = await listPets(userId, { timezone });
  return c.json({ success: true, data: { pets: items, count: items.length, timezone } });
});

pets.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const parsed = petSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await createPet(userId, {
    name: parsed.data.name,
    ...(parsed.data.species !== undefined ? { species: parsed.data.species } : {}),
    ...(parsed.data.breed !== undefined ? { breed: parsed.data.breed } : {}),
    ...(parsed.data.birthDate !== undefined ? { birthDate: parsed.data.birthDate } : {}),
    ...(parsed.data.weightKg !== undefined ? { weightKg: parsed.data.weightKg } : {}),
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
  });
  if (result.status !== 'ok') return c.json({ success: false, error: '请求参数无效' }, 400);
  return c.json({ success: true, data: result.data }, 201);
});

pets.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的宠物 ID' }, 400);
  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const pet = await getPet(userId, id, { timezone });
  if (!pet) return c.json({ success: false, error: '宠物不存在' }, 404);
  return c.json({ success: true, data: pet });
});

pets.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的宠物 ID' }, 400);

  const parsed = petPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await updatePet(userId, id, {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.species !== undefined ? { species: parsed.data.species } : {}),
    ...(parsed.data.breed !== undefined ? { breed: parsed.data.breed } : {}),
    ...(parsed.data.birthDate !== undefined ? { birthDate: parsed.data.birthDate } : {}),
    ...(parsed.data.weightKg !== undefined ? { weightKg: parsed.data.weightKg } : {}),
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
  });
  switch (result.status) {
    case 'ok':
      return c.json({ success: true, data: result.data });
    case 'not_found':
      return c.json({ success: false, error: '宠物不存在' }, 404);
    case 'invalid':
      return c.json({ success: false, error: '请求参数无效' }, 400);
  }
});

pets.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的宠物 ID' }, 400);
  const removed = await deletePet(userId, id);
  if (!removed) return c.json({ success: false, error: '宠物不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

pets.get('/:id/logs', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的宠物 ID' }, 400);
  const pet = await getPet(userId, id);
  if (!pet) return c.json({ success: false, error: '宠物不存在' }, 404);

  const kindRaw = c.req.query('kind');
  if (kindRaw && !(PET_LOG_KINDS as readonly string[]).includes(kindRaw)) {
    return c.json({ success: false, error: `未知的宠物记录类型: ${kindRaw}` }, 400);
  }
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from && !isValidYmd(from)) return c.json({ success: false, error: 'from 必须为 YYYY-MM-DD' }, 400);
  if (to && !isValidYmd(to)) return c.json({ success: false, error: 'to 必须为 YYYY-MM-DD' }, 400);

  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const logs = await listPetLogs(userId, id, {
    ...(kindRaw ? { kind: kindRaw as (typeof PET_LOG_KINDS)[number] } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(parseLimit(c.req.query('limit')) !== undefined
      ? { limit: parseLimit(c.req.query('limit')) }
      : {}),
    timezone,
  });
  return c.json({ success: true, data: { logs, count: logs.length, timezone } });
});

pets.post('/:id/logs', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的宠物 ID' }, 400);

  const parsed = petLogSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await createPetLog(userId, id, {
    kind: parsed.data.kind,
    ...(parsed.data.loggedAt !== undefined ? { loggedAt: parsed.data.loggedAt } : {}),
    ...(parsed.data.weightKg !== undefined ? { weightKg: parsed.data.weightKg } : {}),
    ...(parsed.data.detail !== undefined ? { detail: parsed.data.detail } : {}),
  });
  switch (result.status) {
    case 'ok':
      return c.json({ success: true, data: result.data }, 201);
    case 'not_found':
      return c.json({ success: false, error: '宠物不存在' }, 404);
    case 'invalid':
      return c.json({ success: false, error: '请求参数无效' }, 400);
  }
});

pets.get('/:id/weight', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的宠物 ID' }, 400);
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from && !isValidYmd(from)) return c.json({ success: false, error: 'from 必须为 YYYY-MM-DD' }, 400);
  if (to && !isValidYmd(to)) return c.json({ success: false, error: 'to 必须为 YYYY-MM-DD' }, 400);

  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const result = await getPetWeightHistory(userId, id, {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    timezone,
  });
  if (result.status === 'not_found') return c.json({ success: false, error: '宠物不存在' }, 404);
  if (result.status !== 'ok') return c.json({ success: false, error: '请求参数无效' }, 400);
  return c.json({ success: true, data: result.data });
});

pets.get('/:id/schedules', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的宠物 ID' }, 400);
  const pet = await getPet(userId, id);
  if (!pet) return c.json({ success: false, error: '宠物不存在' }, 404);
  const schedules = await listPetSchedules(userId, id);
  return c.json({ success: true, data: { schedules, count: schedules.length } });
});

pets.post('/:id/schedules', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的宠物 ID' }, 400);

  const parsed = scheduleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await createPetSchedule(userId, id, {
    kind: parsed.data.kind,
    name: parsed.data.name,
    dueDate: parsed.data.dueDate,
    ...(parsed.data.intervalDays !== undefined ? { intervalDays: parsed.data.intervalDays } : {}),
    ...(parsed.data.reminderDaysBefore !== undefined
      ? { reminderDaysBefore: parsed.data.reminderDaysBefore }
      : {}),
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
  });
  switch (result.status) {
    case 'ok':
      return c.json({ success: true, data: result.data }, 201);
    case 'not_found':
      return c.json({ success: false, error: '宠物不存在' }, 404);
    case 'invalid':
      return c.json({ success: false, error: '请求参数无效' }, 400);
  }
});

export default pets;
