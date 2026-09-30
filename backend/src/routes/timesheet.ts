import { Hono } from 'hono';
import { z } from 'zod';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { isValidIanaTimezone } from '../utils/timezone.js';
import { getUserTimezone } from '../services/agent/routines/routine.js';
import {
  isValidYmd,
  localDateIn,
  startOfWeekYmd,
  ymdDiffDays,
} from '../services/agent/local-day.js';
import {
  DEFAULT_OVERTIME_THRESHOLD_MINUTES,
  TIMESHEET_LEAVE_KINDS,
  TIMESHEET_MAX_RANGE_DAYS,
  TimesheetConflictError,
  TimesheetValidationError,
  clockIn,
  clockOut,
  createLeave,
  deleteLeave,
  deleteSession,
  getOvertimeView,
  getSession,
  getTimesheetSummary,
  listLeaves,
  listSessions,
  updateSession,
} from '../services/agent/timesheet.service.js';

/**
 * Task 153: attendance / timesheet API, mounted at `/api/timesheet` (integrator).
 *
 *   GET    /api/timesheet/sessions            sessions overlapping ?from/?to (YYYY-MM-DD)
 *   POST   /api/timesheet/sessions/clock-in   start a session; 409 when one is open
 *   POST   /api/timesheet/sessions/clock-out  close the open session (or ?sessionId)
 *   GET    /api/timesheet/sessions/:id        one session
 *   PATCH  /api/timesheet/sessions/:id        edit timestamps / note / location
 *   DELETE /api/timesheet/sessions/:id        delete a session
 *   GET    /api/timesheet/summary?from=&to=   per-day + per-week totals, overtime, leaves
 *   GET    /api/timesheet/overtime?from=&to=&threshold=
 *   GET    /api/timesheet/leaves              absence / leave records
 *   POST   /api/timesheet/leaves              record an absence / leave
 *   DELETE /api/timesheet/leaves/:id
 *
 * Overnight sessions are split at local midnight across the two days in every
 * total. `?timezone=` overrides the user's configured IANA timezone.
 */
const timesheet = new Hono<{ Variables: { user: User } }>();
timesheet.use('*', authMiddleware);

const timestamp = z.string().min(1).max(64);
const createSessionSchema = z.object({
  at: timestamp.optional(),
  note: z.string().max(500).optional(),
  location: z.string().max(120).optional(),
});
const clockOutSchema = z.object({
  at: timestamp.optional(),
  note: z.string().max(500).optional(),
  sessionId: z.number().int().positive().optional(),
});
const patchSessionSchema = z.object({
  clockIn: timestamp.optional(),
  clockOut: timestamp.nullable().optional(),
  note: z.string().max(500).optional(),
  location: z.string().max(120).optional(),
});
const leaveSchema = z.object({
  kind: z.enum(TIMESHEET_LEAVE_KINDS).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(500).optional(),
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function resolveTimezone(raw: string | undefined, userId: number): Promise<string> {
  if (raw && isValidIanaTimezone(raw)) return raw;
  return getUserTimezone(userId);
}

function parseThreshold(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1440) return null;
  return value;
}

timesheet.get('/sessions', async (c) => {
  const userId = Number(c.get('user').id);
  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from && !isValidYmd(from)) return c.json({ success: false, error: 'from 必须为 YYYY-MM-DD' }, 400);
  if (to && !isValidYmd(to)) return c.json({ success: false, error: 'to 必须为 YYYY-MM-DD' }, 400);

  const sessions = await listSessions(
    userId,
    { ...(from ? { from } : {}), ...(to ? { to } : {}) },
    timezone,
  );
  return c.json({
    success: true,
    data: {
      sessions,
      count: sessions.length,
      openSession: sessions.find((session) => session.open) ?? null,
      timezone,
    },
  });
});

// Registered before `/:id` so the literal path wins.
timesheet.post('/sessions/clock-in', async (c) => {
  const userId = Number(c.get('user').id);
  const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  try {
    const session = await clockIn(userId, {
      ...(parsed.data.at !== undefined ? { at: parsed.data.at } : {}),
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      ...(parsed.data.location !== undefined ? { location: parsed.data.location } : {}),
    });
    return c.json({ success: true, data: session }, 201);
  } catch (error) {
    if (error instanceof TimesheetConflictError) {
      return c.json(
        {
          success: false,
          error: '已有进行中的签到，请先签退',
          code: 'open_session_exists',
          data: { openSession: error.openSession },
        },
        409,
      );
    }
    if (error instanceof TimesheetValidationError) {
      return c.json({ success: false, error: '签到时间无效' }, 400);
    }
    throw error;
  }
});

timesheet.post('/sessions/clock-out', async (c) => {
  const userId = Number(c.get('user').id);
  const parsed = clockOutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await clockOut(userId, {
    ...(parsed.data.at !== undefined ? { at: parsed.data.at } : {}),
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    ...(parsed.data.sessionId !== undefined ? { sessionId: parsed.data.sessionId } : {}),
  });
  switch (result.status) {
    case 'ok':
      return c.json({ success: true, data: result.session });
    case 'not_found':
      return c.json({ success: false, error: '打卡记录不存在' }, 404);
    case 'no_open_session':
      return c.json({ success: false, error: '没有进行中的签到', code: 'no_open_session' }, 409);
    case 'already_closed':
      return c.json(
        { success: false, error: '该打卡已签退', code: 'already_closed', data: { session: result.session } },
        409,
      );
    case 'invalid':
      return c.json({ success: false, error: '签退时间无效或早于签到时间' }, 400);
  }
});

timesheet.get('/sessions/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的打卡 ID' }, 400);
  const session = await getSession(userId, id);
  if (!session) return c.json({ success: false, error: '打卡记录不存在' }, 404);
  return c.json({ success: true, data: session });
});

timesheet.patch('/sessions/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的打卡 ID' }, 400);

  const parsed = patchSessionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await updateSession(userId, id, {
    ...(parsed.data.clockIn !== undefined ? { clockIn: parsed.data.clockIn } : {}),
    ...(parsed.data.clockOut !== undefined ? { clockOut: parsed.data.clockOut } : {}),
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    ...(parsed.data.location !== undefined ? { location: parsed.data.location } : {}),
  });
  switch (result.status) {
    case 'ok':
      return c.json({ success: true, data: result.session });
    case 'not_found':
      return c.json({ success: false, error: '打卡记录不存在' }, 404);
    case 'conflict':
      return c.json({ success: false, error: '已有进行中的签到，无法重开该记录' }, 409);
    case 'invalid':
      return c.json({ success: false, error: '签到/签退时间无效' }, 400);
  }
});

timesheet.delete('/sessions/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的打卡 ID' }, 400);
  const removed = await deleteSession(userId, id);
  if (!removed) return c.json({ success: false, error: '打卡记录不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

timesheet.get('/summary', async (c) => {
  const userId = Number(c.get('user').id);
  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const today = localDateIn(new Date(), timezone);
  const from = c.req.query('from') ?? startOfWeekYmd(today);
  const to = c.req.query('to') ?? today;
  if (!isValidYmd(from) || !isValidYmd(to)) {
    return c.json({ success: false, error: 'from/to 必须为 YYYY-MM-DD' }, 400);
  }
  if (to < from) return c.json({ success: false, error: 'to 不能早于 from' }, 400);
  if (ymdDiffDays(from, to) > TIMESHEET_MAX_RANGE_DAYS) {
    return c.json({ success: false, error: `时间范围不能超过 ${TIMESHEET_MAX_RANGE_DAYS} 天` }, 400);
  }

  const threshold = parseThreshold(c.req.query('overtimeThreshold'));
  if (threshold === null) {
    return c.json({ success: false, error: 'overtimeThreshold 必须为 1-1440 的整数分钟' }, 400);
  }

  const summary = await getTimesheetSummary(userId, {
    from,
    to,
    timezone,
    ...(threshold !== undefined ? { thresholdMinutes: threshold } : {}),
  });
  return c.json({ success: true, data: summary });
});

timesheet.get('/overtime', async (c) => {
  const userId = Number(c.get('user').id);
  const timezone = await resolveTimezone(c.req.query('timezone'), userId);
  const today = localDateIn(new Date(), timezone);
  const from = c.req.query('from') ?? startOfWeekYmd(today);
  const to = c.req.query('to') ?? today;
  if (!isValidYmd(from) || !isValidYmd(to)) {
    return c.json({ success: false, error: 'from/to 必须为 YYYY-MM-DD' }, 400);
  }
  if (to < from) return c.json({ success: false, error: 'to 不能早于 from' }, 400);
  if (ymdDiffDays(from, to) > TIMESHEET_MAX_RANGE_DAYS) {
    return c.json({ success: false, error: `时间范围不能超过 ${TIMESHEET_MAX_RANGE_DAYS} 天` }, 400);
  }

  const threshold = parseThreshold(c.req.query('threshold'));
  if (threshold === null) {
    return c.json({ success: false, error: 'threshold 必须为 1-1440 的整数分钟' }, 400);
  }
  const view = await getOvertimeView(userId, from, to, {
    timezone,
    ...(threshold !== undefined ? { thresholdMinutes: threshold } : {}),
  });
  return c.json({
    success: true,
    data: { ...view, defaultThresholdMinutes: DEFAULT_OVERTIME_THRESHOLD_MINUTES, from, to, timezone },
  });
});

timesheet.get('/leaves', async (c) => {
  const userId = Number(c.get('user').id);
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from && !isValidYmd(from)) return c.json({ success: false, error: 'from 必须为 YYYY-MM-DD' }, 400);
  if (to && !isValidYmd(to)) return c.json({ success: false, error: 'to 必须为 YYYY-MM-DD' }, 400);
  const leaves = await listLeaves(userId, {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  return c.json({ success: true, data: { leaves, count: leaves.length } });
});

timesheet.post('/leaves', async (c) => {
  const userId = Number(c.get('user').id);
  const parsed = leaveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const result = await createLeave(userId, {
    ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
    startDate: parsed.data.startDate,
    endDate: parsed.data.endDate,
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
  });
  if (result.status === 'invalid') return c.json({ success: false, error: '请假日期无效' }, 400);
  if (result.status !== 'ok') return c.json({ success: false, error: '请假记录创建失败' }, 400);
  return c.json({ success: true, data: result.leave }, 201);
});

timesheet.delete('/leaves/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的请假 ID' }, 400);
  const removed = await deleteLeave(userId, id);
  if (!removed) return c.json({ success: false, error: '请假记录不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

export default timesheet;
