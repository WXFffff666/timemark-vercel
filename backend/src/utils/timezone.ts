/**
 * 171 - IANA timezone validation + graceful degradation.
 *
 * Contract:
 * - Write boundaries REJECT invalid IANA names via `isValidIanaTimezone`.
 * - Already-stored invalid values DEGRADE to `Asia/Shanghai` with a logged
 *   warning via `normalizeTimezone`; a bad row must never crash a render or
 *   a send (the central `Intl` crash guard lives in
 *   `@timemark/shared/habit-schedule`'s `dateStringInTimeZone`).
 */
import { logger } from './logger.js';

export const FALLBACK_TIMEZONE = 'Asia/Shanghai';
export const MAX_TIMEZONE_LENGTH = 64;

/** Single-segment aliases (UTC, GMT, ...) and `Area/Location[/Sub]` ids. */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * True only for a string `Intl` accepts as an IANA timezone. Length-bounded
 * and shape-checked before the (relatively expensive) `Intl` probe.
 */
export function isValidIanaTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const tz = value.trim();
  if (tz.length === 0 || tz.length > MAX_TIMEZONE_LENGTH) return false;
  if (!IANA_SHAPE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the trimmed value when it is a valid IANA timezone; otherwise
 * logs a warning (only for non-empty malformed input - null/empty simply
 * means "not set") and returns the safe fallback.
 */
export function normalizeTimezone(value: unknown, context = 'unknown'): string {
  if (typeof value === 'string') {
    const tz = value.trim();
    if (isValidIanaTimezone(tz)) return tz;
    if (tz !== '') {
      logger.warn(`Invalid IANA timezone "${tz}" at ${context}; degrading to ${FALLBACK_TIMEZONE}`);
    }
  }
  return FALLBACK_TIMEZONE;
}
