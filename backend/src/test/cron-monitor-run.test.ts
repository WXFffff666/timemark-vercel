import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * v2.30 CronMonitor 手动运行端点：仅机主（fullTrust）、仅白名单任务、
 * 进程内每分钟一次限速、未配 CRON_SECRET 拒绝。
 */

const { mockQuery, mockHeartbeat, mockSendReminders, mockRetries } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockHeartbeat: { getCronSecret: vi.fn((): string | undefined => 'devcron') },
  mockSendReminders: vi.fn(async () => {}),
  mockRetries: vi.fn(async () => ({ processed: 2, succeeded: 1 })),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));
vi.mock('../utils/heartbeat.js', () => ({ getCronSecret: mockHeartbeat.getCronSecret }));
vi.mock('../jobs/tasks.js', () => ({ sendReminders: mockSendReminders }));
vi.mock('../services/notification-retry.service.js', () => ({
  processNotificationRetries: mockRetries,
}));
vi.mock('../utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import cronMonitorRoutes from '../routes/cron-monitor.js';

function appWithScopes(scopes?: string[]) {
  const app = new Hono<{ Variables: { user: unknown; apiScopes?: string[] } }>();
  app.use('*', async (c, next) => {
    c.set('user' as never, { id: '1', username: 'admin' } as never);
    if (scopes) c.set('apiScopes' as never, scopes as never);
    await next();
  });
  app.route('/cron-monitor', cronMonitorRoutes);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockSendReminders.mockClear();
  mockRetries.mockClear();
});

describe('POST /cron-monitor/run/:job', () => {
  it('404 for non-whitelisted jobs (daily-maintenance stays cron-secret-only)', async () => {
    const res = await appWithScopes().request('/cron-monitor/run/daily-maintenance', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('403 for non-fullTrust (API key without admin scope)', async () => {
    const res = await appWithScopes(['read']).request('/cron-monitor/run/reminder-check', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('400 when CRON_SECRET is not configured', async () => {
    mockHeartbeat.getCronSecret.mockReturnValueOnce(undefined);
    const res = await appWithScopes().request('/cron-monitor/run/reminder-check', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('runs reminder-check and returns duration', async () => {
    const res = await appWithScopes().request('/cron-monitor/run/reminder-check', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { summary: string } };
    expect(body.success).toBe(true);
    expect(body.data.summary).toContain('提醒检查');
    expect(mockSendReminders).toHaveBeenCalledTimes(1);
  });

  it('runs retry-notifications with counts in summary', async () => {
    const res = await appWithScopes().request('/cron-monitor/run/retry-notifications', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { summary: string } };
    expect(body.data.summary).toContain('成功 1 条');
    expect(mockRetries).toHaveBeenCalledTimes(1);
  });
});
