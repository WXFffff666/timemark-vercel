import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 95 acceptance: rich MarkdownV2 replies, deep links, the 本周 digest and the
 * `/quiet` command.
 *
 * The escapers/validators are pure, so they are asserted directly. Dispatcher-level cases
 * prove that every user-supplied value (titles, medication names, ...) reaches MarkdownV2
 * through the escaper and that the resulting message passes the validation pass.
 */

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

import {
  QUIET_HOURS_USAGE,
  buildWeekDigest,
  dispatchCommand,
  parseQuietTime,
  type BotCommandContext,
  type BotDataProvider,
  type BotQuietHoursWriter,
  type BotReply,
  type DispatcherDeps,
} from '../services/bot/dispatcher.js';
import { expiryDeepLink, medicationsDeepLink, todoDeepLink } from '../services/bot/deep-links.js';
import {
  MARKDOWN_V2_RESERVED,
  escapeMarkdownV2,
  escapeMarkdownV2Url,
  markdownLink,
  validateMarkdownV2,
} from '../services/bot/markdown.js';

const NOW = new Date('2026-10-05T02:00:00.000Z'); // 2026-10-05 10:00 Asia/Shanghai
const USER_ID = 7;
const APP_URL = 'https://app.test';

const PENDING = [
  { eventId: 11, title: 'Ann_*Lee', date: '2026-10-05' },
  { eventId: 22, title: '[x](https://evil.test)', date: '2026-10-06' },
  { eventId: 33, title: '体检', date: '2026-10-20' },
];

function makeProvider(): BotDataProvider {
  return {
    listPending: async () => PENDING.map((item) => ({ ...item })),
    addItem: async (_userId, _profileId, input) => ({
      eventId: 99,
      title: input.title,
      date: input.date,
      time: input.time,
    }),
    completeTodo: async () => undefined,
    snoozeTodo: async () => ({ status: 'ok', snoozedUntil: '2026-10-05T02:10:00.000Z', localTime: '10:10' }),
    listTodayDoses: async () => [
      { id: 1, medicationName: '维生素_D', scheduledFor: '2026-10-05T08:00:00.000Z', localTime: '16:00', status: 'pending' },
    ],
    listExpiring: async () => [
      { id: 7, title: '域名_续费', expiresOn: '2026-10-10', daysUntil: 5 },
    ],
    listHabits: async () => [{ id: 1, name: '晨跑_30min', currentStreak: 3, targetMet: true }],
    listProfiles: async () => [{ id: 1, name: '我', isDefault: true }],
    getSettings: async () => ({
      timezone: 'Asia/Shanghai',
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      remindersEnabled: true,
      digestEnabled: true,
    }),
    setActiveProfile: async () => 'ok',
  };
}

function ctx(text: string): BotCommandContext {
  return { platform: 'telegram', chatId: '12345', userId: USER_ID, profileId: null, text };
}

let provider: BotDataProvider;

function dispatch(text: string, deps: Partial<DispatcherDeps> = {}): Promise<BotReply | null> {
  return dispatchCommand(ctx(text), {
    provider,
    isLinked: async () => true,
    now: () => NOW,
    ...deps,
  });
}

beforeEach(() => {
  provider = makeProvider();
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  process.env.APP_BASE_URL = APP_URL;
});

afterEach(() => {
  delete process.env.APP_BASE_URL;
});

// ---------------------------------------------------------------------------
// MarkdownV2 escaping
// ---------------------------------------------------------------------------

/**
 * The invariant the acceptance asks for, factored out so the negative control can run the
 * SAME assertions against a sabotaged (identity) escaper and prove they fail.
 */
function assertEscapingInvariant(escaper: (value: string) => string): void {
  const escaped = escaper('Ann_*Lee');
  expect(escaped).toBe('Ann\\_\\*Lee');
  expect(validateMarkdownV2(`✅ 已完成：${escaped}`)).toEqual([]);
}

describe('escapeMarkdownV2', () => {
  it('neutralises _ and * in a contact name Ann_*Lee (acceptance)', () => {
    assertEscapingInvariant(escapeMarkdownV2);

    const escaped = escapeMarkdownV2('Ann_*Lee');
    expect(escaped).toBe('Ann\\_\\*Lee');
    const message = `📋 待办（1）：\n1\\. ${escaped} · 2026\\-10\\-05`;
    expect(validateMarkdownV2(message)).toEqual([]);
  });

  it('negative control: the identity escaper fails the same invariant', () => {
    assertEscapingInvariant(escapeMarkdownV2);
    expect(() => assertEscapingInvariant((value) => value)).toThrow();
  });

  it('escapes a name containing EVERY reserved character, exactly once each', () => {
    const expected = [...MARKDOWN_V2_RESERVED].map((ch) => `\\${ch}`).join('');
    const escaped = escapeMarkdownV2(MARKDOWN_V2_RESERVED);
    expect(escaped).toBe(expected);
    for (const ch of MARKDOWN_V2_RESERVED) {
      expect(escaped).toContain(`\\${ch}`);
    }
    expect(validateMarkdownV2(escaped)).toEqual([]);
  });

  it('escapes a backslash-only name and mixed backslashes', () => {
    expect(escapeMarkdownV2('\\')).toBe('\\\\');
    expect(escapeMarkdownV2('C:\\Users\\x')).toBe('C:\\\\Users\\\\x');
    expect(validateMarkdownV2(escapeMarkdownV2('\\'))).toEqual([]);
  });

  it('does not double-escape an already escaped value', () => {
    const once = escapeMarkdownV2('Ann_Lee');
    expect(once).toBe('Ann\\_Lee');

    // The already-escaped value goes in and comes out untouched - not `Ann\\\_Lee`.
    expect(escapeMarkdownV2(once)).toBe('Ann\\_Lee');
    expect(escapeMarkdownV2('Ann\\_Lee')).toBe('Ann\\_Lee');
    expect(escapeMarkdownV2('\\*\\[x\\]')).toBe('\\*\\[x\\]');
    expect(validateMarkdownV2(once)).toEqual([]);
  });

  it('escapes URLs for the MarkdownV2 link target (only ) and backslash)', () => {
    expect(escapeMarkdownV2Url('https://app.test/a)b')).toBe('https://app.test/a\\)b');
    expect(escapeMarkdownV2Url('https://app.test/a\\b')).toBe('https://app.test/a\\\\b');
    expect(markdownLink('Ann_*Lee', 'https://app.test/a)b')).toBe('[Ann\\_\\*Lee](https://app.test/a\\)b)');
    expect(validateMarkdownV2(markdownLink('Ann_*Lee', 'https://app.test/a)b'))).toEqual([]);
  });

  it('renders a prompt-injection style name as inert escaped text, not a link', () => {
    const evil = '[x](https://evil.test)';
    const escaped = escapeMarkdownV2(evil);
    expect(escaped).toBe('\\[x\\]\\(https://evil\\.test\\)');
    expect(escaped).not.toContain('](https://evil');
    expect(validateMarkdownV2(`事件：${escaped}`)).toEqual([]);
  });
});

describe('validateMarkdownV2', () => {
  it('accepts a valid MarkdownV2 message with a link', () => {
    const message = `🗓 本周待办（1）：\n${markdownLink('体检', 'https://app.test/todos#item-3')}`;
    expect(validateMarkdownV2(message)).toEqual([]);
  });

  it('rejects unescaped reserved characters', () => {
    expect(validateMarkdownV2('Total: 3. done').length).toBeGreaterThan(0);
    expect(validateMarkdownV2('a+b').length).toBeGreaterThan(0);
    expect(validateMarkdownV2('lone | pipe').length).toBeGreaterThan(0);
  });

  it('rejects unclosed entities and unclosed links', () => {
    expect(validateMarkdownV2('*bold').length).toBeGreaterThan(0);
    expect(validateMarkdownV2('_italic').length).toBeGreaterThan(0);
    expect(validateMarkdownV2('[text](https://app.test').length).toBeGreaterThan(0);
    expect(validateMarkdownV2('[text] https://app.test').length).toBeGreaterThan(0);
  });

  it('rejects invalid escape sequences', () => {
    expect(validateMarkdownV2('back\\slash').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

describe('deep links', () => {
  it('builds /todos#item-<id>, /expiry#<id> and /medications from APP_BASE_URL', () => {
    process.env.APP_BASE_URL = 'https://app.test/';
    expect(todoDeepLink(3)).toBe('https://app.test/todos#item-3');
    expect(expiryDeepLink(42)).toBe('https://app.test/expiry#42');
    expect(medicationsDeepLink()).toBe('https://app.test/medications');
  });

  it('degrades to null when APP_BASE_URL is unset or unusable', () => {
    delete process.env.APP_BASE_URL;
    expect(todoDeepLink(3)).toBeNull();
    expect(expiryDeepLink(1)).toBeNull();
    expect(medicationsDeepLink()).toBeNull();

    process.env.APP_BASE_URL = 'not-a-url';
    expect(todoDeepLink(3)).toBeNull();
  });

  it('/list renders each item as a well-formed MarkdownV2 link', async () => {
    const reply = await dispatch('/list');
    const md = reply?.markdownText ?? '';
    expect(md).toContain('[Ann\\_\\*Lee](https://app.test/todos#item-11)');
    expect(md).toContain('2\\. ');
    expect(validateMarkdownV2(md)).toEqual([]);
  });

  it('/expiry and /med carry their deep links', async () => {
    const expiry = await dispatch('/expiry');
    expect(expiry?.markdownText).toContain('[域名\\_续费](https://app.test/expiry#7)');
    expect(validateMarkdownV2(expiry?.markdownText ?? '')).toEqual([]);

    const med = await dispatch('/med');
    expect(med?.markdownText).toContain('维生素\\_D');
    expect(med?.markdownText).toContain('](https://app.test/medications)');
    expect(validateMarkdownV2(med?.markdownText ?? '')).toEqual([]);
  });

  it('omits links (and stays valid) when APP_BASE_URL is unset', async () => {
    delete process.env.APP_BASE_URL;
    const reply = await dispatch('/list');
    const md = reply?.markdownText ?? '';
    expect(md).not.toContain('](');
    expect(md).toContain('Ann\\_\\*Lee');
    expect(validateMarkdownV2(md)).toEqual([]);

    const med = await dispatch('/med');
    expect(med?.markdownText).not.toContain('](');
    expect(validateMarkdownV2(med?.markdownText ?? '')).toEqual([]);
  });

  it('a list item titled [x](https://evil.test) stays inert in the rich reply', async () => {
    const reply = await dispatch('/list');
    const md = reply?.markdownText ?? '';
    expect(md).toContain('\\[x\\]\\(https://evil\\.test\\)');
    expect(md).not.toContain('](https://evil');
    expect(validateMarkdownV2(md)).toEqual([]);
  });

  it('keeps the plain-text representation unchanged for existing transports', async () => {
    const reply = await dispatch('/list');
    expect(reply?.text).toContain('1. Ann_*Lee · 2026-10-05');
    expect(reply?.text).not.toContain('\\');
  });
});

// ---------------------------------------------------------------------------
// 本周 digest
// ---------------------------------------------------------------------------

describe('本周 digest', () => {
  it('summarises today / tomorrow / later counts', () => {
    const digest = buildWeekDigest(
      [
        { eventId: 1, title: 'a', date: '2026-10-05' },
        { eventId: 2, title: 'b', date: '2026-10-06' },
        { eventId: 3, title: 'c', date: '2026-10-06' },
      ],
      '2026-10-05',
    );
    expect(digest).toBe('📊 本周速览：共 3 项（今天 1 · 明天 2 · 随后 0）');
    expect(validateMarkdownV2(digest)).toEqual([]);
  });

  it('/week reply carries the compact digest before the item list', async () => {
    const reply = await dispatch('/week');
    const md = reply?.markdownText ?? '';
    expect(md).toContain('📊 本周速览：共 2 项（今天 1 · 明天 1 · 随后 0）');
    expect(md).toContain('[Ann\\_\\*Lee](https://app.test/todos#item-11)');
    expect(md).toContain('[\\[x\\]\\(https://evil\\.test\\)](https://app.test/todos#item-22)');
    expect(validateMarkdownV2(md)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// /quiet
// ---------------------------------------------------------------------------

describe('/quiet', () => {
  function makeWriter(): { writer: BotQuietHoursWriter; calls: Array<[number, string, string]> } {
    const calls: Array<[number, string, string]> = [];
    const writer: BotQuietHoursWriter = async (userId, start, end) => {
      calls.push([userId, start, end]);
    };
    return { writer, calls };
  }

  it('parses 24-hour times and normalises single-digit hours', () => {
    expect(parseQuietTime('22:00')).toBe('22:00');
    expect(parseQuietTime('7:00')).toBe('07:00');
    expect(parseQuietTime('07:00')).toBe('07:00');
    expect(parseQuietTime('25:00')).toBeNull();
    expect(parseQuietTime('22:60')).toBeNull();
    expect(parseQuietTime('abc')).toBeNull();
    expect(parseQuietTime('')).toBeNull();
  });

  it('persists /quiet 22:00 07:00 through the shared setting', async () => {
    const { writer, calls } = makeWriter();
    const reply = await dispatch('/quiet 22:00 07:00', { quietHours: writer });

    expect(calls).toEqual([[USER_ID, '22:00', '07:00']]);
    expect(reply?.kind).toBe('message');
    expect(reply?.text).toContain('22:00 - 07:00');
    expect(reply?.markdownText).toContain('22:00 \\- 07:00');
    expect(validateMarkdownV2(reply?.markdownText ?? '')).toEqual([]);
    expect(reply?.data).toMatchObject({ quietHoursStart: '22:00', quietHoursEnd: '07:00' });
  });

  it('works through the Chinese alias and normalises the write', async () => {
    const { writer, calls } = makeWriter();
    const reply = await dispatch('/静默 7:00 23:30', { quietHours: writer });
    expect(calls).toEqual([[USER_ID, '07:00', '23:30']]);
    expect(reply?.kind).toBe('message');
  });

  it('QA failure: /quiet 25:00 abc returns a format hint and does NOT write', async () => {
    const { writer, calls } = makeWriter();
    const reply = await dispatch('/quiet 25:00 abc', { quietHours: writer });

    expect(reply?.kind).toBe('error');
    expect(reply?.text).toContain(QUIET_HOURS_USAGE);
    expect(reply?.data).toMatchObject({ reason: 'bad_quiet_hours' });
    expect(calls).toEqual([]);
  });

  it('rejects a missing or single argument without writing', async () => {
    const { writer, calls } = makeWriter();

    const none = await dispatch('/quiet', { quietHours: writer });
    expect(none?.kind).toBe('ask');
    expect(none?.text).toContain('当前静默时段：22:00 - 07:00');
    expect(none?.text).toContain(QUIET_HOURS_USAGE);

    const one = await dispatch('/quiet 22:00', { quietHours: writer });
    expect(one?.kind).toBe('error');
    expect(one?.text).toContain(QUIET_HOURS_USAGE);

    expect(calls).toEqual([]);
  });
});
