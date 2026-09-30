import { Hono } from 'hono';
import { z } from 'zod';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  createWatchlistItem,
  deleteWatchlistItem,
  getWatchlistItem,
  isWatchlistKind,
  isWatchlistStatus,
  listUpcomingReleases,
  listWatchlistItems,
  updateWatchlistItem,
  WATCHLIST_KINDS,
  WATCHLIST_STATUSES,
} from '../services/agent/watchlist.service.js';

/**
 * Task 157: watch / read list API, mounted at `/api/watchlist` (integrator).
 *
 *   GET    /api/watchlist                 list items (optional ?kind=&status=)
 *   GET    /api/watchlist/upcoming        future releases, soonest first
 *   POST   /api/watchlist                 add an item
 *   GET    /api/watchlist/:id             one item
 *   PATCH  /api/watchlist/:id             update item / status / release date
 *   DELETE /api/watchlist/:id             remove item
 *
 * Release reminders are not created here: wanted/in_progress rows with a future
 * release_date are picked up by the shared minute-cron reminder iterator
 * (jobs/tasks.ts WATCHLIST_SOURCE). No second scheduler exists.
 */
const watchlist = new Hono<{ Variables: { user: User } }>();
watchlist.use('*', authMiddleware);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const itemCreateSchema = z.object({
  kind: z.enum(WATCHLIST_KINDS).optional(),
  title: z.string().min(1).max(200),
  status: z.enum(WATCHLIST_STATUSES).optional(),
  releaseDate: z.string().regex(DATE_PATTERN).nullable().optional(),
  source: z.string().max(120).nullable().optional(),
  link: z.string().max(500).nullable().optional(),
  rating: z.number().int().min(0).max(10).nullable().optional(),
  note: z.string().max(1000).optional(),
});

const itemUpdateSchema = itemCreateSchema.partial();

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

watchlist.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const kind = c.req.query('kind');
  const status = c.req.query('status');
  const items = await listWatchlistItems(userId, {
    ...(isWatchlistKind(kind) ? { kind } : {}),
    ...(isWatchlistStatus(status) ? { status } : {}),
  });
  return c.json({ success: true, data: { items, count: items.length } });
});

// Registered before `/:id` so the literal path wins.
watchlist.get('/upcoming', async (c) => {
  const userId = Number(c.get('user').id);
  const items = await listUpcomingReleases(userId);
  return c.json({ success: true, data: { items, count: items.length } });
});

watchlist.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = itemCreateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const title = parsed.data.title.trim();
  if (title === '') return c.json({ success: false, error: '请求参数无效' }, 400);

  const item = await createWatchlistItem(userId, {
    kind: parsed.data.kind,
    title,
    status: parsed.data.status,
    releaseDate: parsed.data.releaseDate,
    source: parsed.data.source == null ? null : parsed.data.source.trim(),
    link: parsed.data.link == null ? null : parsed.data.link.trim(),
    rating: parsed.data.rating,
    note: parsed.data.note,
  });
  return c.json({ success: true, data: item }, 201);
});

watchlist.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的条目 ID' }, 400);
  const item = await getWatchlistItem(userId, id);
  if (!item) return c.json({ success: false, error: '条目不存在' }, 404);
  return c.json({ success: true, data: item });
});

watchlist.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的条目 ID' }, 400);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = itemUpdateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ success: false, error: '请求参数无效' }, 400);

  const patch = {
    ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
    ...(parsed.data.title !== undefined ? { title: parsed.data.title.trim() } : {}),
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.releaseDate !== undefined ? { releaseDate: parsed.data.releaseDate } : {}),
    ...(parsed.data.source !== undefined
      ? { source: parsed.data.source == null ? null : parsed.data.source.trim() }
      : {}),
    ...(parsed.data.link !== undefined
      ? { link: parsed.data.link == null ? null : parsed.data.link.trim() }
      : {}),
    ...(parsed.data.rating !== undefined ? { rating: parsed.data.rating } : {}),
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
  };
  if (Object.keys(patch).length === 0) {
    return c.json({ success: false, error: '没有可更新的字段' }, 400);
  }

  const item = await updateWatchlistItem(userId, id, patch);
  if (!item) return c.json({ success: false, error: '条目不存在' }, 404);
  return c.json({ success: true, data: item });
});

watchlist.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的条目 ID' }, 400);
  const removed = await deleteWatchlistItem(userId, id);
  if (!removed) return c.json({ success: false, error: '条目不存在' }, 404);
  return c.json({ success: true, data: { removed: true } });
});

export default watchlist;
