import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'crypto';

/**
 * v2.31 R6（审计 Q2-1）：/api/webhook/receive/:token 路由级测试。
 * 公网入口（无鉴权中间件）：token 查库、HMAC 签名（timing-safe）、幂等键回放、
 * 体积上限、字段校验、生产无 secret 拒绝。此前只有 crypto 原语测试，路由逻辑裸奔。
 */

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  createEvent: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ query: mocks.dbQuery }));
vi.mock('../services/event.service.js', () => ({ createEvent: mocks.createEvent }));
vi.mock('../middleware/rate-limit.js', () => ({
  rateLimit: () => (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logFireAndForget: () => () => {},
}));

import webhookInbound from '../routes/webhook-inbound.js';

const TOKEN = 'a'.repeat(32);
const SECRET = 'shared-secret';
const USER = { user_id: 7, webhook_inbound_secret: SECRET };

function app() {
  return webhookInbound;
}

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

const NO_SECRET_USER = { user_id: 7, webhook_inbound_secret: null };

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.dbQuery.mockResolvedValue({ rows: [USER] });
  mocks.createEvent.mockResolvedValue({ id: 42, name: ' webhook 事件', date: '2026-12-25' });
});

function post(body: string, headers: Record<string, string> = {}, token = TOKEN) {
  return app().request(`/receive/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

describe('POST /api/webhook/receive/:token', () => {
  it('400 for short/absent token (no db hit)', async () => {
    const res = await app().request('/receive/short', { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    expect(mocks.dbQuery).not.toHaveBeenCalled();
  });

  it('404 for unknown token', async () => {
    mocks.dbQuery.mockResolvedValue({ rows: [] });
    const res = await post('{}');
    expect(res.status).toBe(404);
  });

  it('401 when secret configured but signature missing', async () => {
    const res = await post(JSON.stringify({ name: 'x', date: '2026-12-25' }));
    expect(res.status).toBe(401);
  });

  it('401 for a wrong signature (timing-safe path)', async () => {
    const body = JSON.stringify({ name: 'x', date: '2026-12-25' });
    const res = await post(body, { 'X-Timemark-Signature': sign(body, 'wrong-secret') });
    expect(res.status).toBe(401);
  });

  it('creates the event with a valid signature and honors field aliases/type whitelist', async () => {
    const body = JSON.stringify({ title: 'mom birthday', start: '2026-12-25', type: 'wedding', remind: false });
    const res = await post(body, { 'X-Timemark-Signature': sign(body) });
    expect(res.status).toBe(200); // 契约：成功统一 200（c.body，非 201）
    const payload = mocks.createEvent.mock.calls[0][1];
    expect(payload).toMatchObject({ name: 'mom birthday', date: '2026-12-25', type: 'other' }); // wedding 不在白名单 → other
    expect(payload.reminderConfig.enabled).toBe(false);
  });

  it('400 on invalid JSON / missing fields', async () => {
    const res1 = await post('not-json', { 'X-Timemark-Signature': sign('not-json') });
    expect(res1.status).toBe(400);
    const res2 = await post(JSON.stringify({ name: 'no-date' }), {
      'X-Timemark-Signature': sign(JSON.stringify({ name: 'no-date' })),
    });
    expect(res2.status).toBe(400);
  });

  it('idempotency key replays the cached response without creating again', async () => {
    const body = JSON.stringify({ name: 'x', date: '2026-12-25' });
    const headers = { 'X-Timemark-Signature': sign(body), 'X-Idempotency-Key': 'idem-1' };
    // 第一次：正常创建；第二次：命中缓存
    mocks.dbQuery
      .mockResolvedValueOnce({ rows: [USER] }) // token 查询
      .mockResolvedValueOnce({ rows: [] }) // 幂等查缓存 miss
      .mockResolvedValueOnce({ rows: [] }) // 幂等写
      .mockResolvedValueOnce({ rows: [USER] }) // token 查询（第二次）
      .mockResolvedValueOnce({ rows: [{ response_body: '{"replayed":true}' }] }); // 幂等查缓存 hit
    mocks.createEvent.mockResolvedValue({ id: 1, name: 'x', date: '2026-12-25' });
    const first = await post(body, headers);
    expect(first.status).toBe(200);
    const second = await post(body, headers);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe('{"replayed":true}');
    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
  });

  it('dev (non-production) without secret still requires nothing and creates', async () => {
    mocks.dbQuery.mockResolvedValue({ rows: [NO_SECRET_USER] });
    const res = await post(JSON.stringify({ name: 'x', date: '2026-12-25' }));
    expect(res.status).toBe(200);
  });

  it('413 over the 64KB payload cap', async () => {
    const big = JSON.stringify({ name: 'x', date: '2026-12-25', pad: 'a'.repeat(70 * 1024) });
    const res = await post(big, { 'X-Timemark-Signature': sign(big) });
    expect(res.status).toBe(413);
  });
});
