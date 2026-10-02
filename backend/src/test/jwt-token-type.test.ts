import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sign, verify } from 'hono/jwt';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
} from '../utils/jwt.js';

// resolveJwtSecret() throws when NODE_ENV/VERCEL is production-like and JWT_SECRET is
// missing or under 32 chars, so pin the env explicitly instead of relying on ambient state.
const JWT_SECRET = 'test-only-jwt-secret-that-is-long-enough-32';
const OTHER_SECRET = 'a-completely-different-secret-long-enough-32';
const USER_ID = '42';

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', JWT_SECRET);
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('VERCEL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// A token minted before the typ claim existed: no typ, only userId/exp.
function signLegacyToken(secret = JWT_SECRET): Promise<string> {
  return sign({ userId: USER_ID, exp: Math.floor(Date.now() / 1000) + 900 }, secret);
}

async function claimOf(token: string): Promise<Record<string, unknown>> {
  return (await verify(token, JWT_SECRET, 'HS256')) as Record<string, unknown>;
}

describe('jwt token type claim', () => {
  it('issues an access token with typ=access', async () => {
    const token = await generateAccessToken(USER_ID, 'sess-1');
    expect((await claimOf(token)).typ).toBe('access');
    expect(await verifyToken(token, undefined, 'access')).not.toBeNull();
  });

  it('issues a refresh token with typ=refresh', async () => {
    const token = await generateRefreshToken(USER_ID, 'sess-1');
    expect((await claimOf(token)).typ).toBe('refresh');
    expect(await verifyToken(token, undefined, 'refresh')).not.toBeNull();
  });

  it('verifyToken returns null when a refresh token is presented as an access token', async () => {
    const token = await generateRefreshToken(USER_ID, 'sess-1');
    expect(await verifyToken(token, undefined, 'access')).toBeNull();
  });

  it('verifyToken returns null when an access token is presented as a refresh token', async () => {
    const token = await generateAccessToken(USER_ID, 'sess-1');
    expect(await verifyToken(token, undefined, 'refresh')).toBeNull();
  });

  it('accepts a legacy token with no typ claim as an access token', async () => {
    const legacy = await signLegacyToken();
    expect((await claimOf(legacy)).typ).toBeUndefined();
    const payload = await verifyToken(legacy, undefined, 'access');
    expect(payload).not.toBeNull();
    expect(payload?.userId).toBe(USER_ID);
  });

  it('rejects a legacy token with no typ claim at the refresh endpoint', async () => {
    const legacy = await signLegacyToken();
    expect(await verifyToken(legacy, undefined, 'refresh')).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const foreign = await generateRefreshToken(USER_ID, 'sess-1', false, OTHER_SECRET);
    expect(await verifyToken(foreign, undefined, 'refresh')).toBeNull();
    expect(await verifyToken(foreign, undefined, 'access')).toBeNull();
  });

  it('verifyToken still returns null for a malformed / empty token', async () => {
    expect(await verifyToken('', undefined, 'access')).toBeNull();
    expect(await verifyToken('not-a-jwt', undefined, 'access')).toBeNull();
    expect(await verifyToken('not-a-jwt', undefined, 'refresh')).toBeNull();
  });
});
