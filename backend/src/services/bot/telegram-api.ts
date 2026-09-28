import axios from 'axios';
import { createLogger } from '../../utils/logger.js';

/**
 * Minimal outbound Telegram Bot API client (checkbox 91/92).
 *
 * Follows the HTTP conventions of `services/notifications/telegram.service.ts`:
 * axios, an explicit 10s timeout, and structured error classification. The bot token
 * lives inside the request URL, so it is NEVER logged: failures are reported by method
 * name and the provider's own `description` text only.
 */
const log = createLogger('bot.telegram');

const TELEGRAM_API_BASE = (process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/$/, '');

export class TelegramApiError extends Error {
  readonly method: string;
  readonly status?: number;
  readonly description?: string;

  constructor(method: string, message: string, status?: number, description?: string) {
    super(message);
    this.name = 'TelegramApiError';
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

export interface TelegramApiOptions {
  timeoutMs?: number;
}

interface TelegramApiEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/** POST to an arbitrary Bot API method. Never logs the token-bearing URL. */
export async function callTelegramApi<T>(
  method: string,
  botToken: string,
  payload: Record<string, unknown>,
  opts: TelegramApiOptions = {},
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
  try {
    const response = await axios.post(url, payload, { timeout: opts.timeoutMs ?? 10000 });
    const body = response.data as TelegramApiEnvelope<T>;
    if (body && body.ok === false) {
      throw new TelegramApiError(
        method,
        `Telegram API ${method} failed: ${body.description || 'unknown error'}`,
        body.error_code,
        body.description,
      );
    }
    return body?.result as T;
  } catch (error: unknown) {
    if (error instanceof TelegramApiError) throw error;
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const description = (error.response?.data as { description?: string } | undefined)?.description
        || error.code
        || 'network error';
      log.warn({ event: 'bot.telegram_api_failed', method, status, description }, 'Telegram API call failed');
      throw new TelegramApiError(method, `Telegram API ${method} failed: ${description}`, status, description);
    }
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ event: 'bot.telegram_api_failed', method, err: message }, 'Telegram API call failed');
    throw new TelegramApiError(method, `Telegram API ${method} failed: ${message}`);
  }
}

export interface SetWebhookParams {
  url: string;
  secretToken: string;
  allowedUpdates: string[];
}

export async function setTelegramWebhook(botToken: string, params: SetWebhookParams): Promise<true> {
  return callTelegramApi<true>('setWebhook', botToken, {
    url: params.url,
    secret_token: params.secretToken,
    allowed_updates: params.allowedUpdates,
  });
}

export interface TelegramWebhookInfo {
  url?: string;
  has_custom_certificate?: boolean;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}

export async function getTelegramWebhookInfo(botToken: string): Promise<TelegramWebhookInfo> {
  return callTelegramApi<TelegramWebhookInfo>('getWebhookInfo', botToken, {});
}

export interface SendMessageParams {
  chatId: string;
  text: string;
  parseMode?: string;
  replyMarkup?: unknown;
}

export async function sendTelegramMessage(botToken: string, params: SendMessageParams): Promise<unknown> {
  const payload: Record<string, unknown> = { chat_id: params.chatId, text: params.text };
  if (params.parseMode) payload.parse_mode = params.parseMode;
  if (params.replyMarkup) payload.reply_markup = params.replyMarkup;
  return callTelegramApi<unknown>('sendMessage', botToken, payload);
}

export async function answerCallbackQuery(
  botToken: string,
  params: { callbackQueryId: string; text?: string },
): Promise<unknown> {
  const payload: Record<string, unknown> = { callback_query_id: params.callbackQueryId };
  if (params.text) payload.text = params.text;
  return callTelegramApi<unknown>('answerCallbackQuery', botToken, payload);
}
