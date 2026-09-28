import { query } from '../../db/index.js';
import { getUserConfig } from '../config.service.js';
import { createLogger } from '../../utils/logger.js';
import { dispatchCommand, type BotInlineButton } from './dispatcher.js';
import { sendTelegramMessage } from './telegram-api.js';
import { handleTelegramCallbackQuery } from './callback-handler.js';

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
 * Resolve the acting user for this chat.
 *
 * Checkbox 94 seam: once `bot_links` exists, the (platform, chat_id) pair resolves to the
 * linked `user_id` here (and an unlinked chat is rejected by the dispatcher's link check).
 * Until then, the app is single-user by design, so the sole owner account is used.
 */
async function resolveActingUserId(): Promise<number | null> {
  const result = await query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
  const id = result.rows[0]?.id;
  return id == null ? null : Number(id);
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
 * Default update processor: `callback_query` taps go to the inline-keyboard handler (93);
 * message text is dispatched through the command dispatcher and replied to via `sendMessage`.
 * Only explicit slash commands do anything; other text is data.
 */
export async function processTelegramUpdate(update: TelegramUpdate): Promise<unknown> {
  // A button tap carries no command text of its own; it must never fall through to the
  // dispatcher even when the attached message text happens to start with a slash.
  if (update.callback_query) {
    return handleTelegramCallbackQuery(update.callback_query, {
      resolveUserId: resolveActingUserId,
      resolveBotToken,
    });
  }

  const message = update.message ?? update.edited_message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (chatId == null || typeof text !== 'string' || text.trim() === '') {
    return { handled: false };
  }

  const userId = await resolveActingUserId();
  if (userId === null) return { handled: false };

  const reply = await dispatchCommand({
    platform: 'telegram',
    chatId: String(chatId),
    userId,
    profileId: null,
    text,
  });
  if (!reply) return { handled: false };

  const token = await resolveBotToken(userId);
  if (!token) {
    log.warn({ event: 'bot.reply_token_missing' }, 'Cannot send bot reply: no Telegram token configured');
    return { handled: true, replied: false };
  }
  const replyMarkup = reply.inlineKeyboard && reply.inlineKeyboard.length > 0
    ? toReplyMarkup(reply.inlineKeyboard)
    : undefined;
  await sendTelegramMessage(token, { chatId: String(chatId), text: reply.text, replyMarkup });
  return { handled: true, replied: true };
}
