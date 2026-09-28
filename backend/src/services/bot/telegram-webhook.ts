import { query } from '../../db/index.js';

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
 * Default update processor.
 *
 * Checkbox 91 ships only the webhook transport, secret verification and dedup; checkbox 92
 * replaces this body with the command dispatcher. Kept as a single injectable seam so the
 * dedup test can substitute a spy and prove a retried `update_id` never runs twice.
 */
export async function processTelegramUpdate(): Promise<unknown> {
  return { handled: false };
}
