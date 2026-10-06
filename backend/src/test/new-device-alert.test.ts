import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * v2.30：新设备登录提醒接线测试。
 * alertType 'new_device' 此前是死代码——类型定义存在但登录成功路径从未触发；
 * 现在首次指纹登录（或无历史指纹）会 fire sendSecurityAlert。
 */

const { authMocks, mockQuery, mockSendAlert } = vi.hoisted(() => ({
  authMocks: {
    verifyUserForLogin: vi.fn(),
    trackLoginFailure: vi.fn(),
    getAccountLockStatus: vi.fn(),
    clearAccountLock: vi.fn(),
    getIpBlockStatus: vi.fn(),
    checkIpWhitelistFromUser: vi.fn(),
    verifyTotpCode: vi.fn(),
    createLoginLog: vi.fn(),
    createSession: vi.fn(),
  },
  mockQuery: vi.fn(),
  mockSendAlert: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logFireAndForget: () => () => {},
}));
vi.mock('../services/auth.service.js', () => ({
  verifyUserForLogin: authMocks.verifyUserForLogin,
  getUserByUsername: vi.fn(),
  getUserById: vi.fn(),
  createLoginLog: authMocks.createLoginLog,
  trackLoginFailure: authMocks.trackLoginFailure,
  getAccountLockStatus: authMocks.getAccountLockStatus,
  clearAccountLock: authMocks.clearAccountLock,
  getIpBlockStatus: authMocks.getIpBlockStatus,
  evaluateIpBlock: vi.fn(),
  checkIpWhitelistFromUser: authMocks.checkIpWhitelistFromUser,
  verifyTotpCode: authMocks.verifyTotpCode,
  verifyUserPassword: vi.fn(),
}));
vi.mock('../services/session.service.js', () => ({
  createSession: authMocks.createSession,
  deleteSession: vi.fn(),
  deleteSessionById: vi.fn(),
  deleteAllUserSessions: vi.fn(),
  getSessionByToken: vi.fn(),
}));
vi.mock('../services/security-event.service.js', () => ({ logSecurityEvent: vi.fn(async () => {}) }));
vi.mock('../services/lunar-holidays.js', () => ({ ensureLunarHolidayEvents: vi.fn(async () => {}) }));
vi.mock('../services/alert.service.js', () => ({ sendSecurityAlert: mockSendAlert }));
vi.mock('../middleware/auth.middleware.js', () => ({ authMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()) }));
vi.mock('../middleware/rate-limit.js', () => ({
  loginRateLimit: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  authMutationRateLimit: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));
vi.mock('../utils/turnstile.js', () => ({
  isTurnstileEnabled: () => false,
  getTurnstileSiteKey: () => null,
  verifyTurnstileToken: async () => ({ ok: true }),
}));
vi.mock('../utils/client-ip.js', () => ({
  getClientIp: () => '198.51.100.9',
  getClientIpInfo: () => ({ ip: '198.51.100.9', trusted: true }),
}));
vi.mock('../utils/jwt.js', () => ({
  generateAccessToken: async () => 'access',
  generateRefreshToken: async () => 'refresh',
  verifyToken: async () => null,
}));
vi.mock('../utils/auth-cookies.js', () => ({
  setAuthCookies: vi.fn(),
  clearAuthCookies: vi.fn(),
  setAccessCookie: vi.fn(),
  setRefreshCookie: vi.fn(),
  getAccessTokenFromCookie: () => undefined,
  getRefreshTokenFromCookie: () => undefined,
  accessMaxAgeSeconds: () => 900,
  refreshMaxAgeSeconds: () => 86_400,
}));

import auth from '../routes/auth.js';

const USER = {
  id: '7',
  username: 'alice',
  avatarUrl: null,
  createdAt: '2026-01-01',
  totpEnabled: false,
  ipWhitelist: [],
  ipWhitelistEnabled: false,
  passwordChangedAt: '2026-01-01',
};

function makeApp() {
  const app = new Hono();
  app.route('/auth', auth);
  return app;
}

function loginRequest(fingerprint: string) {
  return makeApp().request('/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:5173',
      'User-Agent': 'vitest-agent',
    },
    body: JSON.stringify({ username: 'alice', password: 'whatever-hash', deviceFingerprint: fingerprint }),
  });
}

/** 等待 fire-and-forget 分支 settle（新设备告警在 Promise.all 的旁路里）。 */
async function flushAsync(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.verifyUserForLogin.mockResolvedValue(USER);
  authMocks.trackLoginFailure.mockResolvedValue({ failureCount: 0, shouldLock: false, lockMinutes: 0 });
  authMocks.getAccountLockStatus.mockResolvedValue({ locked: false, remainingSeconds: 0 });
  authMocks.clearAccountLock.mockResolvedValue(undefined);
  authMocks.checkIpWhitelistFromUser.mockReturnValue({ allowed: true });
  authMocks.getIpBlockStatus.mockResolvedValue({ blocked: false });
  authMocks.verifyTotpCode.mockResolvedValue({ valid: true });
  authMocks.createSession.mockResolvedValue({
    session: { id: 's1', expiresAt: new Date(Date.now() + 900_000) },
    accessToken: 'a',
    refreshToken: 'r',
  });
  authMocks.createLoginLog.mockResolvedValue(undefined);
  // 默认：本次指纹未见过 → 新设备
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM login_logs')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  });
});

describe('新设备登录提醒（v2.30 接线）', () => {
  it('unseen fingerprint fires new_device alert with request context', async () => {
    const res = await loginRequest('fp-new-device');
    expect(res.status).toBe(200);
    await flushAsync();
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    const arg = mockSendAlert.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.alertType).toBe('new_device');
    expect(arg.userId).toBe(7);
    expect(arg.username).toBe('alice');
    expect(arg.ip).toBe('198.51.100.9');
    expect(arg.locked).toBe(false);
  });

  it('known fingerprint does NOT alert', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM login_logs')) return { rows: [{ '?column?': 1 }] };
      return { rows: [], rowCount: 0 };
    });
    const res = await loginRequest('fp-known');
    expect(res.status).toBe(200);
    await flushAsync();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('login without deviceFingerprint skips the alert entirely', async () => {
    const res = await makeApp().request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      body: JSON.stringify({ username: 'alice', password: 'whatever-hash' }),
    });
    expect(res.status).toBe(200);
    await flushAsync();
    expect(mockSendAlert).not.toHaveBeenCalled();
    // 且不查 login_logs
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('FROM login_logs'))).toBe(false);
  });

  it('alert failure never breaks the login response', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM login_logs')) throw new Error('db down');
      return { rows: [], rowCount: 0 };
    });
    const res = await loginRequest('fp-boom');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});
