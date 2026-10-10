import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { csrfProtection } from '../middleware/csrf.js';

/**
 * v2.31 R1（安全审计 S1）：/api/v1 REST API 与 MCP 共用 tmt_ token，
 * 标准非浏览器客户端（curl/SDK）不带 Origin 也没有 X-Requested-With——
 * 写端点此前被 CSRF 403 拦死。豁免条件：路径匹配 + Bearer tmt_ 同时满足。
 */
function app() {
  const h = new Hono();
  h.use('*', csrfProtection());
  h.post('/api/v1/events', (c) => c.json({ ok: true }));
  h.post('/api/mcp', (c) => c.json({ ok: true }));
  h.post('/api/events', (c) => c.json({ ok: true }));
  return h;
}

describe('CSRF Bearer tmt_ exemptions', () => {
  it('POST /api/v1/* with tmt_ Bearer passes without Origin (non-browser client)', async () => {
    const res = await app().request('/api/v1/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer tmt_abc123' },
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/mcp with tmt_ Bearer still passes (existing behavior)', async () => {
    const res = await app().request('/api/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer tmt_abc123' },
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/v1 with a NON-tmt_ Bearer is still CSRF-blocked without Origin', async () => {
    const res = await app().request('/api/v1/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer some-session-token' },
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/events (non-exempt path) with tmt_ Bearer still requires Origin', async () => {
    const res = await app().request('/api/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer tmt_abc123' },
    });
    expect(res.status).toBe(403);
  });
});
