import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/trigger-logs/:id/retry —— 手动补发后的**写回**路径。
 *
 * 读侧早就按真实渠道推导了（channel_results 里的 _quiet_hours / _skipped 被剔除），
 * 但写回侧曾经直接 `Object.entries(channelResults)`：重试恰好发生在安静时段时，
 * sendNotifications 会回一个 `_quiet_hours` 标记，它是 success:false 但不是渠道。
 * 于是补发一次就把 error_message 写成 "_quiet_hours: quiet_hours"，
 * 并把这个不存在的渠道存进 error_details —— 界面上表现为「有个叫 _quiet_hours 的渠道坏了」。
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery, sendNotifications } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotifications: vi.fn(),
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
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  },
}));

vi.mock('../services/notifications/index.js', () => ({ sendNotifications }));

import triggerLogs from '../routes/trigger-logs.js';

const USER = { id: 7, username: 'alice' };

/** 一条 status='success' 但实际部分失败的日志（落库约定：部分失败记 success）。 */
function logRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    event_id: 10,
    status: 'success',
    channel_type: 'fcm',
    retry_count: 0,
    channel_results: { email: { success: true }, fcm: { success: false, error: 'HTTP 500' } },
    error_message: 'fcm: HTTP 500',
    ...overrides,
  };
}

function retry() {
  return triggerLogs.request('/5/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
}

/** 抓取写回 event_trigger_logs 的那条 UPDATE 参数。 */
function updateArgs(): unknown[] {
  const call = dbQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE event_trigger_logs'));
  if (!call) throw new Error('写回 event_trigger_logs 的 UPDATE 从未执行');
  return call[1] as unknown[];
}

describe('POST /api/trigger-logs/:id/retry 的写回', () => {
  beforeEach(() => {
    authState.user = USER;
    dbQuery.mockReset();
    sendNotifications.mockReset();
    // SELECT 日志行；其余（UPDATE 账号、UPDATE 日志）都返回空结果即可
    dbQuery.mockResolvedValue({ rows: [logRow()] });
  });

  it('重试落在安静时段：不会把 _quiet_hours 写成失败渠道', async () => {
    sendNotifications.mockResolvedValue({
      fcm: { success: false, error: 'HTTP 500' },
      _quiet_hours: { success: false, error: 'quiet_hours' },
    });

    const res = await retry();
    expect(res.status).toBe(200);

    const [status, errorMessage, , , errorDetails] = updateArgs();
    // 真实渠道 fcm 确实失败了，所以仍是 failed —— 但原因里只有 fcm
    expect(status).toBe('failed');
    expect(errorMessage).toBe('fcm: HTTP 500');
    expect(String(errorMessage)).not.toContain('_quiet_hours');
    expect(errorDetails).toBe('[{"channel":"fcm","error":"HTTP 500"}]');
  });

  it('重试成功：status=success，error_message/error_details 都清空', async () => {
    sendNotifications.mockResolvedValue({ fcm: { success: true } });

    const res = await retry();
    expect(res.status).toBe(200);

    const [status, errorMessage, , retryCount, errorDetails] = updateArgs();
    expect(status).toBe('success');
    expect(errorMessage).toBeNull();
    expect(retryCount).toBe(1);
    expect(errorDetails).toBeNull();
  });

  it('重试后部分成功：记 success（已送达的渠道不能被重复投递），原因只列真实失败渠道', async () => {
    sendNotifications.mockResolvedValue({
      fcm: { success: true },
      telegram: { success: false, error: '401' },
      _skipped: { success: false, error: 'no_supported_channels' },
    });

    const res = await retry();
    expect(res.status).toBe(200);

    const [status, errorMessage] = updateArgs();
    expect(status).toBe('success');
    expect(errorMessage).toBeNull();
  });

  it('全部成功的历史行不能重试', async () => {
    dbQuery.mockResolvedValue({ rows: [logRow({ channel_results: { email: { success: true } } })] });

    const res = await retry();
    expect(res.status).toBe(400);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('channel_type 与 channel_results 都为空的行（skipped / 异常路径）回落到事件配置的渠道', async () => {
    // channel_type 只在有真实失败渠道时才写，所以 skipped 行、投递后异常、农历换算失败、
    // 测试发送抛异常这些行两个字段同时为空。界面按 outcome !== 'delivered' 显示重试按钮，
    // 后端再回 400 就等于给一个必然失败的按钮 —— 必须回落到事件自己配置的渠道。
    dbQuery.mockResolvedValue({
      rows: [logRow({ status: 'skipped', channel_type: null, channel_results: null, error_message: 'no_channel_resolved', notification_channels: ['email', 'telegram'] })],
    });
    sendNotifications.mockResolvedValue({ email: { success: true }, telegram: { success: true } });

    const res = await retry();
    expect(res.status).toBe(200);

    // 回落用的是事件配置的渠道，不是空的
    expect(sendNotifications).toHaveBeenCalledWith(
      expect.anything(),
      USER.id,
      ['email', 'telegram'],
    );
    const [status, errorMessage, , retryCount, errorDetails] = updateArgs();
    expect(status).toBe('success');
    expect(errorMessage).toBeNull();
    expect(retryCount).toBe(1);
    expect(errorDetails).toBeNull();
  });

  it('notification_channels 是 JSON 字符串时同样能回落', async () => {
    dbQuery.mockResolvedValue({
      rows: [logRow({ status: 'skipped', channel_type: null, channel_results: null, notification_channels: '["email"]' })],
    });
    sendNotifications.mockResolvedValue({ email: { success: true } });

    const res = await retry();
    expect(res.status).toBe(200);
    expect(sendNotifications).toHaveBeenCalledWith(expect.anything(), USER.id, ['email']);
  });

  it('连事件配置也没有渠道时仍然是 400（不假装能重试）', async () => {
    dbQuery.mockResolvedValue({
      rows: [logRow({ status: 'skipped', channel_type: null, channel_results: null, notification_channels: [] })],
    });

    const res = await retry();
    expect(res.status).toBe(400);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('notification_channels 损坏时不抛异常，也不假装能重试', async () => {
    dbQuery.mockResolvedValue({
      rows: [logRow({ status: 'skipped', channel_type: null, channel_results: null, notification_channels: '[not json' })],
    });

    const res = await retry();
    expect(res.status).toBe(400);
    expect(sendNotifications).not.toHaveBeenCalled();
  });
});