import { escapeMarkdownV2 } from './markdown.js';

/**
 * Outbound secret redaction (checkbox 96).
 *
 * Requirement (c): no bot token, webhook secret, API key or full document number may ever
 * appear in a bot message. Two independent layers enforce it:
 *
 *  1. KNOWN VALUES - every configured secret (env var values, and anything a caller passes
 *     in) is scrubbed literally, INCLUDING its MarkdownV2-escaped rendering, because the
 *     rich reply is what actually leaves the process.
 *  2. SHAPES - credential/document patterns (Telegram bot token, `sk-`/`ghp_`/`xox`/`AIza`
 *     keys, Chinese ID cards, 15+ digit document numbers) are scrubbed even when the value
 *     was never configured on this instance (e.g. it was stored in an event title earlier).
 *
 * The placeholder deliberately contains no MarkdownV2 reserved ASCII characters, so a
 * redacted rich reply stays valid MarkdownV2.
 */

/** Replaces every secret occurrence. Free of MarkdownV2 reserved characters. */
export const REDACTION_PLACEHOLDER = '（已隐藏）';

/** Environment variables whose VALUES must never be echoed into a chat. */
export const SECRET_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'CRON_SECRET',
  'JWT_SECRET',
  'MASTER_KEY',
  'HEALTH_DETAIL_TOKEN',
  'TURNSTILE_SECRET_KEY',
  'RESEND_API_KEY',
  'DATABASE_URL',
] as const;

/** Shorter values are ignored so a tiny/degenerate env value cannot mangle normal text. */
export const MIN_SECRET_LENGTH = 6;

export type RedactionKind =
  | 'known_secret'
  | 'telegram_bot_token'
  | 'api_key'
  | 'document_number';

interface SecretPattern {
  kind: RedactionKind;
  pattern: RegExp;
}

/**
 * Shape patterns, applied to BOTH the plain text and the MarkdownV2 rendering. Separators
 * may be backslash-escaped in the rich form (`\-`, `\_`), hence the `\\?` / `\\-` forms.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Telegram bot token: "<bot id>:<secret>" e.g. 123456789:AAH... (35 chars).
  { kind: 'telegram_bot_token', pattern: /\b\d{6,12}:[A-Za-z0-9_\\-]{25,}/g },
  { kind: 'api_key', pattern: /\bsk\\?-[A-Za-z0-9_\\-]{16,}/g },
  { kind: 'api_key', pattern: /\bghp_[A-Za-z0-9]{20,}/g },
  { kind: 'api_key', pattern: /\bxox[baprs]\\?-[A-Za-z0-9_\\-]{10,}/g },
  { kind: 'api_key', pattern: /\bAIza[0-9A-Za-z_\\-]{30,}/g },
  { kind: 'api_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // Chinese ID card (18th char may be X) and any 15+ digit document/card number.
  { kind: 'document_number', pattern: /\b\d{17}[\dXx]\b/g },
  { kind: 'document_number', pattern: /\b\d{15,}\b/g },
];

/**
 * Collect the literal secret values this instance must never echo: configured env secrets
 * (read lazily on every call so tests and runtime config changes are honoured) plus any
 * values the caller supplies explicitly.
 */
export function collectSecretValues(
  env: NodeJS.ProcessEnv = process.env,
  extra: readonly string[] = [],
): string[] {
  const values = new Set<string>();
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) values.add(value);
  }
  for (const value of extra) {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) values.add(value);
  }
  return [...values];
}

export interface RedactionResult {
  text: string;
  redacted: boolean;
  kinds: RedactionKind[];
}

/**
 * Scrub every known secret value and every credential/document shape from `text`.
 * Idempotent: running it over an already-redacted string is a no-op.
 */
export function redactSecrets(
  text: string,
  secrets: readonly string[] = collectSecretValues(),
): RedactionResult {
  let out = typeof text === 'string' ? text : String(text ?? '');
  const kinds = new Set<RedactionKind>();

  for (const secret of secrets) {
    // The rich reply carries the ESCAPED form, so both variants are scrubbed.
    const variants = new Set([secret, escapeMarkdownV2(secret)]);
    for (const variant of variants) {
      if (variant && out.includes(variant)) {
        out = out.split(variant).join(REDACTION_PLACEHOLDER);
        kinds.add('known_secret');
      }
    }
  }

  for (const { kind, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let matched = false;
    out = out.replace(pattern, () => {
      matched = true;
      return REDACTION_PLACEHOLDER;
    });
    pattern.lastIndex = 0;
    if (matched) kinds.add(kind);
  }

  return { text: out, redacted: kinds.size > 0, kinds: [...kinds] };
}

/** True when `text` carries a known secret value or a credential/document shape. */
export function containsSecretLike(
  text: string,
  secrets: readonly string[] = collectSecretValues(),
): boolean {
  return redactSecrets(text, secrets).redacted;
}

/** The injectable outbound-redaction seam; tests can disable it for a negative control. */
export type BotReplyRedactor = (text: string) => RedactionResult;

/** Production redactor: known env secrets + credential/document shapes. */
export const defaultBotReplyRedactor: BotReplyRedactor = (text) => redactSecrets(text);
