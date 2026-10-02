import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/events/:id/snooze —— Web Push 通知上「延后 10 分钟」按钮的落点。
 *
 * 关键约束：端点**复用** bot 的 snoozeTodo，而不是自己写一遍 UPDATE。snoozed_until 的
 * 语义（从请求时刻起算、不动 date/next_occurrence、刷新 cron 缓存）只有那一个实现知道，
 * 抄一份必然漂移；这里断言的正是「调用了它」，而不是重复实现它的 SQL。
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery, snoozeTodo } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  snoozeTodo: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ query: dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));

vi.mock('../middleware/auth.middleware.js', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: unknown) => void; json: (body: unknown, status?: number) => Response },
    next: () => Promise<void>,
  ) => {
    if (authState.user) {
      c.set('user', authState.user);
      return next();
    }
    return c.json({ success: false, error: '未授权' }, 401);
  },
}));

vi.mock('../services/event.service.js', () => ({
  createEvent: vi.fn(),
  getEventsByUserIdPaginated: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  deleteEventsByIds: vi.fn(),
}));

vi.mock('../services/bot/bot-data.service.js', () => ({ defaultBotDataProvider: { snoozeTodo } }));

import eventRoutes from '../routes/events.js';

const USER = { id: 7, username: 'alice' };

function post(path: string, body?: unknown) {
  return eventRoutes.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** `Response.json()` 返回 unknown，这里收窄成端点真实返回的形状。 */
interface SnoozeBody {
  success: boolean;
  data?: { snoozedUntil: string; localTime: string };
  error?: string;
}

function readJson(res: Response): Promise<SnoozeBody> {
  return res.json() as Promise<SnoozeBody>;
}

describe('POST /api/events/:id/snooze', () => {
  beforeEach(() => {
    authState.user = USER;
    dbQuery.mockReset();
    snoozeTodo.mockReset();
    snoozeTodo.mockResolvedValue({ status: 'ok', snoozedUntil: '2026-10-05T02:10:00.000Z', localTime: '10:10' });
  });

  it('未登录一律 401', async () => {
    authState.user = null;
    const res = await post('/42/snooze');
    expect(res.status).toBe(401);
    expect(snoozeTodo).not.toHaveBeenCalled();
  });

  it('默认延后 10 分钟，并复用 bot 的 snoozeTodo', async () => {
    const res = await post('/42/snooze');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.success).toBe(true);
    expect(body.data?.snoozedUntil).toBe('2026-10-05T02:10:00.000Z');
    // 复用而不是重写：userId 取自会话，eventId 取自路径
    expect(snoozeTodo).toHaveBeenCalledWith(USER.id, 42, 10);
  });

  it('接受约定的时长档位', async () => {
    for (const minutes of [10, 60, 1440]) {
      snoozeTodo.mockClear();
      const res = await post('/42/snooze', { minutes });
      expect(res.status).toBe(200);
      expect(snoozeTodo).toHaveBeenCalledWith(USER.id, 42, minutes);
    }
  });

  it('拒绝不在档位内的时长——通知按钮是固定文案，不该由请求体决定延后多久', async () => {
    const res = await post('/42/snooze', { minutes: 999999 });
    expect(res.status).toBe(400);
    expect(snoozeTodo).not.toHaveBeenCalled();
  });

  it('拒绝非法事件 id', async () => {
    for (const id of ['abc', '0', '-1']) {
      const res = await post(`/${id}/snooze`);
      expect(res.status, `id=${id} 应当被拒`).toBe(400);
    }
    expect(snoozeTodo).not.toHaveBeenCalled();
  });

  it('事件不存在时回 404，不泄露别人的事件是否存在', async () => {
    snoozeTodo.mockResolvedValue({ status: 'not_found' });
    const res = await post('/999/snooze');
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error).toBe('Event not found');
  });

  it('持久化失败时回 500，而不是谎报延后成功', async () => {
    snoozeTodo.mockRejectedValue(new Error('db down'));
    const res = await post('/42/snooze');
    expect(res.status).toBe(500);
    const body = await readJson(res);
    expect(body.success).toBe(false);
  });

  it('请求体不是合法 JSON 时退回默认 10 分钟，而不是 400', async () => {
    const res = await eventRoutes.request('/42/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(200);
    expect(snoozeTodo).toHaveBeenCalledWith(USER.id, 42, 10);
  });
});