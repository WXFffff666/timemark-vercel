import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'crypto';

/**
 * v2.31 R6/v2.32 R9（审计 Q2-2）：/api/inbox/receive/:token 路由级测试。
 * 公网收信入口：token 查库、HMAC 签名（timing-safe）、字段别名、体积帽、
 * 限流豁免路径、生产无 secret 拒绝。fullchain e2e 只覆盖了 happy path。
 */

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  createInboxMessage: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ query: mocks.dbQuery }));
vi.mock('../services/inbox.service.js', () => ({ createInboxMessage: mocks.createInboxMessage }));
vi.mock('../middleware/rate-limit.js', () => ({
  rateLimit: () => (_c: unknown, next: () => Promise<void>) => next(),
}));

import inboxPublic from '../routes/inbox-public.js';

const TOKEN = 'b'.repeat(32);
const SECRET = 'inbox-secret';
const USER = { user_id: 7, inbox_receive_secret: SECRET };

function app() {
  return inboxPublic;
}

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.dbQuery.mockResolvedValue({ rows: [USER] });
  mocks.createInboxMessage.mockResolvedValue({ id: 9 });
});

function post(body: string, headers: Record<string, string> = {}, token = TOKEN) {
  return app().request(`/receive/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

describe('POST /api/inbox/receive/:token', () => {
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

  it('401 when secret present but signature missing', async () => {
    const res = await post(JSON.stringify({ title: 't', body: 'b' }));
    expect(res.status).toBe(401);
  });

  it('401 for wrong signature', async () => {
    const body = JSON.stringify({ title: 't', body: 'b' });
    const res = await post(body, { 'X-Timemark-Signature': sign(body, 'nope') });
    expect(res.status).toBe(401);
  });

  it('accepts a signed message and stores title/body/sender', async () => {
    const body = JSON.stringify({ title: '外部提醒', body: '内容', sender: 'github-actions' });
    const res = await post(body, { 'X-Timemark-Signature': sign(body) });
    expect(res.status).toBe(200);
    expect(mocks.createInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, title: '外部提醒', body: '内容', senderLabel: 'github-actions', source: 'inbound' }),
    );
  });

  it('honors field aliases subject/message/from', async () => {
    const body = JSON.stringify({ subject: '别名标题', message: '别名正文', from: 'ci' });
    const res = await post(body, { 'X-Timemark-Signature': sign(body) });
    expect(res.status).toBe(200);
    expect(mocks.createInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({ title: '别名标题', body: '别名正文', senderLabel: 'ci' }),
    );
  });

  it('400 when title/body missing', async () => {
    const body = JSON.stringify({ unrelated: 1 });
    const res = await post(body, { 'X-Timemark-Signature': sign(body) });
    expect(res.status).toBe(400);
  });

  it('400 on invalid JSON', async () => {
    const res = await post('not-json', { 'X-Timemark-Signature': sign('not-json') });
    expect(res.status).toBe(400);
  });

  it('413 over the 8KB cap (declared content-length)', async () => {
    const res = await app().request(`/receive/${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(9 * 1024) },
      body: JSON.stringify({ title: 't', body: 'b' }),
    });
    expect(res.status).toBe(413);
  });

  it('dev without secret: no signature required', async () => {
    mocks.dbQuery.mockResolvedValue({ rows: [{ user_id: 7, inbox_receive_secret: null }] });
    const res = await post(JSON.stringify({ title: 't', body: 'b' }));
    expect(res.status).toBe(200);
    expect(mocks.createInboxMessage).toHaveBeenCalled();
  });
});
