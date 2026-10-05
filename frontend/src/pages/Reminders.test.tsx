import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * 「事件提醒」列表字段绑定回归证明（v2.26 C：原 /reminders 页面并入
 * /trigger-logs 的「事件提醒」tab，被测对象是抽取出的 EventReminderLogs）：
 * - `GET /events/reminder-logs` 返回 `created_at`（端点没有 `sent_at`），
 *   列表必须按 `created_at` 渲染真实相对时间，绝不出现 Invalid Date / undefined。
 * - 同一次 SELECT 里是 `channel_results`（不是 `channel`）与 `error_message`（不是 `message`），
 *   组件必须按真实字段渲染。
 * - `event_trigger_logs.channel_results` 在 schema 里是 JSONB（`shared/src/schema.pg.sql:216`），
 *   线上端点把它作为**已解析的 JSON 对象**下发（`typeof === 'object'`）；只有 v14 迁移建出的
 *   旧库才会是 TEXT/JJSON 字符串。因此**对象形态才是主用例**，字符串形态是旧库兼容分支 ——
 *   只喂字符串的测试会因为错误理由而变绿（`JSON.parse(object)` -> `"[object Object]"` -> 空）。
 */

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { EventReminderLogs } from '@/components/reminder/EventReminderLogs';

const getMock = vi.mocked(api.get);

describe('EventReminderLogs（原提醒记录页）', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('renders created_at as a real relative time, never Invalid Date', async () => {
    getMock.mockResolvedValue([
      {
        id: 1,
        event_id: 10,
        event_name: '周年纪念',
        status: 'success',
        error_message: null,
        // JSONB wire shape: the driver hands back an already-parsed object.
        channel_results: { email: { success: true } },
        created_at: new Date().toISOString(),
      },
    ] as never);

    render(<EventReminderLogs />);

    expect(await screen.findByRole('heading', { name: /周年纪念/ })).toBeInTheDocument();
    expect(await screen.findByText('刚刚')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    expect(screen.getByText(/渠道: 邮件/)).toBeInTheDocument();
  });

  it('renders error_message (not message) for a failed reminder', async () => {
    getMock.mockResolvedValue([
      {
        id: 2,
        event_id: 11,
        event_name: '服务器续费',
        status: 'failed',
        error_message: 'HTTP 401 Unauthorized',
        channel_results: { webhook: { success: false, error: 'HTTP 401' } },
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    ] as never);

    render(<EventReminderLogs />);

    expect(await screen.findByRole('heading', { name: /服务器续费/ })).toBeInTheDocument();
    expect(await screen.findByText('2小时前')).toBeInTheDocument();
    expect(await screen.findByText('HTTP 401 Unauthorized')).toBeInTheDocument();
    expect(screen.getByText(/渠道: Webhook/)).toBeInTheDocument();
  });

  it('still renders channels for a legacy TEXT (JSON string) channel_results', async () => {
    getMock.mockResolvedValue([
      {
        id: 3,
        event_id: 12,
        event_name: '旧库事件',
        status: 'success',
        error_message: null,
        // Legacy v14-created TEXT column -> the wire value is a JSON string.
        channel_results: JSON.stringify({ email: { success: true }, telegram: { success: true } }),
        created_at: new Date().toISOString(),
      },
    ] as never);

    render(<EventReminderLogs />);

    expect(await screen.findByRole('heading', { name: /旧库事件/ })).toBeInTheDocument();
    expect(screen.getByText(/渠道: 邮件、Telegram/)).toBeInTheDocument();
  });

  it('shows a partially delivered send as 部分失败 instead of a green 成功', async () => {
    // 3 个渠道到了、1 个失败，落库 status 是 'success'（tasks.ts 只看 every(!success)）。
    // 旧页面因此显示绿色"成功"并把 error_message 藏起来 —— 用户既看不到失败也补不了。
    getMock.mockResolvedValue([
      {
        id: 9,
        event_id: 30,
        event_name: '部分送达事件',
        status: 'success',
        error_message: 'fcm: HTTP 500',
        channel_results: {
          email: { success: true },
          telegram: { success: true },
          webhook: { success: true },
          fcm: { success: false, error: 'HTTP 500' },
        },
        created_at: new Date().toISOString(),
      },
    ] as never);

    render(<EventReminderLogs />);

    expect(await screen.findByText('部分失败')).toBeInTheDocument();
    expect(screen.queryByText('成功')).not.toBeInTheDocument();
    // 失败原因与"几个到了"都必须说清楚，不能只丢一个"部分失败"标签
    expect(screen.getByText('fcm: HTTP 500')).toBeInTheDocument();
    expect(screen.getByText('已送达 3 个，未送达 1 个')).toBeInTheDocument();
  });

  it('does not list the internal marker keys as delivery channels', async () => {
    // 安静时段：真实渠道都失败 + 一个 _quiet_hours 标记键。标记不是渠道，
    // 渠道行不能把它算进去，否则用户会看到一个不存在的"渠道"。
    getMock.mockResolvedValue([
      {
        id: 10,
        event_id: 31,
        event_name: '安静时段事件',
        status: 'failed',
        error_message: 'email: quiet_hours',
        channel_results: {
          email: { success: false, error: 'quiet_hours' },
          _quiet_hours: { success: false, error: 'quiet_hours' },
        },
        created_at: new Date().toISOString(),
      },
    ] as never);

    render(<EventReminderLogs />);

    expect(await screen.findByText('失败')).toBeInTheDocument();
    // 渠道行只列真实渠道：email 在、_quiet_hours 不在
    expect(screen.getByText('渠道: 邮件')).toBeInTheDocument();
    // 标记键本身绝不能出现在界面上（错误原因里出现 quiet_hours 是正常的，那是真的原因）
    expect(screen.queryByText(/_quiet_hours/)).not.toBeInTheDocument();
  });

  it('labels an unresolved-channel skip as 已跳过 rather than 失败', async () => {
    getMock.mockResolvedValue([
      {
        id: 11,
        event_id: 32,
        event_name: '跳过事件',
        status: 'skipped',
        error_message: 'no_channel_resolved',
        channel_results: null,
        created_at: new Date().toISOString(),
      },
    ] as never);

    render(<EventReminderLogs />);

    expect(await screen.findByText('已跳过')).toBeInTheDocument();
    expect(screen.queryByText('失败')).not.toBeInTheDocument();
    expect(screen.getByText('no_channel_resolved')).toBeInTheDocument();
  });

  it('degrades sanely for array / malformed / empty / null / missing channel_results', async () => {
    getMock.mockResolvedValue([
      { id: 4, event_id: 20, event_name: '数组形态', status: 'success', error_message: null, channel_results: ['email'], created_at: new Date().toISOString() },
      { id: 5, event_id: 21, event_name: '畸形字符串', status: 'success', error_message: null, channel_results: '{not json', created_at: new Date().toISOString() },
      { id: 6, event_id: 22, event_name: '空字符串', status: 'success', error_message: null, channel_results: '', created_at: new Date().toISOString() },
      { id: 7, event_id: 23, event_name: '空值', status: 'success', error_message: null, channel_results: null, created_at: new Date().toISOString() },
      { id: 8, event_id: 24, event_name: '缺字段', status: 'success', error_message: null, created_at: new Date().toISOString() },
    ] as never);

    render(<EventReminderLogs />);

    for (const name of ['数组形态', '畸形字符串', '空字符串', '空值', '缺字段']) {
      expect(await screen.findByRole('heading', { name: new RegExp(name) })).toBeInTheDocument();
    }
    // No degradation may leak a raw JS value or a broken date into the DOM.
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    // Every degraded row renders the 渠道 label with an empty value.
    expect(screen.getAllByText('渠道:')).toHaveLength(5);
  });
});
