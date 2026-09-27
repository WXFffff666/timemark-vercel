import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 84 acceptance — /api/push routes.
 *
 * - `GET /vapid-key` serves the canonical PUSH_VAPID_PUBLIC_KEY; 501 when unset.
 * - `POST /subscribe` validates the body (missing endpoint, non-URL, 10 KB
 *   endpoint) and upserts with bound parameters.
 * - `DELETE /unsubscribe` (canonical) + `POST /unsubscribe` (legacy alias) are
 *   idempotent — a subscription that never existed still returns success.
 * - `POST /test` asserts `web-push.sendNotification` is called with the STORED
 *   subscription and that VAPID details are configured from env.
 * - A 410 (or 404) from the push service DELETES the subscription row and
 *   reports it as `removed` — it is never retried.
 * - Legacy `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` names are still honored.
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery, sendNotification, setVapidDetails } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: {
    sendNotification,
    setVapidDetails,
    generateVAPIDKeys: vi.fn(),
  },
}));

vi.mock('../middleware/auth.middleware.js', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: unknown) => void; json: (body: unknown, status?: number) => Response },
    next: () => Promise<void>,
  ) => {
    if (authState.user) {
      c.set('user', authState.user);
      return next();
    }
    return c.json({ success: false, error: '未授权' }, 401);
  },
}));

import pushRoutes from '../routes/push.js';

const USER = { id: 7, username: 'alice' };

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];
let subscriptions: Array<Record<string, unknown>>;

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/e2e-endpoint-abc';

function installDb(): void {
  captured = [];
  subscriptions = [];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    if (sql.includes('INSERT INTO push_subscriptions')) {
      const [userId, endpoint, p256dh, auth] = params as [number, string, string, string];
      const existing = subscriptions.find(
        (row) => row.user_id === userId && row.endpoint === endpoint,
      );
      if (existing) {
        existing.keys_p256dh = p256dh;
        existing.keys_auth = auth;
      } else {
        subscriptions.push({
          id: subscriptions.length + 1,
          user_id: userId,
          endpoint,
          keys_p256dh: p256dh,
          keys_auth: auth,
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions')) {
      const [userId] = params as [number];
      return { rows: subscriptions.filter((row) => row.user_id === userId), rowCount: 0 };
    }
    if (sql.includes('DELETE FROM push_subscriptions')) {
      const [userId, endpoint] = params as [number, string];
      const before = subscriptions.length;
      subscriptions = subscriptions.filter(
        (row) => !(row.user_id === userId && row.endpoint === endpoint),
      );
      return { rows: [], rowCount: before - subscriptions.length };
    }
    throw new Error(`push-routes test fake: unexpected query: ${sql}`);
  });
}

async function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await pushRoutes.request(path, init);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

function setVapidEnv(canonical = true): void {
  if (canonical) {
    process.env.PUSH_VAPID_PUBLIC_KEY = 'e2e-vapid-public';
    process.env.PUSH_VAPID_PRIVATE_KEY = 'e2e-vapid-private';
    process.env.PUSH_VAPID_SUBJECT = 'mailto:push@timemark.example';
  } else {
    process.env.VAPID_PUBLIC_KEY = 'legacy-vapid-public';
    process.env.VAPID_PRIVATE_KEY = 'legacy-vapid-private';
  }
}

describe('push routes (checkbox 84)', () => {
  beforeEach(() => {
    authState.user = USER;
    installDb();
    sendNotification.mockReset();
    setVapidDetails.mockReset();
    delete process.env.PUSH_VAPID_PUBLIC_KEY;
    delete process.env.PUSH_VAPID_PRIVATE_KEY;
    delete process.env.PUSH_VAPID_SUBJECT;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    setVapidEnv();
  });

  afterEach(() => {
    delete process.env.PUSH_VAPID_PUBLIC_KEY;
    delete process.env.PUSH_VAPID_PRIVATE_KEY;
    delete process.env.PUSH_VAPID_SUBJECT;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  it('requires authentication', async () => {
    authState.user = null;
    const res = await request('GET', '/vapid-key');
    expect(res.status).toBe(401);
  });

  it('GET /vapid-key serves the canonical PUSH_VAPID_PUBLIC_KEY', async () => {
    const res = await request('GET', '/vapid-key');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { publicKey: 'e2e-vapid-public' } });
  });

  it('GET /vapid-key fails open (501) when VAPID is not configured', async () => {
    delete process.env.PUSH_VAPID_PUBLIC_KEY;
    delete process.env.PUSH_VAPID_PRIVATE_KEY;
    const res = await request('GET', '/vapid-key');
    expect(res.status).toBe(501);
    expect(res.body.success).toBe(false);
  });

  it('POST /subscribe stores the subscription with bound parameters', async () => {
    const res = await request('POST', '/subscribe', {
      endpoint: ENDPOINT,
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      user_id: USER.id,
      endpoint: ENDPOINT,
      keys_p256dh: 'p256dh-value',
      keys_auth: 'auth-value',
    });
    const insert = captured.find((entry) => entry.sql.includes('INSERT INTO push_subscriptions'));
    expect(insert?.params).toEqual([USER.id, ENDPOINT, 'p256dh-value', 'auth-value']);
  });

  it('POST /subscribe upserts on conflict instead of duplicating', async () => {
    await request('POST', '/subscribe', { endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'b' } });
    await request('POST', '/subscribe', { endpoint: ENDPOINT, keys: { p256dh: 'c', auth: 'd' } });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({ keys_p256dh: 'c', keys_auth: 'd' });
  });

  it('POST /subscribe rejects a missing endpoint with 400', async () => {
    const res = await request('POST', '/subscribe', { keys: { p256dh: 'a', auth: 'b' } });
    expect(res.status).toBe(400);
    expect(subscriptions).toHaveLength(0);
  });

  it('POST /subscribe rejects a non-URL endpoint with 400', async () => {
    const res = await request('POST', '/subscribe', { endpoint: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(subscriptions).toHaveLength(0);
  });

  it('POST /subscribe rejects an oversized (10 KB) endpoint with 400', async () => {
    const res = await request('POST', '/subscribe', {
      endpoint: `https://push.example.com/${'x'.repeat(10 * 1024)}`,
    });
    expect(res.status).toBe(400);
    expect(subscriptions).toHaveLength(0);
  });

  it('POST /subscribe rejects a non-JSON body with 400', async () => {
    const res = await request('POST', '/subscribe', 'not json at all');
    expect(res.status).toBe(400);
  });

  it('DELETE /unsubscribe removes the row and is idempotent for unknown endpoints', async () => {
    await request('POST', '/subscribe', { endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'b' } });

    const removed = await request('DELETE', '/unsubscribe', { endpoint: ENDPOINT });
    expect(removed.status).toBe(200);
    expect(subscriptions).toHaveLength(0);

    const again = await request('DELETE', '/unsubscribe', { endpoint: ENDPOINT });
    expect(again.status).toBe(200);
    expect(again.body.success).toBe(true);

    const unknown = await request('DELETE', '/unsubscribe', {
      endpoint: 'https://push.example.com/never-existed',
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body.success).toBe(true);
    const deletes = captured.filter((entry) => entry.sql.includes('DELETE FROM push_subscriptions'));
    expect(deletes[deletes.length - 1]?.params).toEqual([
      USER.id,
      'https://push.example.com/never-existed',
    ]);
  });

  it('POST /unsubscribe stays as a legacy alias of DELETE', async () => {
    await request('POST', '/subscribe', { endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'b' } });
    const res = await request('POST', '/unsubscribe', { endpoint: ENDPOINT });
    expect(res.status).toBe(200);
    expect(subscriptions).toHaveLength(0);
  });

  it('POST /test returns 400 when the user has no stored subscriptions', async () => {
    const res = await request('POST', '/test');
    expect(res.status).toBe(400);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('POST /test returns 501 when VAPID is missing (fail open, no send)', async () => {
    delete process.env.PUSH_VAPID_PUBLIC_KEY;
    delete process.env.PUSH_VAPID_PRIVATE_KEY;
    await request('POST', '/subscribe', { endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'b' } });
    // subscribe is still allowed; sending is not.
    const res = await request('POST', '/test');
    expect(res.status).toBe(501);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('POST /test calls sendNotification with the STORED subscription and the VAPID keys', async () => {
    await request('POST', '/subscribe', {
      endpoint: ENDPOINT,
      keys: { p256dh: 'stored-p256dh', auth: 'stored-auth' },
    });
    sendNotification.mockResolvedValue({ statusCode: 201 });

    const res = await request('POST', '/test');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { sent: 1, removed: 0, failed: 0 } });
    expect(setVapidDetails).toHaveBeenCalledWith(
      'mailto:push@timemark.example',
      'e2e-vapid-public',
      'e2e-vapid-private',
    );
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [subscription, payload] = sendNotification.mock.calls[0] as [Record<string, unknown>, string];
    expect(subscription).toEqual({
      endpoint: ENDPOINT,
      keys: { p256dh: 'stored-p256dh', auth: 'stored-auth' },
    });
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.title).toBe('TimeMark 测试通知');
    expect(parsed.body).toBe('这是一条测试推送通知');
    expect(parsed.url).toBe('/reminders');
  });

  it('honors the legacy VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY names', async () => {
    delete process.env.PUSH_VAPID_PUBLIC_KEY;
    delete process.env.PUSH_VAPID_PRIVATE_KEY;
    delete process.env.PUSH_VAPID_SUBJECT;
    setVapidEnv(false);

    await request('POST', '/subscribe', { endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'b' } });
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const res = await request('POST', '/test');

    expect(res.status).toBe(200);
    expect(setVapidDetails).toHaveBeenCalledWith(
      'mailto:admin@timemark.app',
      'legacy-vapid-public',
      'legacy-vapid-private',
    );
  });

  it('DELETES an expired (410) subscription and does not treat it as a failure', async () => {
    await request('POST', '/subscribe', { endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'b' } });
    sendNotification.mockRejectedValue(Object.assign(new Error('Subscription expired'), { statusCode: 410 }));

    const res = await request('POST', '/test');

    // The row is gone and the response reports it as removed, not failed.
    expect(subscriptions).toHaveLength(0);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { sent: 0, removed: 1, failed: 0 } });
    const deletes = captured.filter((entry) => entry.sql.includes('DELETE FROM push_subscriptions'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.params).toEqual([USER.id, ENDPOINT]);
  });

  it('DELETES a 404 subscription as well', async () => {
    await request('POST', '/subscribe', { endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'b' } });
    sendNotification.mockRejectedValue(Object.assign(new Error('Not found'), { statusCode: 404 }));

    const res = await request('POST', '/test');

    expect(subscriptions).toHaveLength(0);
    expect(res.body).toMatchObject({ success: true, data: { sent: 0, removed: 1, failed: 0 } });
  });

  it('keeps a transient (500) subscription and reports the failure', async () => {
    await request('POST', '/subscribe', { endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'b' } });
    sendNotification.mockRejectedValue(Object.assign(new Error('push service outage'), { statusCode: 500 }));

    const res = await request('POST', '/test');

    expect(subscriptions).toHaveLength(1);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ success: false, data: { sent: 0, removed: 0, failed: 1 } });
  });
});
