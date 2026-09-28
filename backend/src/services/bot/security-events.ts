import { createLogger } from '../../utils/logger.js';

/**
 * Structured security events for the Telegram bot (checkbox 96).
 *
 * Every bot refusal (rate-limited, daily-capped, unlinked, forwarded-destructive,
 * secret-bearing command, malformed command) emits EXACTLY ONE structured event through
 * this module, so the event name is a STABLE contract for log-based alerting:
 *
 *   - `bot.security.rate_limited`            - per-chat minute window exhausted
 *   - `bot.security.daily_cap_reached`       - per-chat hard daily cap exhausted
 *   - `bot.security.unlinked_command`        - command from a chat with no active link
 *   - `bot.security.forwarded_destructive`   - destructive command arrived forwarded/quoted
 *   - `bot.security.command_blocked_secret`  - command text looked like a credential
 *   - `bot.security.malformed_command`       - slash-looking text that cannot be parsed
 *   - `bot.security.reply_redacted`          - outbound redaction scrubbed something
 *
 * The emitter NEVER receives a raw command argument, a token or a secret: only the event
 * name, the chat id (sanitized) and small ASCII identifiers/reasons.
 */

export const BOT_SECURITY_EVENTS = {
  rateLimited: 'bot.security.rate_limited',
  dailyCapReached: 'bot.security.daily_cap_reached',
  unlinkedCommand: 'bot.security.unlinked_command',
  forwardedDestructive: 'bot.security.forwarded_destructive',
  commandBlockedSecret: 'bot.security.command_blocked_secret',
  malformedCommand: 'bot.security.malformed_command',
  replyRedacted: 'bot.security.reply_redacted',
} as const;

export type BotSecurityEventName = (typeof BOT_SECURITY_EVENTS)[keyof typeof BOT_SECURITY_EVENTS];

export interface BotSecurityEvent {
  /** Stable, alertable event name (see `BOT_SECURITY_EVENTS`). */
  event: BotSecurityEventName;
  platform: string;
  chatId: string;
  /** Canonical command id when the refusal is tied to one. */
  command?: string;
  /** Short machine-readable reason, never user text. */
  reason?: string;
  /** Milliseconds until the limiter window resets (rate-limit events). */
  retryAfterMs?: number;
  /** Redaction kinds applied (reply_redacted only), e.g. `known_secret`. */
  redactions?: readonly string[];
}

/** Injection seam: tests capture events; production writes one pino line per event. */
export type BotSecurityEmitter = (event: BotSecurityEvent) => void;

const log = createLogger('bot.security');

/** Stable field bound, mirroring `sanitizeAuditText` in linking.service.ts. */
export const MAX_SECURITY_FIELD_LENGTH = 64;

/**
 * Printable, bounded ASCII so a hostile chat id/command name cannot smuggle control
 * characters or newlines into a log line.
 */
export function sanitizeSecurityField(value: unknown, maxLength = MAX_SECURITY_FIELD_LENGTH): string {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, '?').slice(0, maxLength);
}

/** Production emitter: ONE structured pino line with the stable `event` field. */
export const defaultBotSecurityEmitter: BotSecurityEmitter = (event) => {
  const { event: eventName, ...fields } = event;
  log.warn({ event: eventName, ...fields }, `bot security: ${eventName}`);
};

/**
 * Emit through `emitter`, swallowing sink failures: a broken log sink must never turn a
 * refusal into a thrown webhook error (Telegram would then retry forever).
 */
export function emitBotSecurityEvent(emitter: BotSecurityEmitter, event: BotSecurityEvent): void {
  try {
    emitter(event);
  } catch {
    // A failing security sink is not a command failure.
  }
}
