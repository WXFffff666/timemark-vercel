import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * v2.31/v2.32 R12（审计 Q2-3）：webauthn 路由级测试。
 * 覆盖无需浏览器环境的面：/supported 配置暴露、credentials 鉴权、
 * login/options 的防枚举语义（未知用户与无 Passkey 同文案）。
 * WebAuthn ceremony 本体（register/verify 的加密验证）留给端到端。
 */

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  listUserPasskeys: vi.fn(),
  createRegistrationOptions: vi.fn(),
  deletePasskey: vi.fn(),
  userHasPasskeys: vi.fn(),
  createAuthenticationOptions: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ query: mocks.dbQuery }));
vi.mock('../services/webauthn.service.js', () => ({
  listUserPasskeys: mocks.listUserPasskeys,
  createRegistrationOptions: mocks.createRegistrationOptions,
  verifyRegistration: vi.fn(),
  deletePasskey: mocks.deletePasskey,
  userHasPasskeys: mocks.userHasPasskeys,
  createAuthenticationOptions: mocks.createAuthenticationOptions,
}));
vi.mock('../middleware/auth.middleware.js', () => ({
  authMiddleware: (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', { id: '7', username: 'alice' });
    return next();
  },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  loginRateLimit: (_c: unknown, next: () => Promise<void>) => next(),
  authMutationRateLimit: (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../utils/turnstile.js', () => ({
  verifyTurnstileToken: async () => ({ ok: true, skipped: true }),
}));
vi.mock('../utils/client-ip.js', () => ({
  getClientIp: () => '127.0.0.1',
  getClientIpInfo: () => ({ ip: '127.0.0.1', trusted: true }),
}));
vi.mock('../services/security-event.service.js', () => ({ logSecurityEvent: vi.fn(async () => {}) }));
vi.mock('../services/auth.service.js', () => ({
  checkIpWhitelist: vi.fn(),
  verifyTotpCode: vi.fn(),
  createLoginLog: vi.fn(),
}));
vi.mock('../utils/webauthn-config.js', () => ({
  getWebAuthnConfig: () => ({ rpID: 'localhost', origin: 'http://localhost:5189' }),
}));

import webauthnRoutes from '../routes/webauthn.js';

function app() {
  const h = new Hono();
  h.route('/webauthn', webauthnRoutes);
  return h;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.listUserPasskeys.mockResolvedValue([]);
  mocks.dbQuery.mockResolvedValue({ rows: [] });
});

describe('webauthn /supported', () => {
  it('exposes rpID/origin and supported flag', async () => {
    const res = await app().request('/webauthn/supported');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { rpID: string; supported: boolean } };
    expect(body.data.rpID).toBe('localhost');
    expect(body.data.supported).toBe(true);
  });
});

describe('webauthn /credentials (session-protected)', () => {
  it('lists the user passkeys', async () => {
    mocks.listUserPasskeys.mockResolvedValue([{ id: 'cred-1', deviceName: 'MacBook' }]);
    const res = await app().request('/webauthn/credentials');
    expect(res.status).toBe(200);
    expect(mocks.listUserPasskeys).toHaveBeenCalledWith(7);
  });

  it('404 when deleting a passkey that is not yours', async () => {
    mocks.deletePasskey.mockResolvedValue(false);
    const res = await app().request('/webauthn/credentials/cred-x', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(mocks.dbQuery).not.toHaveBeenCalled();
  });
});

describe('webauthn /login/options — 防枚举语义', () => {
  it('400 when username missing', async () => {
    const res = await app().request('/webauthn/login/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('unknown username and known-username-without-passkey return the SAME 401 message (no enumeration)', async () => {
    // 未知用户
    mocks.dbQuery.mockResolvedValueOnce({ rows: [] });
    const res1 = await app().request('/webauthn/login/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ghost' }),
    });
    expect(res1.status).toBe(401);
    // 已知用户但没有 Passkey
    mocks.dbQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    mocks.userHasPasskeys.mockResolvedValueOnce(false);
    const res2 = await app().request('/webauthn/login/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice' }),
    });
    expect(res2.status).toBe(401);
    const body1 = (await res1.json()) as { error?: string };
    const body2 = (await res2.json()) as { error?: string };
    expect(body1.error).toBe(body2.error);
  });

  it('known user with passkeys gets authentication options', async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    mocks.userHasPasskeys.mockResolvedValueOnce(true);
    mocks.createAuthenticationOptions.mockResolvedValue({ challenge: 'abc' });
    const res = await app().request('/webauthn/login/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice' }),
    });
    expect(res.status).toBe(200);
    expect(mocks.createAuthenticationOptions).toHaveBeenCalledWith(7, expect.objectContaining({ rpID: 'localhost' }));
  });
});
