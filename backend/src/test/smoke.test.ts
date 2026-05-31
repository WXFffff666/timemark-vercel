import { describe, it, expect } from 'vitest';
import { createTestEvent, createTestUser, createMockQueryResult } from './helpers.js';

describe('Test Infrastructure', () => {
  it('creates test event with defaults', () => {
    const event = createTestEvent();
    expect(event.name).toBe('测试事件');
    expect(event.type).toBe('birthday');
    expect(event.date).toBe('2026-06-01');
  });

  it('creates test event with overrides', () => {
    const event = createTestEvent({ name: '妈妈生日', type: 'anniversary' });
    expect(event.name).toBe('妈妈生日');
    expect(event.type).toBe('anniversary');
  });

  it('creates test user', () => {
    const user = createTestUser({ username: 'admin' });
    expect(user.username).toBe('admin');
    expect(user.id).toBe(1);
  });

  it('creates mock query result', () => {
    const result = createMockQueryResult([{ id: 1, name: 'test' }]);
    expect(result.rows).toHaveLength(1);
    expect(result.rowCount).toBe(1);
  });
});
