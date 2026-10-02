import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Session lifetime used to be governed by five clocks that disagreed:
 * the access cookie, the refresh cookie, the access JWT, the refresh JWT and
 * `sessions.expires_at`. This file pins the two properties that actually mattered
 * to a user:
 *
 *  1. A remembered session stays remembered. `/refresh` used to re-derive the mode
 *     from the remaining lifetime (`remaining > 24h`), so a 30-day session silently
 *     downgraded to a browser-session cookie once it had under 24h left — remember-me
 *     users were logged out on browser restart after six days.
 *  2. The refresh cookie never outlives the server-side deadline.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { SESSION_TTL } from '../utils/session-ttl.js';
import {
  accessMaxAgeSeconds,
  refreshMaxAgeSeconds,
  setRefreshCookie,
} from '../utils/auth-cookies.js';
import { generateAccessToken, generateRefreshToken, verifyToken } from '../utils/jwt.js';
import { createSession } from '../services/session.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

/** Pull `Max-Age=` out of a Set-Cookie header. Absent means a browser-session cookie. */
function maxAgeOf(setCookieHeader: string | undefined, name: string): number | null {
  if (!setCookieHeader) return null;
  const forName = setCookieHeader
    .split(/,\s*(?=[^;]+?=)/)
    .find((part) => part.trim().startsWith(`${name}=`));
  if (!forName) return null;
  const match = /Max-Age=(\d+)/i.exec(forName);
  return match ? Number(match[1]) : null;
}

/** Decode a JWT payload without verifying it. `hono/jwt` exports no decoder. */
function jwtPayload(token: string): { exp: number } {
  const segment = token.split('.')[1];
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as { exp: number };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
  // Fake Date only. `vi.useFakeTimers()` with no argument also stubs setTimeout and
  // queueMicrotask, which jose's async JWT verification awaits on -- the verification
  // never settles under full fake timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session clocks', () => {
  it('keeps a 30-day session in remember mode at T+25 days', async () => {
    const refresh = await generateRefreshToken('1', 'sess-abc', true);

    vi.setSystemTime(T0 + 25 * DAY_MS);

    // The claim survives the round trip — no reverse-derivation from remaining time.
    expect((await verifyToken(refresh, undefined, 'refresh'))?.rememberMe).toBe(true);
  });

  it('treats a refresh token with no remember_me claim as NOT remembered', async () => {
    // A token minted before the claim existed must degrade to the safe mode, never
    // silently extend a session the user did not ask to keep.
    const legacy = await generateRefreshToken('1', 'sess-abc', false);
    expect((await verifyToken(legacy, undefined, 'refresh'))?.rememberMe).toBe(false);
  });

  it('caps the refresh cookie at the session deadline, not past it', () => {
    const expiresAt = new Date(T0 + 10 * DAY_MS).toISOString();

    vi.setSystemTime(T0 + 9 * DAY_MS);
    // One day left, but the remembered budget is 30 days: the deadline wins.
    expect(refreshMaxAgeSeconds(true, expiresAt)).toBe(24 * 60 * 60);
  });

  it('never issues a negative or zero cookie lifetime', () => {
    const expired = new Date(T0 - DAY_MS).toISOString();
    expect(refreshMaxAgeSeconds(true, expired)).toBe(0);
  });

  it('gives the access cookie the same lifetime as the access JWT', async () => {
    for (const rememberMe of [false, true]) {
      const token = await generateAccessToken('1', 'sess-abc', rememberMe);
      const { exp } = jwtPayload(token);
      const jwtSeconds = exp - Math.floor(Date.now() / 1000);
      expect(accessMaxAgeSeconds(rememberMe)).toBe(jwtSeconds);
    }
  });

  it('records the mode on the refresh token it mints for a new session', async () => {
    const { refreshToken } = await createSession('1', 'device', false, true);
    expect((await verifyToken(refreshToken, undefined, 'refresh'))?.rememberMe).toBe(true);
  });

  it('issues a session cookie (no Max-Age) when the mode is not remembered', async () => {
    const app = new Hono();
    app.get('/set', (c) => {
      setRefreshCookie(c, 'rt', refreshMaxAgeSeconds(false, new Date(T0 + SESSION_TTL.sessionShortSeconds * 1000)));
      return c.text('ok');
    });

    const res = await app.request('/set');
    const header = res.headers.get('set-cookie') ?? undefined;

    // A remembered refresh cookie gets a Max-Age; a non-remembered one is capped to
    // the 8h session, which is still > 0 at T0 — so assert the two differ by mode.
    expect(maxAgeOf(header, 'timemark_refresh')).toBe(SESSION_TTL.sessionShortSeconds);
  });

  it('keeps every clock reading from the one config', () => {
    expect(SESSION_TTL.sessionShortSeconds).toBe(8 * 60 * 60);
    expect(SESSION_TTL.sessionRememberSeconds).toBe(30 * 24 * 60 * 60);
    expect(SESSION_TTL.refreshCookieSeconds).toBe(30 * 24 * 60 * 60);
    // The access JWT must not be the odd one out any more.
    expect(SESSION_TTL.accessShortSeconds).toBe(15 * 60);
    expect(SESSION_TTL.accessRememberSeconds).toBe(60 * 60);
  });
});