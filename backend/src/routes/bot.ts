import { Hono, type Context } from 'hono';
import { timingSafeEqual } from 'crypto';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { getUserConfig } from '../services/config.service.js';
import { getConfiguredOrigins } from '../utils/allowed-origins.js';
import { createLogger } from '../utils/logger.js';
import {
  acceptTelegramUpdate,
  processTelegramUpdate,
  type TelegramUpdate,
} from '../services/bot/telegram-webhook.js';
import { createBotLinkCode } from '../services/bot/linking.service.js';
import {
  getTelegramWebhookInfo,
  setTelegramWebhook,
  TelegramApiError,
} from '../services/bot/telegram-api.js';
import type { User } from '@timemark/shared';

/**
 * Telegram 双向机器人入口（D7，checkbox 91）。
 *
 * 约定与其他路由一致：`{ success, data }` / `{ success:false, error }` 信封。
 * - `POST /telegram` 是**公开**入站 webhook：没有 JWT，改用 Telegram 的
 *   `X-Telegram-Bot-Api-Secret-Token` 头做**常量时间**校验（CSRF/零信任层在 index.ts
 *   为本路径显式豁免，与 `/api/webhook/*` 同理）。缺失或错误一律 401。
 * - `GET /telegram/setup` 与 `GET /telegram/status` 需要登录（authMiddleware）。
 *
 * 不使用 long polling（serverless 无法常驻）。任何日志都不包含 bot token / webhook secret。
 */
const botRoutes = new Hono<{ Variables: { user: User } }>();
const log = createLogger('bot');

/** Telegram 更新体上限：64 KB（与入站 webhook 一致），超出直接 413，不做无界缓冲。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 明确声明的 allowed_updates；93 将消费 callback_query。 */
const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Read the request body with a hard byte cap. `Content-Length` is checked first; when the
 * body is streamed (chunked) it is consumed chunk-by-chunk and aborted the moment the cap
 * is exceeded, so an oversized payload is never fully buffered.
 */
async function readCappedBody(
  c: Context,
  limit: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = c.req.header('content-length');
  if (declared && Number(declared) > limit) return { ok: false };

  const body = c.req.raw.body;
  if (!body) {
    const text = await c.req.text();
    return Buffer.byteLength(text, 'utf8') > limit ? { ok: false } : { ok: true, text };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  return { ok: true, text };
}

/** Bot token: env wins (no DB hit); otherwise the per-user encrypted config field. */
async function resolveBotToken(userId: number): Promise<string | null> {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  const config = await getUserConfig(userId);
  const token = config?.telegram_bot_token;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

function resolveWebhookUrl(c: Context): string | null {
  const explicit = process.env.TELEGRAM_WEBHOOK_URL;
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, '');
  const base = process.env.APP_BASE_URL || getConfiguredOrigins()[0];
  if (base) return `${base.replace(/\/$/, '')}/api/bot/telegram`;
  try {
    return `${new URL(c.req.url).origin}/api/bot/telegram`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public inbound webhook
// ---------------------------------------------------------------------------

botRoutes.post('/telegram', async (c) => {
  const provided = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!secretMatches(provided, process.env.TELEGRAM_WEBHOOK_SECRET)) {
    log.warn(
      { event: 'bot.webhook_unauthorized', secretConfigured: !!process.env.TELEGRAM_WEBHOOK_SECRET },
      'Telegram webhook rejected: bad or missing secret token',
    );
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const read = await readCappedBody(c, MAX_BODY_BYTES);
  if (!read.ok) {
    return c.json({ success: false, error: 'Payload too large (max 64KB)' }, 413);
  }

  let update: unknown;
  try {
    update = JSON.parse(read.text);
  } catch {
    return c.json({ success: false, error: 'JSON body required' }, 400);
  }
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return c.json({ success: false, error: 'JSON object body required' }, 400);
  }

  const updateId = (update as { update_id?: unknown }).update_id;
  if (typeof updateId !== 'number' || !Number.isSafeInteger(updateId) || updateId <= 0) {
    return c.json({ success: false, error: 'update_id required' }, 400);
  }

  const result = await acceptTelegramUpdate(update as TelegramUpdate, processTelegramUpdate);
  if (result === 'duplicate') {
    log.info({ event: 'bot.webhook_duplicate', updateId }, 'Telegram update already processed; ACK only');
    return c.json({ success: true, duplicate: true });
  }
  return c.json({ success: true, processed: true });
});

// ---------------------------------------------------------------------------
// Authenticated management endpoints
// ---------------------------------------------------------------------------

botRoutes.get('/telegram/setup', authMiddleware, async (c) => {
  const userId = Number(c.get('user').id);
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    return c.json({ success: false, error: 'TELEGRAM_WEBHOOK_SECRET 未配置' }, 400);
  }
  const token = await resolveBotToken(userId);
  if (!token) {
    return c.json({ success: false, error: '未配置 Telegram Bot Token（设置页或 TELEGRAM_BOT_TOKEN）' }, 400);
  }
  const url = resolveWebhookUrl(c);
  if (!url) {
    return c.json({ success: false, error: '无法推断 webhook 地址，请配置 TELEGRAM_WEBHOOK_URL' }, 400);
  }

  try {
    await setTelegramWebhook(token, {
      url,
      secretToken: secret,
      allowedUpdates: [...ALLOWED_UPDATES],
    });
  } catch (error: unknown) {
    const message = error instanceof TelegramApiError ? error.message : 'setWebhook 失败';
    return c.json({ success: false, error: message }, 502);
  }

  return c.json({
    success: true,
    data: { url, allowed_updates: [...ALLOWED_UPDATES], secret_configured: true },
  });
});

botRoutes.get('/telegram/status', authMiddleware, async (c) => {
  const userId = Number(c.get('user').id);
  const token = await resolveBotToken(userId);
  if (!token) {
    return c.json({ success: false, error: '未配置 Telegram Bot Token' }, 400);
  }

  try {
    const info = await getTelegramWebhookInfo(token);
    return c.json({
      success: true,
      data: {
        url: info.url ?? '',
        pending_update_count: info.pending_update_count ?? 0,
        has_custom_certificate: info.has_custom_certificate ?? false,
        last_error_date: info.last_error_date ?? null,
        last_error_message: info.last_error_message ?? null,
        max_connections: info.max_connections ?? null,
        allowed_updates: info.allowed_updates ?? [],
        secret_configured: !!process.env.TELEGRAM_WEBHOOK_SECRET,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof TelegramApiError ? error.message : 'getWebhookInfo 失败';
    return c.json({ success: false, error: message }, 502);
  }
});

/**
 * `POST /telegram/link-code`（checkbox 94）：为当前登录用户生成一次性绑定码。
 *
 * 放在 `routes/bot.ts`（而不是 `routes/security.ts`）：这是 Telegram 机器人管理面的一部分，
 * 与 `/telegram/setup`、`/telegram/status` 同属一个入口；`security.ts` 管的是登录锁定、
 * Passkey、2FA 等通用安全设置，绑定码只在机器人场景下有意义。
 *
 * 原始绑定码仅在本次响应中返回一次；数据库只保存 SHA-256 哈希，服务端日志不记录原始码。
 * 绑定码 10 分钟过期、且只能使用一次（原子 UPDATE 消费，见 linking.service.ts）。
 */
botRoutes.post('/telegram/link-code', authMiddleware, async (c) => {
  const userId = Number(c.get('user').id);
  const { code, expiresAt } = await createBotLinkCode(userId);
  return c.json({
    success: true,
    data: { code, expires_at: expiresAt.toISOString(), expires_in_seconds: Math.round((expiresAt.getTime() - Date.now()) / 1000) },
  });
});

export default botRoutes;
