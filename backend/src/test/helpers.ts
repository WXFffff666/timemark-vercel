import { vi } from 'vitest';

export function createTestEvent(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    user_id: 1,
    name: '测试事件',
    type: 'birthday',
    date: '2026-06-01',
    calendar_type: 'gregorian',
    notification_channels: '[]',
    notification_account_ids: '[]',
    reminder_time: '09:00',
    reminder_days_before: '[1, 3, 7]',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function createTestUser(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    username: 'testuser',
    password_hash: '$2a$10$fakehash',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function createMockQueryResult(rows: any[] = []) {
  return { rows, rowCount: rows.length };
}
