import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 95 acceptance: the 4096-character limit is enforced at the OUTBOUND boundary
 * (the two Telegram client calls), so no handler - present or future - can bypass it, and
 * a truncated MarkdownV2 message is still valid (entity/escape-safe cut + explicit suffix).
 *
 * axios is mocked, so the assertions inspect the exact `sendMessage` payload without a
 * live Telegram API.
 */

const { axiosPost, dbQuery } = vi.hoisted(() => ({ axiosPost: vi.fn(), dbQuery: vi.fn() }));

vi.mock('axios', () => ({
  default: {
    post: axiosPost,
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean } | null)?.isAxiosError),
  },
}));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

import { editMessageText, sendTelegramMessage } from '../services/bot/telegram-api.js';
import { processTelegramUpdate } from '../services/bot/telegram-webhook.js';
import { TRUNCATION_SUFFIX, validateMarkdownV2 } from '../services/bot/markdown.js';

const TELEGRAM_LIMIT = 4096;

function lastPayload(): Record<string, unknown> {
  const call = axiosPost.mock.calls[axiosPost.mock.calls.length - 1] as [string, Record<string, unknown>];
  return call[1];
}

beforeEach(() => {
  axiosPost.mockReset();
  axiosPost.mockResolvedValue({ data: { ok: true, result: { message_id: 1 } } });
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.APP_BASE_URL;
});

describe('outbound 4096 enforcement (sendMessage)', () => {
  it('truncates a 5000-character CJK digest below the limit with the explicit suffix', async () => {
    const digest = `📊 本周速览：\n${'本周待办事项内容'.repeat(650)}`;
    expect(digest.length).toBeGreaterThan(5000);

    await sendTelegramMessage('bot-token', { chatId: '1', text: digest, parseMode: 'MarkdownV2' });

    const payload = lastPayload();
    expect(payload.parse_mode).toBe('MarkdownV2');
    const text = String(payload.text);
    expect(text.length).toBeLessThan(TELEGRAM_LIMIT);
    expect(text.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    // The truncated message is still parseable MarkdownV2.
    expect(validateMarkdownV2(text)).toEqual([]);
  });

  it('truncates a digest made of link syntax only at an entity boundary', async () => {
    const links = Array.from(
      { length: 400 },
      (_value, index) => `[打开待办](https://app.test/todos#item-${index + 1})`,
    ).join(' · ');
    expect(links.length).toBeGreaterThan(5000);

    await sendTelegramMessage('bot-token', { chatId: '1', text: links, parseMode: 'MarkdownV2' });

    const text = String(lastPayload().text);
    expect(text.length).toBeLessThan(TELEGRAM_LIMIT);
    expect(text.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(validateMarkdownV2(text)).toEqual([]);
    // There is no dangling escape/link fragment at the cut.
    expect(text.slice(0, -TRUNCATION_SUFFIX.length).trimEnd()).not.toMatch(/[\\[(]$/);
    // Enough complete links survive to be useful.
    expect(text.match(/\[打开待办\]\(https:\/\/app\.test\/todos#item-\d+\)/g)?.length ?? 0).toBeGreaterThan(5);
  });

  it('never splits a surrogate pair when truncating plain text', async () => {
    const text = '🎂'.repeat(2500); // 5000 UTF-16 units, 2500 code points
    await sendTelegramMessage('bot-token', { chatId: '1', text });

    const payload = lastPayload();
    expect(payload.parse_mode).toBeUndefined();
    const sent = String(payload.text);
    expect(sent.length).toBeLessThan(TELEGRAM_LIMIT);
    expect(sent.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(sent.slice(0, -TRUNCATION_SUFFIX.length))).toBe(false);
  });

  it('applies the same gate to editMessageText', async () => {
    const text = 'a'.repeat(5000);
    await editMessageText('bot-token', { chatId: '1', messageId: 5, text });

    const call = axiosPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(call[0]).toContain('/editMessageText');
    const sent = String(call[1].text);
    expect(sent.length).toBeLessThan(TELEGRAM_LIMIT);
    expect(sent.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('leaves a short message byte-identical', async () => {
    await sendTelegramMessage('bot-token', { chatId: '1', text: '✅ 已完成：体检', parseMode: 'MarkdownV2' });
    expect(lastPayload().text).toBe('✅ 已完成：体检');
  });
});

describe('telegram-webhook wiring (rich reply -> parse_mode)', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    process.env.APP_BASE_URL = 'https://app.test';
    dbQuery.mockImplementation(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.includes('FROM bot_links')) {
        return {
          rows: [{ id: 1, user_id: 7, platform: 'telegram', chat_id: '12345', active_profile_id: null }],
          rowCount: 1,
        };
      }
      if (normalized.includes('FROM events e')) {
        return { rows: [{ id: 11, name: 'Ann_*Lee', date: '2026-10-05' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it('sends the MarkdownV2 rendering with parse_mode for /list', async () => {
    const result = await processTelegramUpdate({
      update_id: 9001,
      message: { chat: { id: 12345, type: 'private' }, text: '/list' },
    });

    expect(result).toMatchObject({ handled: true, replied: true });
    const payload = lastPayload();
    expect(payload.parse_mode).toBe('MarkdownV2');
    const text = String(payload.text);
    expect(text).toContain('[Ann\\_\\*Lee](https://app.test/todos#item-11)');
    expect(validateMarkdownV2(text)).toEqual([]);
  });

  it('falls back to plain text (no parse_mode) for handlers without a rich form', async () => {
    await processTelegramUpdate({
      update_id: 9002,
      message: { chat: { id: 12345, type: 'private' }, text: '/help' },
    });

    const payload = lastPayload();
    expect(payload.parse_mode).toBeUndefined();
    expect(String(payload.text)).toContain('/quiet');
  });
});
