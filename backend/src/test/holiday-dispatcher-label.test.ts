import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 78 — the holiday name must reach the RENDERED notification content,
 * not just the job's internal state.
 *
 * This exercises the real `sendNotifications` dispatch chain with a generic
 * webhook account and captures the outbound body (the same technique as
 * `wave2-dispatch.test.ts`). It also unit-tests `appendHolidayLabel` directly.
 */

const { mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn<(url: string, data?: Record<string, unknown>, config?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>>(),
}));

vi.mock('axios', () => ({ default: { post: mockPost, get: vi.fn() } }));
vi.mock('../services/config.service.js', () => ({
  getUserConfig: vi.fn(),
  getRelationshipMappings: vi.fn(),
  getNotificationAccounts: vi.fn(),
  getEventTemplate: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));
vi.mock('../services/email-log.service.js', () => ({
  logEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/notification-retry.service.js', () => ({
  enqueueNotificationRetry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/conflict-hint.service.js', () => ({
  getConflictHint: vi.fn().mockResolvedValue(null),
}));

import { appendHolidayLabel, sendNotifications } from '../services/notifications/index.js';
import {
  getEventTemplate,
  getNotificationAccounts,
  getRelationshipMappings,
  getUserConfig,
  type NotificationAccount,
} from '../services/config.service.js';

function account(overrides: Partial<NotificationAccount> & { id: number; type: string }): NotificationAccount {
  return {
    user_id: 1,
    name: overrides.type,
    webhook: null,
    token: null,
    secret: null,
    chat_id: null,
    is_active: true,
    config_method: 'webhook',
    session_data: null,
    plugin_package: null,
    connection_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const WEBHOOK = 'https://capture.local/timemark-holiday';

function holidayEvent() {
  return {
    id: 77,
    name: '假日联测',
    type: 'holiday',
    date: '2026-10-01',
    reminderConfig: {},
    notification_account_ids: [1],
  };
}

async function capturedText(holidayLabel?: string): Promise<string> {
  vi.mocked(getNotificationAccounts).mockResolvedValue([account({ id: 1, type: 'generic_webhook', webhook: WEBHOOK })]);
  mockPost.mockResolvedValue({ status: 200, data: { ok: true } });

  await sendNotifications(holidayEvent(), 1, ['generic_webhook'], holidayLabel ? { holidayLabel } : undefined);

  expect(mockPost).toHaveBeenCalledTimes(1);
  const [url, body] = mockPost.mock.calls[0];
  expect(String(url)).toBe(WEBHOOK);
  return String((body as { text?: unknown }).text ?? '');
}

beforeEach(() => {
  vi.mocked(getUserConfig).mockResolvedValue({});
  vi.mocked(getRelationshipMappings).mockResolvedValue([]);
  vi.mocked(getEventTemplate).mockResolvedValue(null);
  vi.mocked(getNotificationAccounts).mockResolvedValue([]);
  mockPost.mockReset();
});

describe('appendHolidayLabel (pure)', () => {
  it('appends to existing content, creates a minimal body when absent, and is idempotent', () => {
    expect(appendHolidayLabel(undefined, '今日国庆节（法定假日）', { date: '2026-10-01', type: 'holiday' })).toBe(
      '**日期:** 2026-10-01\n**类型:** holiday\n🎉 今日国庆节（法定假日）',
    );
    expect(appendHolidayLabel('基础正文', '今日国庆节（法定假日）', {})).toBe('基础正文\n🎉 今日国庆节（法定假日）');
    expect(appendHolidayLabel('正文\n🎉 今日国庆节（法定假日）', '今日国庆节（法定假日）', {})).toBe(
      '正文\n🎉 今日国庆节（法定假日）',
    );
    expect(appendHolidayLabel('基础正文', undefined, {})).toBe('基础正文');
    expect(appendHolidayLabel('基础正文', '   ', {})).toBe('基础正文');
  });
});

describe('holiday name reaches the rendered content (checkbox 78)', () => {
  it('includes 国庆节 in the dispatched body when holidayLabel is passed', async () => {
    const text = await capturedText('今日国庆节（法定假日）');
    expect(text).toContain('国庆节');
  });

  it('NEGATIVE CONTROL: without holidayLabel the same dispatch has no 国庆节', async () => {
    const text = await capturedText();
    expect(text).not.toContain('国庆节');
  });

  it('keeps the label when existing content is present', async () => {
    const text = await capturedText('法定假日「中秋」顺延提醒');
    expect(text).toContain('中秋');
  });
});
