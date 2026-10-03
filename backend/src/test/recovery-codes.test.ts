import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TOTP recovery codes (v76) — the only way back into a single-user account whose
 * authenticator is lost. Two layers are pinned here:
 *
 *  1. the service itself: code shape (`xxxxx-xxxxx`, no easily-confused glyphs), hash-only
 *     storage, normalisation (case / hyphens / whitespace), one-time consumption, and
 *     defensive handling of corrupted rows;
 *  2. the login gate in routes/auth.ts: a deliberately failed TOTP check followed by a valid
 *     recovery code must log the user in and record a security event; an invalid code must
 *     still fail with `totp_required`.
 *
 * The db is mocked; the recovery-codes service is NOT — mocking it would mock the code
 * under test.
 */

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({ query: dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));

import {
  DEFAULT_RECOVERY_CODE_COUNT,
  MAX_RECOVERY_CODE_COUNT,
  consumeRecoveryCode,
  countRemainingRecoveryCodes,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from '../services/recovery-codes.service.js';

/** In-memory users table backing the mocked query — [hashes per user id]. */
const recoveryState = vi.hoisted(() => ({ codesByUser: new Map<number, string[]>() }));

function installDbMock() {
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT totp_recovery_codes FROM users')) {
      const hashes = recoveryState.codesByUser.get(Number(params[0]));
      return { rows: [{ totp_recovery_codes: hashes ?? [] }], rowCount: 1 };
    }
    if (sql.includes('UPDATE users SET totp_recovery_codes')) {
      recoveryState.codesByUser.set(Number(params[1]), JSON.parse(params[0] as string));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('recovery code generation', () => {
  it('generates the requested number of unique codes in the xxxxx-xxxxx format', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(DEFAULT_RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{5}-[abcdefghjkmnpqrstuvwxyz23456789]{5}$/);
    }
  });

  it('never produces easily-confused characters (l, o, 0, 1, i)', () => {
    for (let round = 0; round < 20; round += 1) {
      for (const code of generateRecoveryCodes(MAX_RECOVERY_CODE_COUNT)) {
        expect(code).not.toMatch(/[lo01i]/);
      }
    }
  });

  it('clamps the count into [1, MAX] instead of trusting the caller', () => {
    expect(generateRecoveryCodes(0)).toHaveLength(1);
    expect(generateRecoveryCodes(999)).toHaveLength(MAX_RECOVERY_CODE_COUNT);
    expect(generateRecoveryCodes(Number.NaN)).toHaveLength(DEFAULT_RECOVERY_CODE_COUNT);
  });
});

describe('normalisation and hashing', () => {
  it('makes case, hyphens and whitespace irrelevant', () => {
    const base = 'abkmx-23456';
    expect(normalizeRecoveryCode(base)).toBe('abkmx23456');
    expect(normalizeRecoveryCode('ABKMX-23456')).toBe('abkmx23456');
    expect(normalizeRecoveryCode(' abkmx 23456 ')).toBe('abkmx23456');
    expect(normalizeRecoveryCode('ABKMX23456')).toBe('abkmx23456');
  });

  it('hashes the normalised code, so differently formatted copies share one hash', () => {
    expect(hashRecoveryCode('abkmx-23456')).toBe(hashRecoveryCode('ABKMX 23456'));
    expect(hashRecoveryCode('abkmx-23456')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('consumeRecoveryCode (mocked db)', () => {
  beforeEach(() => {
    dbQuery.mockReset();
    recoveryState.codesByUser.clear();
    installDbMock();
  });

  it('accepts a valid code regardless of formatting, and removes it after use', async () => {
    const [code] = generateRecoveryCodes(1);
    await import('../services/recovery-codes.service.js').then((m) => m.replaceRecoveryCodes(1, [code]));

    await expect(consumeRecoveryCode(1, code.toUpperCase())).resolves.toBe(true);
    await expect(countRemainingRecoveryCodes(1)).resolves.toBe(0);

    // One-time: the same code must not work twice.
    await expect(consumeRecoveryCode(1, code)).resolves.toBe(false);
  });

  it('returns false for an unknown code without touching storage', async () => {
    await import('../services/recovery-codes.service.js').then((m) =>
      m.replaceRecoveryCodes(1, generateRecoveryCodes(3)),
    );
    const before = await countRemainingRecoveryCodes(1);

    await expect(consumeRecoveryCode(1, 'zzzzz-zzzzz')).resolves.toBe(false);
    await expect(countRemainingRecoveryCodes(1)).resolves.toBe(before);
  });

  it('returns false (never throws) on an empty, string, or corrupted stored column', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT totp_recovery_codes')) return { rows: [{ totp_recovery_codes: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(consumeRecoveryCode(2, 'abkmx-23456')).resolves.toBe(false);

    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT totp_recovery_codes')) return { rows: [{ totp_recovery_codes: 'not-json' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(consumeRecoveryCode(2, 'abkmx-23456')).resolves.toBe(false);

    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT totp_recovery_codes')) return { rows: [{ totp_recovery_codes: { broken: true } }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(consumeRecoveryCode(2, 'abkmx-23456')).resolves.toBe(false);

    await expect(consumeRecoveryCode(2, '')).resolves.toBe(false);
  });
});

// ============ Login gate integration ============

const authMocks = vi.hoisted(() => ({
  verifyUserForLogin: vi.fn(),
  verifyTotpCode: vi.fn(),
  checkIpWhitelistFromUser: vi.fn(),
  getIpBlockStatus: vi.fn(),
  getAccountLockStatus: vi.fn(),
  trackLoginFailure: vi.fn(),
  clearAccountLock: vi.fn(),
  createLoginLog: vi.fn(),
  createSession: vi.fn(),
  securityEvents: [] as string[],
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

vi.mock('../services/security-event.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/security-event.service.js')>();
  return {
    ...actual,
    logSecurityEvent: async (params: { eventType: string }) => {
      authMocks.securityEvents.push(params.eventType);
    },
  };
});

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
  getClientIp: () => '127.0.0.1',
  getClientIpInfo: () => ({ ip: '127.0.0.1', trusted: true }),
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
vi.mock('../services/lunar-holidays.js', () => ({ ensureLunarHolidayEvents: vi.fn(async () => {}) }));
vi.mock('../services/alert.service.js', () => ({ sendSecurityAlert: vi.fn() }));

import auth from '../routes/auth.js';
import { Hono } from 'hono';
import { replaceRecoveryCodes } from '../services/recovery-codes.service.js';

const TOTP_USER = {
  id: '7',
  username: 'alice',
  avatarUrl: null,
  createdAt: '2026-01-01',
  totpEnabled: true,
  totpSecret: 'SECRET',
  ipWhitelist: [],
  ipWhitelistEnabled: false,
  passwordChangedAt: '2026-01-01',
};

function loginWithCode(code: string) {
  const app = new Hono();
  app.route('/api/auth', auth);
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'correct-horse-1', totpCode: code }),
  });
}

describe('POST /api/auth/login with recovery codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.securityEvents.length = 0;
    recoveryState.codesByUser.clear();
    installDbMock();

    authMocks.verifyUserForLogin.mockResolvedValue({ ...TOTP_USER });
    // The TOTP check deliberately fails — that is the scenario recovery codes exist for.
    authMocks.verifyTotpCode.mockReturnValue(false);
    authMocks.checkIpWhitelistFromUser.mockReturnValue({ allowed: true });
    authMocks.getIpBlockStatus.mockResolvedValue({ isBlocked: false });
    authMocks.getAccountLockStatus.mockResolvedValue({ isLocked: false });
    authMocks.trackLoginFailure.mockResolvedValue({ shouldLock: false, failureCount: 0, lockMinutes: 0 });
    authMocks.createSession.mockResolvedValue({
      session: { id: 1, expiresAt: new Date(Date.now() + 86_400_000) },
      accessToken: 'access',
      refreshToken: 'refresh',
    });
  });

  it('logs the user in with a valid recovery code when TOTP fails, and records the event', async () => {
    const [code] = generateRecoveryCodes(1);
    await replaceRecoveryCodes(7, [code]);

    const res = await loginWithCode(code);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    expect(authMocks.securityEvents).toContain('totp_recovery_code_used');
    // Consumed: a replay of the same login must now fail.
    const replay = await loginWithCode(code);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { code: string }).code).toBe('totp_required');
  });

  it('accepts a sloppily formatted recovery code (case / whitespace / missing hyphen)', async () => {
    const [code] = generateRecoveryCodes(1);
    await replaceRecoveryCodes(7, [code]);

    const res = await loginWithCode(` ${code.toUpperCase().replace('-', '')} `);
    expect(res.status).toBe(200);
  });

  it('still returns 401 totp_required for an invalid code, without consuming anything', async () => {
    await replaceRecoveryCodes(7, generateRecoveryCodes(3));
    const before = await countRemainingRecoveryCodes(7);

    const res = await loginWithCode('zzzzz-zzzzz');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('totp_required');
    expect(await countRemainingRecoveryCodes(7)).toBe(before);
    expect(authMocks.securityEvents).not.toContain('totp_recovery_code_used');
  });
});
