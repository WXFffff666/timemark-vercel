import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 81 acceptance: a milestone LINKED to an event rides the EXISTING reminder
 * engine.
 *
 * Flow under test (all through real code, DB mocked):
 *  1. create a goal + a milestone linked to an owned event via POST /api/goals;
 *  2. run the real shared reminder job (`sendReminders`);
 *  3. that event's reminders fire exactly once (same dispatcher, same
 *     reminder_send_claims dedup) — the goal link neither intercepts, duplicates
 *     nor alters the dispatch;
 *  4. the reminder job reads NO goals/milestones rows: the milestone is a pure
 *     association and the event lifecycle is unchanged;
 *  5. a second run in the same window (cron retry) sends nothing (claim dedup);
 *     an event outside the reminder window sends nothing.
 *
 * Live-engine coverage (migration 44 itself, cascade, event survival) lives in
 * `.omo/evidence/task-81-*`.
 */

const { dbQuery, sendNotifications, NOW_STATE } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendNotifications: vi.fn(),
  NOW_STATE: { value: new Date('2026-06-08T00:30:00Z') }, // 2026-06-08 08:30 Asia/Shanghai
}));

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
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
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(
        c,
        next,
      );
    },
  };
});

vi.mock('../services/notifications/index.js', () => ({ sendNotifications }));

vi.mock('../services/reminder-channel-resolver.service.js', () => ({
  resolveReminderChannels: vi.fn(async () => ['email']),
  resolveActiveAccountChannels: vi.fn(async () => ['email']),
}));

vi.mock('../utils/ntp.js', () => ({
  getSyncedNow: () => NOW_STATE.value,
  scheduleTimeSync: vi.fn(),
  DEFAULT_SYNC_TIMEZONE: 'Asia/Shanghai',
}));

import goalsRoutes from '../routes/goals.js';
import { sendReminders } from '../jobs/tasks.js';

const USER = { id: 1, username: 'alice' };

interface Captured {
  sql: string;
  params: unknown[];
}

type Row = Record<string, unknown>;

let captured: Captured[];
let goals: Row[];
let milestones: Row[];
let events: Row[];
let claimedKeys: Set<string>;

const EVENT_ID = 501;

function linkedEvent(): Row {
  return {
    id: EVENT_ID,
    user_id: USER.id,
    name: '备考',
    date: '2026-06-15', // 7 days after 2026-06-08 in Asia/Shanghai
    calendar_type: 'gregorian',
    reminder_config: { enabled: true, daysBeforeList: [7], reminderTimes: ['08:30'] },
    notification_channels: ['email'],
    notification_account_ids: null,
    type: 'exam',
    profile_id: null,
  };
}

function installDb(): void {
  captured = [];
  claimedKeys = new Set();
  goals = [];
  milestones = [];
  events = [linkedEvent()];

  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    // --- goals route (creating the link) ---
    if (s.startsWith('SELECT id FROM goals WHERE id = $1 AND user_id = $2')) {
      const [id, userId] = params as number[];
      const row = goals.find((g) => g.id === id && g.user_id === userId);
      return { rows: row ? [{ id }] : [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('INSERT INTO goals')) {
      const [userId, , title] = params as unknown[];
      const row: Row = { id: 1, user_id: userId, title, status: 'active' };
      goals.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('SELECT 1 FROM events WHERE id = $1 AND user_id = $2')) {
      const [id, userId] = params as number[];
      const found = events.some((e) => e.id === id && e.user_id === userId);
      return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
    }
    if (s.startsWith('INSERT INTO milestones')) {
      const [goalId, title, dueAt, sortOrder, eventId] = params as unknown[];
      const row: Row = {
        id: 1,
        goal_id: goalId,
        title,
        due_at: dueAt,
        done_at: null,
        sort_order: sortOrder ?? 0,
        event_id: eventId,
      };
      milestones.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // --- shared reminder job ---
    if (s.startsWith('INSERT INTO reminder_send_claims')) {
      const key = `${String(params[0])}#${String(params[1])}`;
      if (claimedKeys.has(key)) return { rows: [], rowCount: 0 };
      claimedKeys.add(key);
      return { rows: [{ event_id: params[0] }], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM reminder_send_claims')) {
      claimedKeys.delete(`${String(params[0])}#${String(params[1])}`);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('FROM user_configs')) {
      return {
        rows: [
          {
            user_id: USER.id,
            timezone: 'Asia/Shanghai',
            reminders_enabled: true,
            daily_check_time: null,
            days_before_list: [7],
            reminder_emails: [],
          },
        ],
        rowCount: 1,
      };
    }
    if (s.includes('SELECT DISTINCT user_id FROM events')) {
      return { rows: [{ user_id: USER.id }], rowCount: 1 };
    }
    if (s.includes('FROM event_reminder_cache')) {
      return { rows: [{ user_id: USER.id, payload: [linkedEvent()] }], rowCount: 1 };
    }
    if (s.includes('FROM profiles')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM event_trigger_logs')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM events') && Array.isArray(params[0])) {
      // supplemental / lunar / fallback queries: the cache already covered the user
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  });

  sendNotifications.mockReset();
  sendNotifications.mockImplementation(async (_event: unknown, _userId: number, channels: string[]) => {
    return Object.fromEntries(channels.map((ch) => [ch, { success: true }]));
  });
}

async function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await goalsRoutes.request(path, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

function queriesMatching(pattern: RegExp): Captured[] {
  return captured.filter((q) => pattern.test(q.sql.replace(/\s+/g, ' ')));
}

beforeEach(() => {
  NOW_STATE.value = new Date('2026-06-08T00:30:00Z');
  authState.user = { ...USER };
  installDb();
});

describe('a goal milestone linked to an event fires that event reminders (checkbox 81)', () => {
  it('creates the link through the API and the shared job dispatches the linked event exactly once', async () => {
    // 1. The association is made through the real route.
    const goalRes = await request('POST', '/', { title: '英语六级', targetValue: 1 });
    expect(goalRes.status).toBe(201);
    const milestoneRes = await request('POST', '/1/milestones', {
      title: '通过考试',
      eventId: EVENT_ID,
    });
    expect(milestoneRes.status).toBe(201);
    expect((milestoneRes.body.data as Row).event_id).toBe(EVENT_ID);
    expect(milestones[0].event_id).toBe(EVENT_ID);

    // 2. The shared job runs: the linked event's reminder fires once, through the
    //    same dispatcher and channel resolution as any other event.
    captured = [];
    await sendReminders();

    expect(sendNotifications).toHaveBeenCalledTimes(1);
    const [eventArg, userIdArg, channelsArg] = sendNotifications.mock.calls[0] as [
      Record<string, unknown>,
      number,
      string[],
    ];
    expect(userIdArg).toBe(USER.id);
    expect(eventArg.id).toBe(EVENT_ID);
    expect(eventArg.name).toBe('备考');
    expect(channelsArg).toEqual(['email']);

    // Same dedup machinery as every event: the claim is keyed on the event id.
    const claim = queriesMatching(/^INSERT INTO reminder_send_claims/)[0];
    expect(claim?.params[0]).toBe(EVENT_ID);

    // 3. The reminder job never even reads the goals tables: the link is a pure
    //    association; a milestone cannot intercept, duplicate or alter a reminder.
    expect(queriesMatching(/FROM goals/)).toHaveLength(0);
    expect(queriesMatching(/FROM milestones/)).toHaveLength(0);
  });

  it('a second run in the same window (cron retry) sends nothing (claim dedup)', async () => {
    await request('POST', '/', { title: '英语六级', targetValue: 1 });
    await request('POST', '/1/milestones', { title: '通过考试', eventId: EVENT_ID });

    await sendReminders();
    await sendReminders();

    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('an event outside the reminder window does not fire even when linked to a milestone', async () => {
    NOW_STATE.value = new Date('2026-06-08T04:30:00Z'); // 12:30 Shanghai: not 08:30
    await request('POST', '/', { title: '英语六级', targetValue: 1 });
    await request('POST', '/1/milestones', { title: '通过考试', eventId: EVENT_ID });

    await sendReminders();

    expect(sendNotifications).not.toHaveBeenCalled();
    // The link still exists — only the time window decided.
    expect(milestones[0].event_id).toBe(EVENT_ID);
  });
});
