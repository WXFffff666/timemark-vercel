import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 91 acceptance for the Telegram webhook route.
 *
 * - POST /api/bot/telegram: 401 on a missing or wrong secret header (and nothing stored)
 * - a >64 KB body is rejected with 413
 * - malformed JSON / missing update_id -> 400 and no bot_updates row
 * - the SAME update_id posted twice executes the processor exactly ONCE (retry ACKs 200)
 * - GET /telegram/setup calls setWebhook with url + secret_token + allowed_updates
 * - GET /telegram/status reports the current webhook state and never leaks the token
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery, storedUpdateIds, processSpy } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  storedUpdateIds: new Set<number>(),
  processSpy: vi.fn(async () => ({ handled: true })),
}));

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
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(c, next);
    },
  };
});

vi.mock('../services/config.service.js', () => ({
  getUserConfig: vi.fn(async () => null),
}));

vi.mock('../services/bot/telegram-api.js', () => ({
  setTelegramWebhook: vi.fn(async () => true),
  getTelegramWebhookInfo: vi.fn(async () => ({
    url: 'https://app.test/api/bot/telegram',
    pending_update_count: 2,
    has_custom_certificate: false,
    allowed_updates: ['message', 'callback_query'],
  })),
  sendTelegramMessage: vi.fn(async () => ({})),
  answerCallbackQuery: vi.fn(async () => ({})),
  editMessageText: vi.fn(async () => ({})),
  TelegramApiError: class TelegramApiError extends Error {},
}));

vi.mock('../services/bot/telegram-webhook.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/bot/telegram-webhook.js')>();
  return { ...actual, processTelegramUpdate: processSpy };
});

import botRoutes from '../routes/bot.js';
import { setTelegramWebhook, getTelegramWebhookInfo } from '../services/bot/telegram-api.js';

const USER = { id: 7, username: 'alice' };
const SECRET = 'test-webhook-secret';

const setWebhookMock = vi.mocked(setTelegramWebhook);
const getWebhookInfoMock = vi.mocked(getTelegramWebhookInfo);

function installDb(): void {
  storedUpdateIds.clear();
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT INTO bot_updates')) {
      const id = Number(params[0]);
      if (storedUpdateIds.has(id)) return { rows: [], rowCount: 0 };
      storedUpdateIds.add(id);
      return { rows: [{ update_id: id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function request(method: string, path: string, init: RequestInit = {}) {
  const res = await botRoutes.request(path, { method, ...init });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

function postUpdate(body: unknown, headers: Record<string, string> = {}) {
  return request('POST', '/telegram', {
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  authState.user = { ...USER };
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  installDb();
  processSpy.mockClear();
  setWebhookMock.mockClear();
  getWebhookInfoMock.mockClear();
});

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_URL;
});

describe('POST /api/bot/telegram - secret verification', () => {
  it('rejects a missing secret header with 401 and stores nothing', async () => {
    const { status, body } = await postUpdate({ update_id: 100, message: { text: '/help' } });
    expect(status).toBe(401);
    expect(body.success).toBe(false);
    expect(storedUpdateIds.size).toBe(0);
    expect(processSpy).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret header with 401 and stores nothing', async () => {
    const { status } = await postUpdate(
      { update_id: 101, message: { text: '/help' } },
      { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
    );
    expect(status).toBe(401);
    expect(storedUpdateIds.size).toBe(0);
  });

  it('rejects every update when no webhook secret is configured', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const { status } = await postUpdate(
      { update_id: 102, message: { text: '/help' } },
      { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
    );
    expect(status).toBe(401);
    expect(storedUpdateIds.size).toBe(0);
  });
});

describe('POST /api/bot/telegram - body cap and malformed input', () => {
  const headers = { 'X-Telegram-Bot-Api-Secret-Token': SECRET };

  it('rejects a body larger than 64 KB with 413 and stores nothing', async () => {
    const huge = JSON.stringify({ update_id: 200, message: { text: 'x'.repeat(70 * 1024) } });
    const { status, body } = await postUpdate(huge, headers);
    expect(status).toBe(413);
    expect(String(body.error)).toContain('64KB');
    expect(storedUpdateIds.size).toBe(0);
  });

  it('rejects a non-JSON body with 400 and stores nothing', async () => {
    const { status } = await request('POST', '/telegram', {
      headers: { 'Content-Type': 'application/json', ...headers },
      body: 'not-json',
    });
    expect(status).toBe(400);
    expect(storedUpdateIds.size).toBe(0);
  });

  it('rejects a body without an update_id with 400 and stores nothing', async () => {
    const { status } = await postUpdate({ message: { text: '/help' } }, headers);
    expect(status).toBe(400);
    expect(storedUpdateIds.size).toBe(0);
  });

  it('rejects an unknown update_id type with 400 and stores nothing', async () => {
    const { status } = await postUpdate({ update_id: 'abc', message: { text: '/help' } }, headers);
    expect(status).toBe(400);
    expect(storedUpdateIds.size).toBe(0);
  });

  it('accepts a body at exactly the 64 KB boundary', async () => {
    // Build a payload whose serialized length is just under the cap.
    const template = JSON.stringify({ update_id: 300, message: { text: '' } });
    const pad = 64 * 1024 - Buffer.byteLength(template, 'utf8');
    const payload = JSON.stringify({ update_id: 300, message: { text: 'y'.repeat(pad) } });
    const { status, body } = await postUpdate(payload, headers);
    expect(status).toBe(200);
    expect(body.processed).toBe(true);
  });
});

describe('POST /api/bot/telegram - update_id dedup', () => {
  const headers = { 'X-Telegram-Bot-Api-Secret-Token': SECRET };

  it('executes the processor exactly once for a repeated update_id', async () => {
    const payload = { update_id: 400, message: { text: '/help' } };

    const first = await postUpdate(payload, headers);
    expect(first.status).toBe(200);
    expect(first.body.processed).toBe(true);

    const second = await postUpdate(payload, headers);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(storedUpdateIds.size).toBe(1);
  });

  it('processes different update_ids independently', async () => {
    await postUpdate({ update_id: 500, message: { text: '/help' } }, headers);
    await postUpdate({ update_id: 501, message: { text: '/help' } }, headers);
    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(storedUpdateIds.size).toBe(2);
  });
});

describe('GET /api/bot/telegram/setup', () => {
  it('is auth-guarded (401 without a token)', async () => {
    authState.user = null;
    const { status } = await request('GET', '/telegram/setup');
    expect(status).toBe(401);
    expect(setWebhookMock).not.toHaveBeenCalled();
  });

  it('calls setWebhook with the exact url, secret_token and allowed_updates', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token-abc';
    process.env.TELEGRAM_WEBHOOK_URL = 'https://app.test/api/bot/telegram';

    const { status, body } = await request('GET', '/telegram/setup');
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    expect(setWebhookMock).toHaveBeenCalledTimes(1);
    expect(setWebhookMock).toHaveBeenCalledWith('bot-token-abc', {
      url: 'https://app.test/api/bot/telegram',
      secretToken: SECRET,
      allowedUpdates: ['message', 'callback_query'],
    });

    const data = body.data as Record<string, unknown>;
    expect(data.url).toBe('https://app.test/api/bot/telegram');
    expect(data.allowed_updates).toEqual(['message', 'callback_query']);
    // The secret itself is never echoed back.
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('returns 400 when the webhook secret is not configured', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token-abc';
    const { status } = await request('GET', '/telegram/setup');
    expect(status).toBe(400);
    expect(setWebhookMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/bot/telegram/status', () => {
  it('is auth-guarded (401 without a token)', async () => {
    authState.user = null;
    const { status } = await request('GET', '/telegram/status');
    expect(status).toBe(401);
    expect(getWebhookInfoMock).not.toHaveBeenCalled();
  });

  it('reports the current webhook state without leaking the token', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token-xyz';
    const { status, body } = await request('GET', '/telegram/status');
    expect(status).toBe(200);
    expect(getWebhookInfoMock).toHaveBeenCalledWith('bot-token-xyz');

    const data = body.data as Record<string, unknown>;
    expect(data.url).toBe('https://app.test/api/bot/telegram');
    expect(data.pending_update_count).toBe(2);
    expect(data.allowed_updates).toEqual(['message', 'callback_query']);
    expect(JSON.stringify(body)).not.toContain('bot-token-xyz');
  });

  it('returns 400 when no bot token is configured', async () => {
    const { status } = await request('GET', '/telegram/status');
    expect(status).toBe(400);
  });
});
