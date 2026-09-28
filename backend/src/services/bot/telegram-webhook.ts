import { query } from '../../db/index.js';
import { getUserConfig } from '../config.service.js';
import { createLogger } from '../../utils/logger.js';
import { dispatchCommand, type BotInlineButton, type DispatcherDeps } from './dispatcher.js';
import { getActiveBotLink, touchBotLink, type BotPlatform } from './linking.service.js';
import { sendTelegramMessage } from './telegram-api.js';
import { handleTelegramCallbackQuery } from './callback-handler.js';
import { botRateLimiter, botRateLimitMessage, type BotRateLimitCheck } from './rate-limit.js';
import {
  BOT_SECURITY_EVENTS,
  defaultBotSecurityEmitter,
  emitBotSecurityEvent,
  sanitizeSecurityField,
} from './security-events.js';

const log = createLogger('bot.webhook');

/**
 * Telegram webhook intake (checkbox 91).
 *
 * Telegram re-delivers an update until it is ACKed with HTTP 200, so every delivery of the
 * same `update_id` must be executed at most once. `claimUpdate` inserts the id first and
 * lets the `bot_updates.update_id` PRIMARY KEY reject the retry; the retry then ACKs 200
 * without running the processor again (idempotent).
 *
 * This module owns the transport-agnostic dedup core; the command dispatcher (checkbox 92)
 * is injected as the `process` function so it stays unit-testable and out of the HTTP layer.
 */

export interface TelegramChat {
  id: number | string;
  type?: string;
}

export interface TelegramUser {
  id: number | string;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id?: number;
  from?: TelegramUser;
  chat?: TelegramChat;
  text?: string;
  date?: number;
  /** Present when the message was forwarded; the dispatcher must treat its text as data. */
  forward_origin?: unknown;
  /** Legacy forward markers (Bot API kept them for old clients); also untrusted context. */
  forward_from?: unknown;
  forward_date?: number;
  /** Telegram "quote" feature: the message quotes text from the replied-to message. */
  quote?: unknown;
  /** The message this one replies to; a quoted/forwarded context for checkbox 96. */
  reply_to_message?: TelegramMessage;
  /** Inline keyboard attached to the message; echoed back on snooze edits (checkbox 93). */
  reply_markup?: unknown;
}

export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export type TelegramUpdateProcessor = (update: TelegramUpdate) => Promise<unknown>;

export type AcceptUpdateResult = 'processed' | 'duplicate';

/**
 * Claim an `update_id`. Returns `true` only for the first delivery; a retry returns `false`
 * because the INSERT hits the primary key and `DO NOTHING` yields no row.
 */
export async function claimUpdate(updateId: number): Promise<boolean> {
  const result = await query(
    `INSERT INTO bot_updates (update_id) VALUES ($1)
     ON CONFLICT (update_id) DO NOTHING
     RETURNING update_id`,
    [updateId],
  );
  return result.rows.length > 0;
}

/**
 * Dedup + process. The caller passes the processor explicitly (the route passes the
 * dispatcher) so the dedup proof is independent of the dispatcher implementation.
 */
export async function acceptTelegramUpdate(
  update: TelegramUpdate,
  process: TelegramUpdateProcessor,
): Promise<AcceptUpdateResult> {
  const claimed = await claimUpdate(update.update_id);
  if (!claimed) return 'duplicate';
  await process(update);
  return 'processed';
}

/**
 * Single-user fallback: the sole owner account.
 *
 * Used ONLY where a link genuinely does not apply (a chat with no `bot_links` row, e.g. an
 * unlinked chat that must still receive the `/link` instruction, or a callback with no
 * chat). A linked chat resolves its user from the link instead - see
 * `resolveActingChatContext`.
 */
async function resolveActingUserId(): Promise<number | null> {
  const result = await query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
  const id = result.rows[0]?.id;
  return id == null ? null : Number(id);
}

export interface BotChatContext {
  userId: number;
  /** Link's `active_profile_id`, or null for the fallback / all-profiles. */
  profileId: number | null;
  /** True when the context came from an active `bot_links` row. */
  linked: boolean;
}

/**
 * Resolve the acting user/profile for a chat FROM THE LINK (checkbox 94): the link's
 * `user_id` is the acting user and its `active_profile_id` is the default profile. The
 * single-user fallback applies only when the chat has no active link (which the command
 * dispatcher then refuses anyway, unless the command is `/link`).
 */
export async function resolveActingChatContext(
  platform: BotPlatform,
  chatId: string,
): Promise<BotChatContext | null> {
  const link = await getActiveBotLink(platform, chatId);
  if (link) return { userId: link.userId, profileId: link.activeProfileId, linked: true };
  const fallback = await resolveActingUserId();
  return fallback === null ? null : { userId: fallback, profileId: null, linked: false };
}

/** Acting user for the callback path: link first, single-user fallback otherwise. */
async function resolveLinkedActingUserId(
  platform: BotPlatform,
  chatId: string | null,
): Promise<number | null> {
  if (chatId) {
    const link = await getActiveBotLink(platform, chatId);
    if (link) return link.userId;
  }
  return resolveActingUserId();
}

async function resolveBotToken(userId: number): Promise<string | null> {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  const config = await getUserConfig(userId);
  const token = config?.telegram_bot_token;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

/**
 * Render the dispatcher's structured inline buttons into the Telegram wire shape.
 * Only `text` + `callback_data` are sent; never any user-visible extra fields.
 */
function toReplyMarkup(
  buttons: BotInlineButton[][],
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    ),
  };
}

/**
 * True when the message text arrived through a forward, a quote or a reply (checkbox 96).
 *
 * The dispatcher only acts on this for DESTRUCTIVE commands: a forwarded copy of `/unlink`
 * must not revoke the victim's link, and a quoted command block must not be executed as if
 * the sender had typed it themselves.
 */
export function isForwardedOrQuoted(message: TelegramMessage): boolean {
  return (
    message.forward_origin != null ||
    message.forward_from != null ||
    message.forward_date != null ||
    message.quote != null ||
    message.reply_to_message != null
  );
}

/**
 * Webhook-level seams. Everything is optional: production wiring uses the real limiter,
 * the pino security emitter, the real redactor and the real data services.
 */
export interface TelegramProcessorDeps extends DispatcherDeps {
  /** Per-chat command limiter (checkbox 96); defaults to the process-wide limiter. */
  rateLimit?: BotRateLimitCheck;
}

/**
 * Default update processor: `callback_query` taps go to the inline-keyboard handler (93);
 * message text is rate-limited (96), then dispatched through the command dispatcher and
 * replied to via `sendMessage`. Only explicit slash commands do anything; other text is data.
 */
export async function processTelegramUpdate(
  update: TelegramUpdate,
  deps: TelegramProcessorDeps = {},
): Promise<unknown> {
  // A button tap carries no command text of its own; it must never fall through to the
  // dispatcher even when the attached message text happens to start with a slash.
  if (update.callback_query) {
    return handleTelegramCallbackQuery(update.callback_query, {
      resolveUserId: (chatId) => resolveLinkedActingUserId('telegram', chatId),
      resolveBotToken,
    });
  }

  const message = update.message ?? update.edited_message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (chatId == null || typeof text !== 'string' || text.trim() === '') {
    return { handled: false };
  }

  const chatIdText = String(chatId);
  const security = deps.security ?? defaultBotSecurityEmitter;

  // Checkbox 96: per-chat rate limit BEFORE any link/data access. The limiter is in-memory
  // and bounded, so a burst of 100 commands adds ZERO database queries (the plan's QA case:
  // a naive DB-backed limiter would open a query per command and exhaust connections).
  const rateLimitCheck = deps.rateLimit ?? botRateLimiter.check;
  const decision = rateLimitCheck(chatIdText);
  if (!decision.allowed) {
    const reason = decision.reason === 'day' ? 'day' : 'minute';
    emitBotSecurityEvent(security, {
      event: reason === 'day' ? BOT_SECURITY_EVENTS.dailyCapReached : BOT_SECURITY_EVENTS.rateLimited,
      platform: 'telegram',
      chatId: sanitizeSecurityField(chatIdText),
      reason,
      ...(decision.retryAfterMs == null ? {} : { retryAfterMs: decision.retryAfterMs }),
    });

    const token = await resolveRefusalBotToken(chatIdText);
    if (!token) {
      log.warn({ event: 'bot.refusal_token_missing', reason }, 'Cannot send rate-limit refusal: no token');
      return { handled: true, replied: false, rateLimited: reason };
    }
    // Friendly text only; the internal decision never reaches the chat.
    await sendTelegramMessage(token, { chatId: chatIdText, text: botRateLimitMessage(reason) });
    return { handled: true, replied: true, rateLimited: reason };
  }

  const context = await resolveActingChatContext('telegram', chatIdText);
  if (context === null) return { handled: false };

  const reply = await dispatchCommand(
    {
      platform: 'telegram',
      chatId: chatIdText,
      userId: context.userId,
      profileId: context.profileId,
      text,
      chatType: message?.chat?.type ?? null,
      fromForwardedOrQuoted: message !== undefined && isForwardedOrQuoted(message),
    },
    deps,
  );

  // Activity heartbeat for linked chats. A failed touch must not fail the webhook: the
  // update is already claimed, so a throw here would leave the user without a reply.
  if (context.linked) {
    try {
      await touchBotLink('telegram', chatIdText);
    } catch (error: unknown) {
      const err = error instanceof Error ? error.message : String(error);
      log.warn({ event: 'bot.link_touch_failed', err }, 'Failed to update bot link last_seen_at');
    }
  }

  if (!reply) return { handled: false };

  const token = await resolveBotToken(context.userId);
  if (!token) {
    log.warn({ event: 'bot.reply_token_missing' }, 'Cannot send bot reply: no Telegram token configured');
    return { handled: true, replied: false };
  }
  const replyMarkup = reply.inlineKeyboard && reply.inlineKeyboard.length > 0
    ? toReplyMarkup(reply.inlineKeyboard)
    : undefined;
  // Checkbox 95: handlers may provide a MarkdownV2 rendering; prefer it and declare the
  // parse mode explicitly. The plain `text` stays the representation for handlers that do
  // not opt in (and for transports without MarkdownV2).
  await sendTelegramMessage(token, {
    chatId: String(chatId),
    text: reply.markdownText ?? reply.text,
    parseMode: reply.markdownText ? 'MarkdownV2' : undefined,
    replyMarkup,
  });
  return { handled: true, replied: true };
}

/**
 * Token for a rate-limit refusal. The env token avoids a database round-trip entirely;
 * only when it is absent does the refusal fall back to the linked user's configured token
 * (the refusal must be deliverable even from a chat that is not linked).
 */
async function resolveRefusalBotToken(chatId: string): Promise<string | null> {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  const userId = await resolveLinkedActingUserId('telegram', chatId);
  return userId == null ? null : resolveBotToken(userId);
}
