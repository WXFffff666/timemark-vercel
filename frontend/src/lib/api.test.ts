import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiTransportError } from './api';

/**
 * The bug these tests lock down: a dead network used to be indistinguishable from a dead
 * session, so a tunnel, a closed laptop or a Vercel cold start logged the user out.
 *
 * Rule under test: ONLY an explicit server verdict ("this credential is over") may end a
 * session. Everything else retries and keeps the credential.
 */

const SESSION_KEY = 'timemark_session_id';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(SESSION_KEY, 'session-1');
  localStorage.setItem('accessToken', 'access-old');
  localStorage.setItem('refreshToken', 'refresh-old');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Jitter is 0 when this returns 0, so backoff sleeps are instant and the tests stay honest
  // about *whether* a retry happened rather than how long it waited.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sessionStillPresent = () => localStorage.getItem(SESSION_KEY) === 'session-1';

describe('api transport vs session failures', () => {
  it('retries a dead network and throws a retryable error instead of dropping the session', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(api.get('/events')).rejects.toBeInstanceOf(ApiTransportError);

    expect(fetchMock).toHaveBeenCalledTimes(3); // original + 2 bounded retries
    expect(sessionStillPresent()).toBe(true);
    expect(localStorage.getItem('accessToken')).toBe('access-old');
    expect(localStorage.getItem('refreshToken')).toBe('refresh-old');
  });

  it('ends the session when the server explicitly rejects the credential', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(
        json({ success: false, error: 'Invalid or expired refresh token', code: 'refresh_invalid' }, 401),
      );

    await expect(api.get('/events')).rejects.toThrow('登录已过期');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('keeps the session when refresh fails with a code nobody defined', async () => {
    // A proxy / WAF / gateway answering for the API is unknown, not a verdict.
    fetchMock
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(new Response('<html>forbidden</html>', { status: 403 }))
      .mockResolvedValueOnce(json({ success: true, data: ['event-1'] }));

    await expect(api.get('/events')).resolves.toEqual(['event-1']);
    expect(sessionStillPresent()).toBe(true);
  });

  it.each([429, 500])('keeps the session when refresh answers %i', async (status) => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ error: 'try later' }, status))
      .mockResolvedValueOnce(json({ success: true, data: 'ok' }));

    await expect(api.get('/events')).resolves.toBe('ok');
    expect(sessionStillPresent()).toBe(true);
  });

  it('shares one refresh between concurrent 401s', async () => {
    let refreshCalls = 0;
    let dataCalls = 0;

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/refresh')) {
        refreshCalls += 1;
        return json({ success: true, data: {} });
      }
      dataCalls += 1;
      if (dataCalls <= 2) return json({ error: 'Unauthorized' }, 401);
      return json({ success: true, data: 'ok' });
    });

    const results = await Promise.all([api.get('/events'), api.get('/events')]);

    expect(refreshCalls).toBe(1); // one refresh, not one per 401
    expect(results).toEqual(['ok', 'ok']);
    expect(sessionStillPresent()).toBe(true);
  });

  it('does not retry or log out on a caller abort', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValue(abort);

    await expect(api.get('/events')).rejects.toBe(abort);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStillPresent()).toBe(true);
  });
});