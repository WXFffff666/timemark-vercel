import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@timemark/shared/crypto';

/**
 * Checkbox 95 acceptance: `/quiet <start> <end>` must persist through the EXISTING
 * quiet-hours setting (`quiet_hours_start` / `quiet_hours_end` in `user_configs`, the pair
 * `sendNotifications` reads via `isInQuietHours`) - not a parallel mechanism.
 *
 * The notifier itself is exercised for real: during the configured window it must suppress
 * delivery, outside it it must deliver.
 */

const { dbQuery, sendTelegramNotification, state } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  sendTelegramNotification: vi.fn(async (_event: unknown, _token: string, _chatId: string) => undefined),
  state: { config: null as Record<string, unknown> | null },
}));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../services/notifications/telegram.service.js', () => ({
  sendTelegramNotification,
}));

import { QUIET_HOURS_USAGE, dispatchCommand } from '../services/bot/dispatcher.js';
import { isInQuietHours, sendNotifications } from '../services/notifications/index.js';

const MASTER_KEY = 'task95-test-master-key-0123456789abcdef';
const USER_ID = 1;
const EVENT = { id: 5, name: '体检', type: 'other', date: '2026-09-29', reminder_config: {} };

function installDb(): void {
  state.config = {
    user_id: USER_ID,
    timezone: 'Asia/Shanghai',
    quiet_hours_start: null,
    quiet_hours_end: null,
    // Decrypting this through the real config.service proves the notifier reads the same row.
    encrypted_telegram_bot_token: encrypt('bot-token', MASTER_KEY),
    telegram_chat_id: '555',
  };

  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT user_id FROM user_configs')) {
      return state.config ? { rows: [{ user_id: USER_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('SELECT * FROM user_configs')) {
      return state.config ? { rows: [{ ...state.config }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('UPDATE user_configs SET quiet_hours_start')) {
      state.config = { ...state.config, quiet_hours_start: params[0], quiet_hours_end: params[1] };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

function dispatch(text: string) {
  return dispatchCommand(
    { platform: 'telegram', chatId: '12345', userId: USER_ID, profileId: null, text },
    { isLinked: async () => true, now: () => new Date('2026-09-28T04:00:00Z') },
  );
}

beforeEach(() => {
  process.env.MASTER_KEY = MASTER_KEY;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T04:00:00Z')); // 12:00 Asia/Shanghai
  installDb();
  sendTelegramNotification.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MASTER_KEY;
});

describe('/quiet persistence (acceptance)', () => {
  it('persists /quiet 22:00 07:00 through quiet_hours_start/end and shows it in /settings', async () => {
    const reply = await dispatch('/quiet 22:00 07:00');
    expect(reply?.kind).toBe('message');
    expect(reply?.text).toContain('22:00 - 07:00');
    expect(state.config?.quiet_hours_start).toBe('22:00');
    expect(state.config?.quiet_hours_end).toBe('07:00');

    const settings = await dispatch('/settings');
    expect(settings?.text).toContain('22:00 - 07:00');
  });

  it('QA failure: /quiet 25:00 abc returns the format hint and leaves the setting untouched', async () => {
    const before = { ...state.config };
    const reply = await dispatch('/quiet 25:00 abc');

    expect(reply?.kind).toBe('error');
    expect(reply?.text).toContain(QUIET_HOURS_USAGE);
    expect(state.config?.quiet_hours_start).toBe(before.quiet_hours_start);
    expect(state.config?.quiet_hours_end).toBe(before.quiet_hours_end);
    expect(state.config?.quiet_hours_start).toBeNull();
  });

  it('rejects half a window without writing', async () => {
    const reply = await dispatch('/quiet 22:00');
    expect(reply?.kind).toBe('error');
    expect(reply?.text).toContain(QUIET_HOURS_USAGE);
    expect(state.config?.quiet_hours_start).toBeNull();
  });
});

describe('the notifier honours the stored quiet hours (acceptance)', () => {
  it('suppresses delivery inside the window and delivers outside it', async () => {
    await dispatch('/quiet 22:00 07:00');

    // 23:00 Asia/Shanghai - inside 22:00-07:00.
    vi.setSystemTime(new Date('2026-09-28T15:00:00Z'));
    expect(isInQuietHours(state.config?.quiet_hours_start as string, state.config?.quiet_hours_end as string, 'Asia/Shanghai')).toBe(true);

    const suppressed = await sendNotifications(EVENT, USER_ID, ['telegram']);
    expect(suppressed._quiet_hours).toMatchObject({ success: false, error: 'quiet_hours' });
    expect(suppressed.telegram).toMatchObject({ success: false, error: 'quiet_hours' });
    expect(sendTelegramNotification).not.toHaveBeenCalled();

    // 12:00 Asia/Shanghai - outside the window.
    vi.setSystemTime(new Date('2026-09-28T04:00:00Z'));
    expect(isInQuietHours(state.config?.quiet_hours_start as string, state.config?.quiet_hours_end as string, 'Asia/Shanghai')).toBe(false);

    const delivered = await sendNotifications(EVENT, USER_ID, ['telegram']);
    expect(delivered.telegram).toMatchObject({ success: true });
    expect(sendTelegramNotification).toHaveBeenCalledTimes(1);
    expect(sendTelegramNotification.mock.calls[0][1]).toBe('bot-token');
    expect(sendTelegramNotification.mock.calls[0][2]).toBe('555');
  });
});
