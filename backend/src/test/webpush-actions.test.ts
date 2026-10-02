import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Web Push 通知上的动作按钮。
 *
 * 此前 buildWebPushPayload 只产出 title/body/url/icon/badge/tag，通知上没有任何按钮；
 * 即便后端发了 actions，sw.js 的 showNotification 也没把 actions 传下去（现已修）。
 * 这组断言钉住「认得出事件才有按钮」这条规则：没有 id 时 action 无从落地，
 * 按下去只会失败，所以宁可不显示。
 */

vi.mock('web-push', () => ({
  default: { sendNotification: vi.fn(), setVapidDetails: vi.fn(), generateVAPIDKeys: vi.fn() },
}));

vi.mock('../db/index.js', () => ({ query: vi.fn(), waitForDb: vi.fn(), getClient: vi.fn() }));

import { buildWebPushPayload } from '../services/notifications/webpush.service.js';

describe('buildWebPushPayload 的动作按钮', () => {
  beforeEach(() => vi.clearAllMocks());

  it('认得出事件时给出「延后」按钮并带上 eventId', () => {
    const payload = buildWebPushPayload({ id: 42, name: '妈妈生日', date: '2026-10-05' });

    expect(payload.eventId).toBe(42);
    expect(payload.actions).toEqual([{ action: 'snooze', title: '延后 10 分钟' }]);
  });

  it('没有 id 时不给按钮——否则按下去无从落地', () => {
    for (const event of [{}, { id: 0 }, { id: -1 }, { id: 'abc' }, { id: null }]) {
      const payload = buildWebPushPayload(event);
      expect(payload.actions, `event=${JSON.stringify(event)} 不该有按钮`).toBeUndefined();
      expect(payload.eventId).toBeUndefined();
    }
  });

  it('没有 id 时仍然给出可用的兜底深链', () => {
    const payload = buildWebPushPayload({ name: '无 id 事件' });
    expect(payload.url).toBe('/reminders');
    expect(payload.title).toBe('无 id 事件');
  });

  it('既有字段未被动作改动破坏', () => {
    const payload = buildWebPushPayload({ id: 7, name: '纪念日', date: '2026-01-02', type: 'anniversary' });

    expect(payload.tag).toBe('timemark-event-7');
    expect(payload.url).toBe('/reminders?event=7');
    expect(payload.body).toContain('2026-01-02');
    // body 里出现 HTML 标签时必须转成纯文本，通知气泡不解析 HTML
    expect(payload.body).not.toContain('<');
  });

  it('eventId 与 actions 同时存在，SW 不需要解析 url 就能拿到 id', () => {
    const payload = buildWebPushPayload({ id: 99, name: '测试' });
    // 端点是 /api/events/<eventId>/snooze，id 必须直接可用
    expect(Number.isInteger(payload.eventId)).toBe(true);
    expect(payload.actions?.[0]?.action).toBe('snooze');
  });
});