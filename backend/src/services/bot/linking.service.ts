import { createHash, randomBytes } from 'crypto';
import { query } from '../../db/index.js';

/**
 * Checkbox 94: chat <-> user/profile linking with an audit trail.
 *
 * A chat is NEVER auto-linked on first message: it becomes linked only by consuming a
 * short-lived, single-use code that an authenticated user generated from Settings
 * (`createBotLinkCode`). Only the SHA-256 HASH of the code is stored, and the raw value is
 * returned exactly once at creation. The code is claimed with an atomic
 * `UPDATE ... WHERE used_at IS NULL AND expires_at > CURRENT_TIMESTAMP` so a code can be
 * redeemed at most once.
 *
 * `UNIQUE (platform, chat_id)` on `bot_links` plus an `ON CONFLICT ... DO UPDATE` upsert make
 * a repeated `/link` from the same chat an UPDATE (one row), never a duplicate.
 *
 * The audit row keeps only a whitelist-built redacted shape (command + argument count/kind).
 * Argument VALUES - link codes, tokens, titles - are never part of `args_redacted`.
 */

export const BOT_PLATFORMS = ['telegram'] as const;
export type BotPlatform = (typeof BOT_PLATFORMS)[number];

/** Raw link codes are 22 base64url chars; these bounds reject obvious garbage before hashing. */
export const MIN_LINK_CODE_LENGTH = 16;
export const MAX_LINK_CODE_LENGTH = 64;

/** Link codes expire 10 minutes after creation. */
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

/** Telegram chat ids are numeric and far shorter; bound what we are willing to store/compare. */
export const MAX_CHAT_ID_LENGTH = 64;

const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** SHA-256 hash - the only representation of a link code that is ever stored. */
export function hashLinkCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** 128-bit URL-safe code; the raw value is returned once and never persisted. */
export function generateLinkCode(): { code: string; codeHash: string } {
  const code = randomBytes(16).toString('base64url');
  return { code, codeHash: hashLinkCode(code) };
}

/**
 * Shape check for an untrusted code BEFORE any database work: a non-string, an
 * under/over-length value and any character outside base64url are rejected outright.
 * A well-formed but never-issued code still goes through the lookup and comes back
 * `invalid` (indistinguishable from a wrong code, on purpose).
 */
export function isValidLinkCodeShape(code: unknown): code is string {
  return (
    typeof code === 'string' &&
    code.length >= MIN_LINK_CODE_LENGTH &&
    code.length <= MAX_LINK_CODE_LENGTH &&
    LINK_CODE_PATTERN.test(code)
  );
}

export interface CreatedBotLinkCode {
  code: string;
  expiresAt: Date;
}

/** Generate a single-use code for the authenticated user. The raw code is returned ONCE. */
export async function createBotLinkCode(userId: number, now: Date = new Date()): Promise<CreatedBotLinkCode> {
  const { code, codeHash } = generateLinkCode();
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
  await query(
    `INSERT INTO bot_link_codes (user_id, code_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, codeHash, expiresAt],
  );
  return { code, expiresAt };
}

export interface ActiveBotLink {
  id: number;
  userId: number;
  platform: string;
  chatId: string;
  chatType: string | null;
  activeProfileId: number | null;
}

interface BotLinkRow {
  id: unknown;
  user_id: unknown;
  platform: unknown;
  chat_id: unknown;
  chat_type?: unknown;
  active_profile_id?: unknown;
}

function toLink(row: BotLinkRow): ActiveBotLink {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    platform: String(row.platform),
    chatId: String(row.chat_id),
    chatType: row.chat_type == null ? null : String(row.chat_type),
    activeProfileId: row.active_profile_id == null ? null : Number(row.active_profile_id),
  };
}

export interface UpsertBotLinkInput {
  userId: number;
  platform: BotPlatform;
  chatId: string;
  chatType: string | null;
}

/**
 * Insert or refresh the link for `(platform, chat_id)`.
 *
 * The upsert is what makes a second `/link` from the same chat update the existing row
 * instead of creating a duplicate; `UNIQUE (platform, chat_id)` is the schema backstop.
 * A previously revoked chat is resurrected by clearing `revoked_at`, and the stored
 * `active_profile_id` is intentionally preserved across re-links.
 */
export async function upsertBotLink(input: UpsertBotLinkInput): Promise<ActiveBotLink> {
  const result = await query(
    `INSERT INTO bot_links (user_id, platform, chat_id, chat_type, linked_at, last_seen_at, revoked_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
     ON CONFLICT (platform, chat_id) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           chat_type = COALESCE(EXCLUDED.chat_type, bot_links.chat_type),
           linked_at = CURRENT_TIMESTAMP,
           last_seen_at = CURRENT_TIMESTAMP,
           revoked_at = NULL
     RETURNING id, user_id, platform, chat_id, chat_type, active_profile_id`,
    [input.userId, input.platform, input.chatId, input.chatType],
  );
  return toLink(result.rows[0] as BotLinkRow);
}

export type BotLinkCodeStatus = 'linked' | 'used' | 'expired' | 'invalid';

export interface BotLinkCodeConsumeResult {
  status: BotLinkCodeStatus;
  userId?: number;
  profileId?: number | null;
}

export interface ConsumeBotLinkCodeInput {
  code: unknown;
  platform: BotPlatform;
  chatId: string;
  chatType?: string | null;
}

/**
 * Redeem a code for a chat.
 *
 * Distinct outcomes (the dispatcher renders a distinct message for each, so a user can tell
 * "expired" from "already used"):
 *  - `linked`  - the code was unexpired and unused; it is now consumed and the link upserted
 *  - `used`    - the code existed but was already redeemed
 *  - `expired` - the code existed but its TTL passed
 *  - `invalid` - malformed / unknown code (or malformed chat id)
 */
export async function consumeBotLinkCode(input: ConsumeBotLinkCodeInput): Promise<BotLinkCodeConsumeResult> {
  if (!isValidLinkCodeShape(input.code)) return { status: 'invalid' };
  if (typeof input.chatId !== 'string' || !input.chatId || input.chatId.length > MAX_CHAT_ID_LENGTH) {
    return { status: 'invalid' };
  }

  const codeHash = hashLinkCode(input.code);
  const claimed = await query(
    `UPDATE bot_link_codes
        SET used_at = CURRENT_TIMESTAMP
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      RETURNING user_id`,
    [codeHash],
  );
  const claimedRow = claimed.rows[0] as { user_id: unknown } | undefined;
  if (!claimedRow) {
    // Nothing claimed: tell "used" / "expired" apart for the user-facing hint, or invalid.
    const existing = await query(
      `SELECT used_at, expires_at FROM bot_link_codes WHERE code_hash = $1`,
      [codeHash],
    );
    const row = existing.rows[0] as { used_at: unknown; expires_at: unknown } | undefined;
    if (!row) return { status: 'invalid' };
    if (row.used_at != null) return { status: 'used' };
    return { status: 'expired' };
  }

  const userId = Number(claimedRow.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return { status: 'invalid' };

  const link = await upsertBotLink({
    userId,
    platform: input.platform,
    chatId: input.chatId,
    chatType: input.chatType ?? null,
  });
  return { status: 'linked', userId, profileId: link.activeProfileId };
}

/** The active (non-revoked) link for a chat, or null. */
export async function getActiveBotLink(platform: string, chatId: string): Promise<ActiveBotLink | null> {
  if (!platform || typeof chatId !== 'string' || !chatId || chatId.length > MAX_CHAT_ID_LENGTH) return null;
  const result = await query(
    `SELECT id, user_id, platform, chat_id, chat_type, active_profile_id
       FROM bot_links
      WHERE platform = $1 AND chat_id = $2 AND revoked_at IS NULL`,
    [platform, chatId],
  );
  const row = result.rows[0] as BotLinkRow | undefined;
  return row ? toLink(row) : null;
}

/** `/unlink`: soft-revoke. Returns false when the chat had no active link. */
export async function revokeBotLink(platform: string, chatId: string): Promise<boolean> {
  const result = await query(
    `UPDATE bot_links
        SET revoked_at = CURRENT_TIMESTAMP
      WHERE platform = $1 AND chat_id = $2 AND revoked_at IS NULL`,
    [platform, chatId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Refresh `last_seen_at` for an active link (activity heartbeat). */
export async function touchBotLink(platform: string, chatId: string): Promise<void> {
  await query(
    `UPDATE bot_links
        SET last_seen_at = CURRENT_TIMESTAMP
      WHERE platform = $1 AND chat_id = $2 AND revoked_at IS NULL`,
    [platform, chatId],
  );
}

export interface BotAuditEntry {
  userId: number;
  platform: string;
  chatId: string;
  command: string;
  argsRedacted: string;
  result: string;
}

/** One row per executed command; `argsRedacted` is always a whitelist-built shape. */
export async function writeBotAuditLog(entry: BotAuditEntry): Promise<void> {
  await query(
    `INSERT INTO bot_audit_logs (user_id, platform, chat_id, command, args_redacted, result)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.userId, entry.platform, entry.chatId, entry.command, entry.argsRedacted, entry.result],
  );
}

/** Argument kinds recorded in the audit - never the values themselves. */
export const REDACTED_ARG_KINDS = ['integer', 'date', 'time', 'text'] as const;
export type RedactedArgKind = (typeof REDACTED_ARG_KINDS)[number];

const MAX_REDACTED_ARGS = 16;

function classifyArgument(value: string): RedactedArgKind {
  if (/^\d{1,9}$/.test(value)) return 'integer';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  if (/^\d{1,2}:\d{2}$/.test(value)) return 'time';
  return 'text';
}

/** Printable, bounded label so a hostile command name cannot smuggle control characters. */
export function sanitizeAuditText(value: unknown, maxLength = 32): string {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, '?').slice(0, maxLength);
}

/**
 * Build `args_redacted` by WHITELIST: the command name, the argument count and each
 * argument's kind. Values are never copied - not even truncated - so no code/token/title
 * substring can survive into the audit row.
 */
export function redactCommandArgs(command: string, rawArgs: string): string {
  const args = typeof rawArgs === 'string' && rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
  const argKinds = args.slice(0, MAX_REDACTED_ARGS).map(classifyArgument);
  return JSON.stringify({ command: sanitizeAuditText(command, 32), argCount: args.length, argKinds });
}
