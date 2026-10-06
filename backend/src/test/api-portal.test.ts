import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * v2.30 方向 B — 对外 REST API（/api/v1/*）：
 * 鉴权（无/无效/撤销/过期 token）、scope 门槛、限流 429、
 * 归属过滤（别人的事件 404）、写端点校验、审计落库。
 */

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  resolveCredential: vi.fn(),
  checkRate: vi.fn(),
  writeAudit: vi.fn(),
  createEvent: vi.fn(),
  listExpiry: vi.fn(),
  listHabits: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ query: mocks.dbQuery }));
vi.mock('../services/agent-tokens.service.js', () => ({
  resolveAgentTokenCredential: mocks.resolveCredential,
  writeAgentAudit: mocks.writeAudit,
}));
vi.mock('../services/agent/rate-limit.service.js', () => ({
  checkAgentRateLimit: mocks.checkRate,
}));
vi.mock('../services/event.service.js', () => ({ createEvent: mocks.createEvent }));
vi.mock('../services/expiry.service.js', () => ({ listExpiryItems: mocks.listExpiry }));
vi.mock('../services/habit.service.js', () => ({ listHabits: mocks.listHabits }));
vi.mock('../utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import apiV1 from '../routes/api-portal.js';

const OK_CRED = { status: 'ok', userId: 7, tokenId: 'tok-1', scopes: ['read'] };
const WRITE_CRED = { status: 'ok', userId: 7, tokenId: 'tok-1', scopes: ['read', 'write'] };

function app() {
  return apiV1;
}
const auth = (token = 'tmt_x') => ({ Authorization: `Bearer ${token}` });
const json = (res: Response) => res.json() as Promise<{ error?: string; data?: unknown }>;

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.resolveCredential.mockResolvedValue(OK_CRED);
  mocks.checkRate.mockResolvedValue({ allowed: true, remaining: 100, resetAt: Date.now() + 60_000 });
  mocks.writeAudit.mockResolvedValue('audit-1');
  mocks.dbQuery.mockResolvedValue({ rows: [] });
});

describe('/api/v1 鉴权', () => {
  it('401 without a token', async () => {
    const res = await app().request('/events');
    expect(res.status).toBe(401);
    expect(mocks.dbQuery).not.toHaveBeenCalled();
  });

  it('401 for unknown token', async () => {
    mocks.resolveCredential.mockResolvedValue({ status: 'unknown' });
    const res = await app().request('/events', { headers: auth() });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('invalid_token');
  });

  it('401 for revoked / expired tokens with distinct errors', async () => {
    mocks.resolveCredential.mockResolvedValue({ status: 'revoked' });
    expect((await json(await app().request('/events', { headers: auth() }))).error).toBe('token_revoked');
    mocks.resolveCredential.mockResolvedValue({ status: 'expired' });
    expect((await json(await app().request('/events', { headers: auth() }))).error).toBe('token_expired');
  });

  it('403 when read-only token hits a write endpoint', async () => {
    const res = await app().request('/events', { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(403);
    expect((await json(res)).error).toContain('write');
  });

  it('429 with Retry-After when rate limited', async () => {
    mocks.checkRate.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 30_000 });
    const res = await app().request('/events', { headers: auth() });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('writes one audit row per request', async () => {
    await app().request('/events', { headers: auth() });
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit.mock.calls[0][0].tool).toContain('rest:');
  });
});

describe('/api/v1 只读端点', () => {
  it('events: static SQL, ownership filter, limit cap at 100', async () => {
    mocks.dbQuery.mockResolvedValue({ rows: [{ id: 1, name: '妈妈生日' }] });
    const res = await app().request('/events?limit=500&from=2026-01-01', { headers: auth() });
    expect(res.status).toBe(200);
    const [sql, params] = mocks.dbQuery.mock.calls[0];
    expect(String(sql)).not.toContain('${');
    expect(String(sql)).toContain('user_id = $1');
    expect(params[0]).toBe(7);
    expect(params[1]).toBe(100); // capped
    expect(params).toContain('2026-01-01');
  });

  it('events/:id returns 404 for another user\'s event (ownership scoped)', async () => {
    mocks.dbQuery.mockResolvedValue({ rows: [] });
    const res = await app().request('/events/5', { headers: auth() });
    expect(res.status).toBe(404);
    const [sql, params] = mocks.dbQuery.mock.calls[0];
    expect(String(sql)).toContain('user_id = $2');
    expect(params).toContain(7);
  });

  it('events/:id rejects non-numeric id', async () => {
    const res = await app().request('/events/abc', { headers: auth() });
    expect(res.status).toBe(400);
  });

  it('habits: projects public fields only', async () => {
    mocks.listHabits.mockResolvedValue([
      { id: 1, name: '晨跑', is_active: true, streak: { current: 3, longest: 5 }, target_per_period: 1, period: 'day' },
    ]);
    const res = await app().request('/habits', { headers: auth() });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toEqual({ id: 1, name: '晨跑', isActive: true, streak: 3, longestStreak: 5, targetPerPeriod: 1, period: 'day' });
  });
});

describe('/api/v1 写端点', () => {
  it('POST /v1/events validates via shared schema (400 on bad payload)', async () => {
    mocks.resolveCredential.mockResolvedValue(WRITE_CRED);
    const res = await app().request('/events', {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('POST /v1/events creates and returns minimal fields (201)', async () => {
    mocks.resolveCredential.mockResolvedValue(WRITE_CRED);
    mocks.createEvent.mockResolvedValue({ id: 42, name: '周年纪念', date: '2026-12-01' });
    const res = await app().request('/events', {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '周年纪念',
        type: 'anniversary',
        date: '2026-12-01',
        calendarType: 'gregorian',
        reminderConfig: { enabled: false, daysBeforeList: [0], emailRecipients: [] },
      }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { id: number } }).data).toMatchObject({ id: 42 });
    expect(mocks.createEvent).toHaveBeenCalledWith('7', expect.objectContaining({ name: '周年纪念' }));
  });
});
