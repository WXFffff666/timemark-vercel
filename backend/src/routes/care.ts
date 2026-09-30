import { Hono } from 'hono';
import { z } from 'zod';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { isValidIanaTimezone } from '../utils/timezone.js';
import { getUserTimezone } from '../services/agent/routines/routine.js';
import { isValidYmd, localDateIn } from '../services/agent/local-day.js';
import {
  CARE_LIST_LIMIT,
  CARE_LOG_KINDS,
  createCareLog,
  createCareProfile,
  deleteCareLog,
  deleteCareProfile,
  getCareDailyLog,
  getCareMeasurementTrend,
  getCareProfile,
  listCareLogs,
  listCareProfiles,
  updateCareLog,
  updateCareProfile,
} from '../services/agent/care.service.js';

/**
 * Task 154: child / elder care API, mounted at `/api/care` (integrator).
 *
 *   GET    /api/care/profiles                     care recipients
 *   POST   /api/care/profiles                     create a profile
 *   GET    /api/care/profiles/:id                 one profile
 *   PATCH  /api/care/profiles/:id                 edit a profile
 *   DELETE /api/care/profiles/:id                 delete (cascades the logs)
 *   GET    /api/care/profiles/:id/logs            care events (?kind/?from/?to)
 *   POST   /api/care/profiles/:id/logs            record feeding/dose/vitals/mood/incident
 *   GET    /api/care/profiles/:id/trend           numeric measurement history + trend
 *   GET    /api/care/profiles/:id/daily-log       printable day log (?date=&format=text)
 *   PATCH  /api/care/logs/:id                     edit an event
 *   DELETE /api/care/logs/:id                     delete an event
 *
 * Events live in `care_logs` (never the medications domain). `?timezone=`
 * overrides the user's configured IANA timezone for day boundaries.
 */
const care = new Hono<{ Variables: { user: User } }>();
care.use('*', authMiddleware);

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const profileSchema = z.object({
  name: z.string().min(1).max(80),
  relationship: z.string().max(40).optional(),
  dateOfBirth: ymd.nullable().optional(),
  allergies: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});
const profilePatchSchema = profileSchema.partial();
const logSchema = z.object({
  kind: z.enum(CARE_LOG_KINDS),
  loggedAt: z.string().min(1).max(64).optional(),
  label: z.string().max(120).optional(),
  value: z.number().nullable().optional(),
  unit: z.string().max(32).optional(),
  detail: z.string().max(1000).optional(),
});
const logPatchSchema = logSchema.partial();

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
  return Number.isInteger(value) && value > 0 ? Math.min(value, CARE_LIST_LIMIT) : undefined;
}

care.get('/profiles', async (c) => {
  const userId = Number(c.get('user').id);
  const profiles = await listCareProfiles(userId);
  return c.json({ success: true, data: { profiles, count: profiles.length } });
});

care.post('/profiles', async (c) => {
  const userId = Number(c.get('user').id);
  const parsed = profileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await createCareProfile(userId, {
    name: parsed.data.name,
    ...(parsed.data.relationship !== undefined ? { relationship: parsed.data.relationship } : {}),
    ...(parsed.data.dateOfBirth !== undefined ? { dateOfBirth: parsed.data.dateOfBirth } : {}),
    ...(parsed.data.allergies !== undefined ? { allergies: parsed.data.allergies } : {}),
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
  });
  if (result.status !== 'ok') return c.json({ success: false, error: '请求参数无效' }, 400);
  return c.json({ success: true, data: result.data }, 201);
});

care.get('/profiles/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的档案 ID' }, 400);
  const profile = await getCareProfile(userId, id);
  if (!profile) return c.json({ success: false, error: '照护档案不存在' }, 404);
  return c.json({ success: true, data: profile });
});

care.patch('/profiles/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的档案 ID' }, 400);

  const parsed = profilePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await updateCareProfile(userId, id, {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.relationship !== undefined ? { relationship: parsed.data.relationship } : {}),
    ...(parsed.data.dateOfBirth !== undefined ? { dateOfBirth: parsed.data.dateOfBirth } : {}),
    ...(parsed.data.allergies !== undefined ? { allergies: parsed.data.allergies } : {}),
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
  });
  switch (result.status) {
    case 'ok':
      return c.json({ success: true, data: result.data });
    case 'not_found':
      return c.json({ success: false, error: '照护档案不存在' }, 404);
    case 'invalid':
      return c.json({ success: false, error: '请求参数无效' }, 400);
  }
});

care.delete('/profiles/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的档案 ID' }, 400);
  const removed = await deleteCareProfile(userId, id);
  if (!removed) return c.json({ success: false, error: '照护档案不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

care.get('/profiles/:id/logs', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的档案 ID' }, 400);
  const profile = await getCareProfile(userId, id);
  if (!profile) return c.json({ success: false, error: '照护档案不存在' }, 404);

  const kindRaw = c.req.query('kind');
  if (kindRaw && !(CARE_LOG_KINDS as readonly string[]).includes(kindRaw)) {
    return c.json({ success: false, error: `未知的照护类型: ${kindRaw}` }, 400);
  }
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from && !isValidYmd(from)) return c.json({ success: false, error: 'from 必须为 YYYY-MM-DD' }, 400);
  if (to && !isValidYmd(to)) return c.json({ success: false, error: 'to 必须为 YYYY-MM-DD' }, 400);

  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const events = await listCareLogs(userId, id, {
    ...(kindRaw ? { kind: kindRaw as (typeof CARE_LOG_KINDS)[number] } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(parseLimit(c.req.query('limit')) !== undefined
      ? { limit: parseLimit(c.req.query('limit')) }
      : {}),
    timezone,
  });
  return c.json({ success: true, data: { events, count: events.length, timezone } });
});

care.post('/profiles/:id/logs', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的档案 ID' }, 400);

  const parsed = logSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await createCareLog(userId, id, {
    kind: parsed.data.kind,
    ...(parsed.data.loggedAt !== undefined ? { loggedAt: parsed.data.loggedAt } : {}),
    ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
    ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}),
    ...(parsed.data.unit !== undefined ? { unit: parsed.data.unit } : {}),
    ...(parsed.data.detail !== undefined ? { detail: parsed.data.detail } : {}),
  });
  switch (result.status) {
    case 'ok':
      return c.json({ success: true, data: result.data }, 201);
    case 'not_found':
      return c.json({ success: false, error: '照护档案不存在' }, 404);
    case 'invalid':
      return c.json({ success: false, error: '请求参数无效' }, 400);
  }
});

care.get('/profiles/:id/trend', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的档案 ID' }, 400);
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from && !isValidYmd(from)) return c.json({ success: false, error: 'from 必须为 YYYY-MM-DD' }, 400);
  if (to && !isValidYmd(to)) return c.json({ success: false, error: 'to 必须为 YYYY-MM-DD' }, 400);

  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const result = await getCareMeasurementTrend(userId, id, {
    ...(c.req.query('label') ? { label: c.req.query('label') } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    timezone,
  });
  if (result.status === 'not_found') return c.json({ success: false, error: '照护档案不存在' }, 404);
  if (result.status !== 'ok') return c.json({ success: false, error: '请求参数无效' }, 400);
  return c.json({ success: true, data: result.data });
});

care.get('/profiles/:id/daily-log', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的档案 ID' }, 400);

  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const date = c.req.query('date') ?? localDateIn(new Date(), timezone);
  if (!isValidYmd(date)) return c.json({ success: false, error: 'date 必须为 YYYY-MM-DD' }, 400);

  const dailyLog = await getCareDailyLog(userId, id, date, { timezone });
  if (!dailyLog) return c.json({ success: false, error: '照护档案不存在' }, 404);
  if (c.req.query('format') === 'text') {
    return c.text(dailyLog.text, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  return c.json({ success: true, data: dailyLog });
});

care.patch('/logs/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的记录 ID' }, 400);

  const parsed = logPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await updateCareLog(userId, id, {
    ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
    ...(parsed.data.loggedAt !== undefined ? { loggedAt: parsed.data.loggedAt } : {}),
    ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
    ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}),
    ...(parsed.data.unit !== undefined ? { unit: parsed.data.unit } : {}),
    ...(parsed.data.detail !== undefined ? { detail: parsed.data.detail } : {}),
  });
  switch (result.status) {
    case 'ok':
      return c.json({ success: true, data: result.data });
    case 'not_found':
      return c.json({ success: false, error: '照护记录不存在' }, 404);
    case 'invalid':
      return c.json({ success: false, error: '请求参数无效' }, 400);
  }
});

care.delete('/logs/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的记录 ID' }, 400);
  const removed = await deleteCareLog(userId, id);
  if (!removed) return c.json({ success: false, error: '照护记录不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

export default care;
