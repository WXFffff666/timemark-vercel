/**
 * Two-way calendar sync routes (task 159) - default-exported Hono router.
 *
 *   GET    /api/calendar-sync/accounts           list sanitized sync accounts
 *   POST   /api/calendar-sync/accounts           create (credentials encrypted at rest)
 *   PATCH  /api/calendar-sync/accounts/:id       update
 *   DELETE /api/calendar-sync/accounts/:id       delete
 *   POST   /api/calendar-sync/accounts/:id/pull  idempotent import (dryRun supported)
 *   POST   /api/calendar-sync/accounts/:id/push  write local events (dryRun supported)
 *
 * All routes are session-scoped via `authMiddleware`; a response NEVER contains
 * a credential (views only expose `hasCredentials`). Every outbound host is
 * checked by the shipped egress guard inside the service.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { formatZodError } from '@timemark/shared';
import {
  CALENDAR_SYNC_DIRECTIONS,
  CALENDAR_SYNC_KINDS,
  CONFLICT_POLICIES,
  CalendarSyncAccountError,
  CalendarSyncError,
  createCalendarSyncAccount,
  deleteCalendarSyncAccount,
  listCalendarSyncAccounts,
  pullCalendarSync,
  pushCalendarSync,
  updateCalendarSyncAccount,
} from '../services/agent/calendar-sync.service.js';

const calendarSync = new Hono<{ Variables: { user: User } }>();
calendarSync.use('*', authMiddleware);

const accountSchema = z
  .object({
    kind: z.enum(CALENDAR_SYNC_KINDS),
    baseUrl: z.string().trim().min(1).max(2048),
    username: z.string().trim().max(200).nullish(),
    credentials: z.string().max(4000).nullish(),
    calendarId: z.string().trim().max(200).nullish(),
    direction: z.enum(CALENDAR_SYNC_DIRECTIONS).optional(),
    conflictPolicy: z.enum(CONFLICT_POLICIES).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    username: z.string().trim().max(200).nullish(),
    credentials: z.string().max(4000).nullish(),
    calendarId: z.string().trim().max(200).optional(),
    direction: z.enum(CALENDAR_SYNC_DIRECTIONS).optional(),
    conflictPolicy: z.enum(CONFLICT_POLICIES).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const runSchema = z.object({ dryRun: z.boolean().optional() }).strict();

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function fail(c: Parameters<typeof authMiddleware>[0], error: unknown) {
  if (error instanceof CalendarSyncAccountError) {
    const status = error.code === 'account_not_found' ? 404 : 400;
    return c.json({ success: false, error: error.message, code: error.code }, status);
  }
  if (error instanceof CalendarSyncError) {
    return c.json({ success: false, error: error.message, code: error.code }, 502);
  }
  throw error;
}

calendarSync.get('/accounts', async (c) => {
  const userId = Number(c.get('user').id);
  const data = await listCalendarSyncAccounts(userId);
  return c.json({ success: true, data });
});

calendarSync.post('/accounts', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => null);
  const parsed = accountSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const view = await createCalendarSyncAccount(userId, parsed.data);
    return c.json({ success: true, data: view }, 201);
  } catch (error) {
    return fail(c, error);
  }
});

calendarSync.patch('/accounts/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id == null) return c.json({ success: false, error: '无效的账户 ID' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const view = await updateCalendarSyncAccount(userId, id, parsed.data);
    return c.json({ success: true, data: view });
  } catch (error) {
    return fail(c, error);
  }
});

calendarSync.delete('/accounts/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id == null) return c.json({ success: false, error: '无效的账户 ID' }, 400);
  const removed = await deleteCalendarSyncAccount(userId, id);
  if (!removed) return c.json({ success: false, error: '同步账户不存在' }, 404);
  return c.json({ success: true });
});

calendarSync.post('/accounts/:id/pull', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id == null) return c.json({ success: false, error: '无效的账户 ID' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = runSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const result = await pullCalendarSync(userId, id, { dryRun: parsed.data.dryRun === true });
    return c.json({ success: true, data: result });
  } catch (error) {
    return fail(c, error);
  }
});

calendarSync.post('/accounts/:id/push', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id == null) return c.json({ success: false, error: '无效的账户 ID' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = runSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const result = await pushCalendarSync(userId, id, { dryRun: parsed.data.dryRun === true });
    return c.json({ success: true, data: result });
  } catch (error) {
    return fail(c, error);
  }
});

export default calendarSync;
