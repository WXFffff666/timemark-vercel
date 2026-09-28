import { createLogger } from '../../utils/logger.js';
import { answerCallbackQuery, editMessageText, type EditMessageTextParams } from './telegram-api.js';
import { defaultBotCallbackProvider } from './bot-data.service.js';
import { decodeCallbackData, formatSnoozeLabel } from './callback-data.js';
import type { TelegramCallbackQuery } from './telegram-webhook.js';

/**
 * Telegram inline-keyboard callback handler (checkbox 93).
 *
 * Every delivered `callback_query` is answered with `answerCallbackQuery` - including
 * malformed data and stale entities - so the Telegram client spinner always stops. Actions
 * are idempotent at the ACTION level, because `update_id` dedup (checkbox 91) cannot help
 * here: each button TAP is a distinct update with its own id.
 *
 * Idempotency semantics (explicit and tested):
 *  - `done`: the handler first checks the existing completion store (`todo_completions` via
 *    `provider.findTodo`). A second tap on an already-completed todo is a no-op: no second
 *    completion row and no repeated side effect - just the "已处理" toast and an idempotent
 *    edit of the message to its completed state.
 *  - `snooze`: each ACCEPTED tap extends the reminder's next fire time by exactly the
 *    button's own duration once (`next_occurrence += minutes`); two taps of "延后 10 分钟"
 *    therefore extend by 20 minutes total. A redelivery of the same update_id never reaches
 *    this handler (checkbox 91 claims it), and a snooze on a completed/removed todo is
 *    refused before any mutation. No accidental double-application exists per tap.
 *  - `open`: no mutation at all; it only answers with a hint to open the app.
 */

const log = createLogger('bot.callbacks');

/** Toast strings are intentionally short (Telegram caps `text` at 200 bytes). */
const ANSWER_INVALID = '无法识别该操作';
const ANSWER_MISSING = '该事项已不存在';
const ANSWER_ALREADY = '该事项已处理';
const ANSWER_OPEN = '请在 TimeMark 应用中查看';
const ANSWER_FAILED = '操作失败，请稍后重试';

/** An empty inline keyboard removes the buttons after a terminal action. */
const REMOVE_KEYBOARD = { inline_keyboard: [] };

const UNTITLED = '未命名事项';

export interface BotTodoLookup {
  eventId: number;
  title: string;
  /** Occurrence date, YYYY-MM-DD. */
  date: string;
  /** True when the completion store already has a row for this todo occurrence. */
  completed: boolean;
}

/** Data-access seam for callback actions (defaults to the real services). */
export interface BotCallbackProvider {
  findTodo(userId: number, eventId: number): Promise<BotTodoLookup | null>;
  completeTodo(userId: number, eventId: number, occurrenceDate: string): Promise<void>;
  snoozeTodo(userId: number, eventId: number, minutes: number): Promise<void>;
}

export type AnswerCallbackQueryFn = (
  botToken: string,
  params: { callbackQueryId: string; text?: string },
) => Promise<unknown>;

export type EditMessageTextFn = (botToken: string, params: EditMessageTextParams) => Promise<unknown>;

export interface CallbackHandlerDeps {
  /**
   * Resolve the acting user for the chat the button lives in (checkbox 94): the default
   * resolver reads `bot_links` first and only falls back to the single-user account when
   * the chat is genuinely unlinked. `chatId` is null when the query carries no message.
   */
  resolveUserId: (chatId: string | null) => Promise<number | null>;
  resolveBotToken: (userId: number) => Promise<string | null>;
  provider?: BotCallbackProvider;
  answer?: AnswerCallbackQueryFn;
  editText?: EditMessageTextFn;
}

export type CallbackOutcome =
  | 'done' | 'snoozed' | 'open' | 'already_done' | 'missing' | 'invalid' | 'failed' | 'no_user' | 'no_token';

export interface CallbackHandleResult {
  handled: boolean;
  outcome: CallbackOutcome;
}

/**
 * Plain-text safety for a title interpolated into an edited message. We deliberately do NOT
 * set `parse_mode` on callback edits (MarkdownV2 rendering is checkbox 95), so the only
 * hardening needed here is to strip control characters and cap the length so a hostile title
 * cannot break the message layout or the API call.
 */
function plainTitle(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- intentionally strips ASCII control characters (Telegram message safety)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 120) || UNTITLED;
}

/**
 * Handle one `callback_query`. Never throws for stale/invalid input: the caller (the webhook
 * processor) must keep ACKing Telegram with HTTP 200 either way.
 */
export async function handleTelegramCallbackQuery(
  query: TelegramCallbackQuery,
  deps: CallbackHandlerDeps,
): Promise<CallbackHandleResult> {
  const answer = deps.answer ?? answerCallbackQuery;
  const editText = deps.editText ?? editMessageText;
  const provider = deps.provider ?? defaultBotCallbackProvider;

  const callbackId = typeof query.id === 'string' ? query.id.trim() : '';
  if (!callbackId) return { handled: false, outcome: 'invalid' };

  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  const userId = await deps.resolveUserId(chatId == null ? null : String(chatId));
  if (userId === null) return { handled: false, outcome: 'no_user' };

  const token = await deps.resolveBotToken(userId);
  if (!token) {
    log.warn({ event: 'bot.callback_token_missing' }, 'Cannot answer callback query: no Telegram token configured');
    return { handled: false, outcome: 'no_token' };
  }

  /**
   * ALWAYS answer - even when the action is stale or malformed - so the client spinner stops.
   * An answer failure is logged but must not fail the webhook (Telegram would retry forever).
   */
  const toast = async (text: string): Promise<void> => {
    try {
      await answer(token, { callbackQueryId: callbackId, text });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ event: 'bot.callback_answer_failed', err: message }, 'answerCallbackQuery failed');
    }
  };

  /** Edit the original message in place; a rejected no-op edit is tolerated. */
  const edit = async (text: string, replyMarkup?: unknown): Promise<void> => {
    if (chatId == null || typeof messageId !== 'number') return;
    try {
      await editText(token, { chatId: String(chatId), messageId, text, replyMarkup });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.info(
        { event: 'bot.callback_edit_skipped', messageId, err: message },
        'Callback message edit skipped (message may be unchanged or gone)',
      );
    }
  };

  const parsed = decodeCallbackData(query.data);
  if (!parsed) {
    await toast(ANSWER_INVALID);
    return { handled: false, outcome: 'invalid' };
  }

  if (parsed.action === 'open') {
    await toast(ANSWER_OPEN);
    return { handled: true, outcome: 'open' };
  }

  let todo: BotTodoLookup | null;
  try {
    todo = await provider.findTodo(userId, parsed.id);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ event: 'bot.callback_lookup_failed', err: message }, 'Callback todo lookup failed');
    await toast(ANSWER_FAILED);
    return { handled: true, outcome: 'failed' };
  }

  if (!todo) {
    // Deleted (or never visible to this user): friendly toast, no error.
    await toast(ANSWER_MISSING);
    await edit(`⚠️ ${ANSWER_MISSING}`, REMOVE_KEYBOARD);
    return { handled: true, outcome: 'missing' };
  }

  if (todo.completed) {
    // Second tap (or a stale tap after completing elsewhere): a no-op with a friendly toast.
    // The edit is idempotent, so repeating it keeps the same completed state.
    await toast(ANSWER_ALREADY);
    await edit(`✅ 已完成：${plainTitle(todo.title)}`, REMOVE_KEYBOARD);
    return { handled: true, outcome: 'already_done' };
  }

  try {
    if (parsed.action === 'done') {
      await provider.completeTodo(userId, todo.eventId, todo.date);
      await toast('✅ 已完成');
      await edit(`✅ 已完成：${plainTitle(todo.title)}`, REMOVE_KEYBOARD);
      return { handled: true, outcome: 'done' };
    }

    // snooze: decode guarantees a bounded positive `minutes`.
    const minutes = parsed.minutes ?? 0;
    await provider.snoozeTodo(userId, todo.eventId, minutes);
    const label = formatSnoozeLabel(minutes);
    await toast(`⏰ 已延后 ${label}`);
    // Preserve the inline keyboard from the tapped message so the user can extend again.
    await edit(`⏰ 已延后 ${label}：${plainTitle(todo.title)}`, query.message?.reply_markup);
    return { handled: true, outcome: 'snoozed' };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ event: 'bot.callback_action_failed', action: parsed.action, err: message }, 'Callback action failed');
    await toast(ANSWER_FAILED);
    return { handled: true, outcome: 'failed' };
  }
}
