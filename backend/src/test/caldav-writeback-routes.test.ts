import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 86 route contracts:
 *  - `GET /api/cron/caldav-sync` keeps the existing read-only result (`synced`) and
 *    adds the opt-in write-back stats; a write-back failure never hides the read result.
 *  - `GET/POST /api/calendar/caldav-writeback` is the per-user toggle (default OFF),
 *    validates the collection URL through the SSRF guard and never writes on error.
 */

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  authState: { user: { id: 7, username: 'admin' } as { id: number; username: string } | null },
  syncAllCalDavSubscriptions: vi.fn(),
  syncCalDavWriteBack: vi.fn(),
  isSafePublicUrl: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ query: mocks.dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));
vi.mock('../services/caldav-sync.service.js', () => ({
  syncAllCalDavSubscriptions: mocks.syncAllCalDavSubscriptions,
  syncCalDavWriteBack: mocks.syncCalDavWriteBack,
}));
vi.mock('../utils/url-safety.js', () => ({ isSafePublicUrl: mocks.isSafePublicUrl }));
vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  return {
    authMiddleware: async (
      c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => Response },
      next: () => Promise<void>,
    ) => {
      if (mocks.authState.user) {
        c.set('user', mocks.authState.user);
        return next();
      }
      return actual.authMiddleware(c as never, next as never);
    },
  };
});

import cronRoutes from '../routes/cron.js';
import calendarRoutes from '../routes/calendar.js';

const CRON_SECRET = 'caldav-writeback-test-secret';

function writeBackStats(overrides: Record<string, unknown> = {}) {
  return {
    users: 1,
    created: 2,
    updated: 1,
    deleted: 0,
    skipped: 3,
    failed: 0,
    loopGuardSkips: 1,
    errors: [],
    ...overrides,
  };
}

beforeEach(() => {
  process.env.CRONSECRET = CRON_SECRET;
  delete process.env.CRON_SECRET;
  delete process.env.CRON_ALLOWED_IPS;
  mocks.authState.user = { id: 7, username: 'admin' };
  mocks.dbQuery.mockReset();
  mocks.dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.syncAllCalDavSubscriptions.mockReset();
  mocks.syncAllCalDavSubscriptions.mockResolvedValue({ synced: 3 });
  mocks.syncCalDavWriteBack.mockReset();
  mocks.syncCalDavWriteBack.mockResolvedValue(writeBackStats());
  mocks.isSafePublicUrl.mockReset();
  mocks.isSafePublicUrl.mockResolvedValue({ safe: true });
});

describe('GET /api/cron/caldav-sync', () => {
  it('rejects an unauthenticated call and never runs either sync', async () => {
    const res = await cronRoutes.request('/caldav-sync');

    expect(res.status).toBe(401);
    expect(mocks.syncAllCalDavSubscriptions).not.toHaveBeenCalled();
    expect(mocks.syncCalDavWriteBack).not.toHaveBeenCalled();
  });

  it('runs the read-only sync AND the write-back in the same invocation', async () => {
    const res = await cronRoutes.request('/caldav-sync', {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      job: string;
      synced: number;
      writeBack: { created: number; loopGuardSkips: number };
    };

    expect(body.success).toBe(true);
    expect(body.job).toBe('caldav-sync');
    expect(body.synced).toBe(3);
    expect(body.writeBack.created).toBe(2);
    expect(body.writeBack.loopGuardSkips).toBe(1);
    expect(mocks.syncAllCalDavSubscriptions).toHaveBeenCalledTimes(1);
    expect(mocks.syncCalDavWriteBack).toHaveBeenCalledTimes(1);
  });

  it('still reports the read-only result when write-back throws', async () => {
    mocks.syncCalDavWriteBack.mockRejectedValue(new Error('caldav_writeback_objects missing'));

    const res = await cronRoutes.request('/caldav-sync', {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { synced: number; writeBack: { error: string } };
    expect(body.synced).toBe(3);
    expect(body.writeBack.error).toContain('caldav_writeback_objects missing');
  });
});

describe('GET/POST /api/calendar/caldav-writeback', () => {
  it('GET reports the default OFF state when no config row exists', async () => {
    const res = await calendarRoutes.request('/caldav-writeback');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { enabled: boolean; url: string | null; hasCredentials: boolean } };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ enabled: false, url: null, hasCredentials: false });
  });

  it('POST rejects a non-boolean enabled value with 400 and no write', async () => {
    const res = await calendarRoutes.request('/caldav-writeback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });

    expect(res.status).toBe(400);
    expect(
      mocks.dbQuery.mock.calls.filter(([sql]) => (sql as string).startsWith('INSERT INTO user_configs')),
    ).toHaveLength(0);
  });

  it('POST refuses to enable without a collection URL', async () => {
    const res = await calendarRoutes.request('/caldav-writeback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ success: false, error: '启用回写前请先配置 CalDAV 日历集合 URL' });
  });

  it('POST enables the toggle with a safe URL and persists both fields', async () => {
    const res = await calendarRoutes.request('/caldav-writeback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, url: 'https://dav.example.com/cal/' }),
    });

    expect(res.status).toBe(200);
    const insert = mocks.dbQuery.mock.calls.find(([sql]) => (sql as string).startsWith('INSERT INTO user_configs'));
    expect(insert?.[1]).toEqual([7, true, 'https://dav.example.com/cal/']);
    expect(mocks.isSafePublicUrl).toHaveBeenCalledWith('https://dav.example.com/cal/');
  });

  it('POST rejects an unsafe collection URL with 400 and no write', async () => {
    mocks.isSafePublicUrl.mockResolvedValue({ safe: false, reason: 'Private IP blocked' });

    const res = await calendarRoutes.request('/caldav-writeback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, url: 'http://127.0.0.1:5232/cal/' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ success: false, error: 'Private IP blocked' });
    expect(
      mocks.dbQuery.mock.calls.filter(([sql]) => (sql as string).startsWith('INSERT INTO user_configs')),
    ).toHaveLength(0);
  });

  it('POST can switch the toggle OFF again', async () => {
    mocks.dbQuery.mockResolvedValueOnce({
      rows: [{ caldav_writeback_enabled: true, caldav_writeback_url: 'https://dav.example.com/cal/' }],
      rowCount: 1,
    });

    const res = await calendarRoutes.request('/caldav-writeback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    const insert = mocks.dbQuery.mock.calls.find(([sql]) => (sql as string).startsWith('INSERT INTO user_configs'));
    expect(insert?.[1]).toEqual([7, false, 'https://dav.example.com/cal/']);
  });
});
