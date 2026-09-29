import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SendPayload {
  subject: string;
  text: string;
  html: string;
}

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(async (_payload: SendPayload) => ({ data: { id: 'test-id' }, error: null })),
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend };
  },
}));

import { sendEmailNotification } from '../services/notifications/email.service.js';

/**
 * checkbox 169：默认（未自定义）模板的邮件主题与正文必须同时带上公历 + 农历。
 * 这个测试直接断言注入 `resend.emails.send` 的 payload —— 它证明 email.service.ts
 * 确实把事件持久化的 `lunar_date` / `calendar_type` 原样（不重算）传给了
 * shared 的默认主题/正文构造器。
 */
describe('dual-calendar reminder email (checkbox 169)', () => {
  beforeEach(() => {
    mockSend.mockClear();
  });

  it('carries BOTH dates in subject and body for a both-calendar event', async () => {
    await sendEmailNotification(
      {
        name: '妈妈生日',
        date: '2026-10-05',
        type: 'birthday',
        calendar_type: 'both',
        lunar_date: '{"year":2026,"month":8,"day":15,"isLeap":false}',
        personName: '妈妈',
      },
      'api-key',
      'from@example.com',
      'to@example.com',
    );

    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0][0];
    expect(payload.subject).toContain('2026-10-05');
    expect(payload.subject).toContain('农历八月十五');
    expect(payload.text).toContain('农历八月十五');
    expect(payload.text).toContain('2026-10-05');
  });

  it('keeps a Gregorian-only reminder unchanged (no lunar slot)', async () => {
    await sendEmailNotification(
      {
        name: '周年纪念',
        date: '2026-10-05',
        type: 'anniversary',
        calendar_type: 'gregorian',
        lunar_date: null,
      },
      'api-key',
      'from@example.com',
      'to@example.com',
    );

    const payload = mockSend.mock.calls[0][0];
    expect(payload.subject).toBe('周年纪念');
    expect(payload.text).not.toContain('农历');
  });
});
