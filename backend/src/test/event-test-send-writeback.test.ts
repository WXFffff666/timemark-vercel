import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/events/:id/test-send 的**写回**路径。
 *
 * 与定时路径（jobs/tasks.ts）和手动补发（trigger-logs）同款毛病：当所有请求渠道都被
 * filterSupportedChannels 丢掉时，sendNotifications 除了列出被丢掉的渠道，还会放一个
 * `_skipped: no_supported_channels` 标记，它是 success:false 但不是渠道。旧代码直接
 * `Object.entries(channelResults)`，于是手动测试发送一次就把
 * error_details.channel_type 写成 "_skipped,nostr" —— 提醒日志里出现一个叫 _skipped 的渠道。
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery, sendNotifications, recordEventTrigger, resolveReminderChannels } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotifications: vi.fn(),
  recordEventTrigger: vi.fn(),
  resolveReminderChannels: vi.fn(),
}));

// 只有取事件那一行需要有数据，其余查询返回空即可
const EVENT_ROW = {
  id: 10,
  name: '周年纪念',
  type: 'anniversary',
  notification_channels: ['nostr'],
  reminder_config: {},
};

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../middleware/auth.middleware.js', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: unknown) => void; json: (body: unknown, status?: number) => Response },
    next: () => Promise<void>,
  ) => {
    if (authState.user) {
      c.set('user', authState.user);
      return next();
    }
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  },
}));

vi.mock('../services/event.service.js', () => ({
  createEvent: vi.fn(),
  getEventsByUserIdPaginated: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  deleteEventsByIds: vi.fn(),
}));

vi.mock('../services/event-cache.service.js', () => ({ refreshUserEventCache: vi.fn() }));
vi.mock('../services/reminder-channel-resolver.service.js', () => ({ resolveReminderChannels }));
vi.mock('../services/notifications/index.js', () => ({ sendNotifications }));
vi.mock('../services/trigger-log.service.js', () => ({ recordEventTrigger }));
vi.mock('../jobs/tasks.js', () => ({
  sendReminders: vi.fn(),
  recordSkippedTrigger: vi.fn(),
  NO_CHANNEL_RESOLVED_REASON: 'no_channel_resolved',
}));

import eventRoutes from '../routes/events.js';

const USER = { id: 7, username: 'alice' };

function testSend() {
  return eventRoutes.request('/10/test-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

describe('POST /api/events/:id/test-send 的写回', () => {
  beforeEach(() => {
    authState.user = USER;
    dbQuery.mockReset();
    dbQuery.mockImplementation((sql: string) =>
      Promise.resolve(String(sql).includes('FROM events') ? { rows: [EVENT_ROW] } : { rows: [] }),
    );
    sendNotifications.mockReset();
    recordEventTrigger.mockReset();
    resolveReminderChannels.mockReset();
    recordEventTrigger.mockResolvedValue(true);
    resolveReminderChannels.mockResolvedValue(['nostr']);
  });

  it('全部渠道都不被支持时：_skipped 不写进 channel_type 与 error_message', async () => {
    // sendNotifications 在 channels 全被过滤掉时的真实返回形状
    sendNotifications.mockResolvedValue({
      _skipped: { success: false, error: 'no_supported_channels' },
      nostr: { success: false, error: 'unsupported_channel' },
    });

    const res = await testSend();
    expect(res.status).toBe(400);

    expect(recordEventTrigger).toHaveBeenCalledTimes(1);
    const [, , , , status, errorMessage, , errorDetails] = recordEventTrigger.mock.calls[0];
    expect(status).toBe('failed');
    expect(errorMessage).toBe('nostr: unsupported_channel');
    expect(String(errorMessage)).not.toContain('_skipped');
    expect(errorDetails.channel_type).toBe('nostr');
    expect(String(errorDetails.channel_type)).not.toContain('_skipped');
    expect(errorDetails.details).toEqual([{ channel: 'nostr', error: 'unsupported_channel' }]);
  });

  it('部分失败：只列真实失败渠道', async () => {
    resolveReminderChannels.mockResolvedValue(['email', 'nostr']);
    sendNotifications.mockResolvedValue({
      email: { success: true },
      nostr: { success: false, error: 'unsupported_channel' },
    });

    const res = await testSend();
    expect(res.status).toBe(200);

    const [, , , , status, errorMessage, , errorDetails] = recordEventTrigger.mock.calls[0];
    expect(status).toBe('failed'); // partial 在落库时记作 failed（既有约定）
    expect(errorMessage).toBe('nostr: unsupported_channel');
    expect(errorDetails.channel_type).toBe('nostr');
  });
});