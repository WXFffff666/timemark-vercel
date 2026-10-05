/**
 * Route-level tests for /api/greetings (v2.25 生日祝福).
 *
 * Contract pinned here:
 *  - settings: default auto+AI, POST validates enums and persists;
 *  - preview: only contacts inside the MM-DD window are listed, opted-out included
 *    but flagged, deterministic composer content attached;
 *  - send-draft: claim-based idempotency (409 when the year was already handled),
 *    history updated to 'sent', whitelisted recipients only;
 *  - discard-draft only removes status='draft' rows owned by the caller.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendContactEmail: vi.fn(),
  getNotificationAccounts: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  query: mocks.query,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      if (authState.user) {
        c.set('user', authState.user);
        return next();
      }
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(c, next);
    },
  };
});

vi.mock('../services/contact-send.service.js', () => ({
  sendContactEmail: mocks.sendContactEmail,
}));

vi.mock('../services/config.service.js', () => ({
  getNotificationAccounts: mocks.getNotificationAccounts,
}));

import greetingsRoutes from '../routes/greetings.js';

const USER = { id: 7, username: 'alice' };

/** 明天 MM-DD（本地时区）——让预演窗口稳定命中 */
function tomorrowMonthDay(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = USER;
  mocks.getNotificationAccounts.mockResolvedValue([{ type: 'resend', is_active: true }]);
});

describe('GET /greetings/settings', () => {
  it('returns defaults when user_configs row is missing', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const res = await greetingsRoutes.request('/settings');
    const body = await res.json() as { data: { greetingMode: string; greetingAiEnabled: boolean } };
    expect(body.data.greetingMode).toBe('auto');
    expect(body.data.greetingAiEnabled).toBe(true);
  });
});

describe('POST /greetings/settings', () => {
  it('persists mode and ai toggle', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await greetingsRoutes.request('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ greetingMode: 'draft', greetingAiEnabled: false }),
    });
    expect(res.status).toBe(200);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain('greeting_mode');
    expect(params).toEqual([USER.id, 'draft', false]);
  });

  it('rejects an invalid mode', async () => {
    const res = await greetingsRoutes.request('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ greetingMode: 'yolo', greetingAiEnabled: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /greetings/preview', () => {
  it('lists only contacts whose MM-DD falls inside the window, with deterministic composer preview', async () => {
    const md = tomorrowMonthDay();
    mocks.query
      .mockResolvedValueOnce({ rows: [{ greeting_mode: 'auto', greeting_ai_enabled: false, timezone: 'Asia/Shanghai' }] }) // prefs first
      .mockResolvedValueOnce({
        rows: [
          { id: 11, user_id: USER.id, contact_id: 3, date: `2000-${md}`, calendar_type: 'gregorian', lunar_date: null, birth_date_lunar: null, name: '妈妈', nickname: '老妈', relationship: '父母', notes: '', gender: 'female', greeting_opt_out: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await greetingsRoutes.request('/preview?days=30');
    const body = await res.json() as { data: { rows: Array<{ contactId: number; daysUntil: number; optedOut: boolean; preview: { subject: string } }> } };
    expect(body.data.rows.length).toBe(1);
    expect(body.data.rows[0]!.contactId).toBe(3);
    expect(body.data.rows[0]!.daysUntil).toBe(1);
    expect(body.data.rows[0]!.preview.subject).toContain('生日快乐');
  });

  it('excludes contacts outside the window and includes opted-out with a flag', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ greeting_mode: 'auto', greeting_ai_enabled: false, timezone: 'Asia/Shanghai' }] }) // prefs first
      .mockResolvedValueOnce({
        rows: [
          { id: 12, user_id: USER.id, contact_id: 4, date: `1990-01-01`, calendar_type: 'gregorian', lunar_date: null, birth_date_lunar: null, name: '远期', nickname: null, relationship: null, notes: null, gender: 'unknown', greeting_opt_out: false },
          { id: 13, user_id: USER.id, contact_id: 5, date: `2000-${tomorrowMonthDay()}`, calendar_type: 'gregorian', lunar_date: null, birth_date_lunar: null, name: '退订哥', nickname: null, relationship: null, notes: null, gender: 'male', greeting_opt_out: true },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await greetingsRoutes.request('/preview?days=30');
    const body = await res.json() as { data: { rows: Array<{ contactId: number; optedOut: boolean }> } };
    expect(body.data.rows.map((r) => r.contactId)).toEqual([5]);
    expect(body.data.rows[0]!.optedOut).toBe(true);
  });
});

describe('POST /greetings/send-draft', () => {
  const draft = {
    id: 42,
    contact_id: 3,
    event_id: 9,
    year: String(new Date().getFullYear()),
    subject: '生日快乐',
    body_html: '<p>祝你生日快乐</p>',
    recipients: 'mom@example.com',
  };

  it('claims the year, sends through the whitelist and marks the history sent', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [draft], rowCount: 1 }) // draft lookup
      .mockResolvedValueOnce({ rows: [{ event_id: 3 }], rowCount: 1 }) // claim
      .mockResolvedValue({ rows: [], rowCount: 1 }); // history update + trigger log
    mocks.sendContactEmail.mockResolvedValue({ recipients: ['mom@example.com'], failed: 0 });

    const res = await greetingsRoutes.request('/send-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: 42 }),
    });
    const body = await res.json() as { success: boolean; data: { recipients: string[] } };
    expect(body.success).toBe(true);
    expect(mocks.sendContactEmail).toHaveBeenCalledWith(USER.id, 3, expect.objectContaining({ subject: '生日快乐' }));
    // history updated to sent
    const updateCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes("status = 'sent'"));
    expect(updateCall).toBeTruthy();
  });

  it('returns 409 when another path already handled this contact+year', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [draft], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // claim conflict
    const res = await greetingsRoutes.request('/send-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: 42 }),
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /greetings/discard-draft', () => {
  it('only deletes owned draft rows', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await greetingsRoutes.request('/discard-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: 42 }),
    });
    expect(res.status).toBe(200);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain("status = 'draft'");
    expect(params).toEqual([42, USER.id]);
  });

  it('404s when nothing was deleted', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await greetingsRoutes.request('/discard-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: 42 }),
    });
    expect(res.status).toBe(404);
  });
});
