/**
 * Per-chat command rate limiting for the Telegram bot (checkbox 96).
 *
 * Numbers chosen (configurable, exported):
 *  - `BOT_RATE_LIMIT_PER_MINUTE = 20` - a human never sends 20 commands in a minute; a burst
 *    script does. Sliding fixed window per chat, reset after `BOT_RATE_LIMIT_WINDOW_MS`.
 *  - `BOT_RATE_LIMIT_PER_DAY = 200`  - hard daily cap per chat (10 minutes at full burst
 *    rate). Deliberately NOT the Neon-friendly DB path: the state is a bounded in-memory
 *    Map, so a 100-command burst adds ZERO database queries (the plan's QA failure case:
 *    a naive DB-per-command limiter would exhaust the connection pool).
 *
 * Serverless note: memory is per instance, which is the correct trade-off here - a
 * determined attacker is still capped per warm instance and the DB stays untouched. The
 * state is bounded by `BOT_RATE_LIMIT_MAX_TRACKED_CHATS`, so hostile chat ids cannot grow
 * the map without limit.
 */

export const BOT_RATE_LIMIT_PER_MINUTE = 20;
export const BOT_RATE_LIMIT_PER_DAY = 200;
export const BOT_RATE_LIMIT_WINDOW_MS = 60_000;
export const BOT_RATE_LIMIT_MAX_TRACKED_CHATS = 10_000;

export type BotRateLimitReason = 'minute' | 'day';

export interface BotRateLimitDecision {
  allowed: boolean;
  reason?: BotRateLimitReason;
  /** Milliseconds until the minute window resets (minute refusals only). */
  retryAfterMs?: number;
  remainingInMinute?: number;
  remainingToday?: number;
}

export interface BotRateLimiterLimits {
  perMinute: number;
  perDay: number;
}

export interface BotRateLimiterOptions {
  perMinute?: number;
  perDay?: number;
  windowMs?: number;
  maxTrackedChats?: number;
  /** Injectable clock (ms since epoch) for deterministic boundary tests. */
  now?: () => number;
}

export interface BotRateLimiter {
  /** Count one command for `chatId` and decide whether it may run. */
  check(chatId: string): BotRateLimitDecision;
  /** Drop all counters (tests / operational reset). */
  reset(): void;
  readonly limits: BotRateLimiterLimits;
}

interface ChatWindow {
  minuteCount: number;
  minuteResetAt: number;
  dayKey: string;
  dayCount: number;
}

/** UTC day key; the daily cap is intentionally timezone-independent. */
function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createBotRateLimiter(options: BotRateLimiterOptions = {}): BotRateLimiter {
  const perMinute = options.perMinute ?? BOT_RATE_LIMIT_PER_MINUTE;
  const perDay = options.perDay ?? BOT_RATE_LIMIT_PER_DAY;
  const windowMs = options.windowMs ?? BOT_RATE_LIMIT_WINDOW_MS;
  const maxTracked = options.maxTrackedChats ?? BOT_RATE_LIMIT_MAX_TRACKED_CHATS;
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, ChatWindow>();

  /** Keep the Map bounded: first drop expired windows, then oldest-inserted entries. */
  const prune = (currentMs: number): void => {
    if (windows.size <= maxTracked) return;
    for (const [key, window] of windows) {
      if (window.minuteResetAt <= currentMs) windows.delete(key);
    }
    while (windows.size > maxTracked) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
  };

  return {
    limits: { perMinute, perDay },

    check(chatId: string): BotRateLimitDecision {
      const currentMs = now();
      const dayKey = utcDayKey(currentMs);
      let window = windows.get(chatId);

      if (!window) {
        window = { minuteCount: 0, minuteResetAt: currentMs + windowMs, dayKey, dayCount: 0 };
        windows.set(chatId, window);
      } else {
        if (window.minuteResetAt <= currentMs) {
          window.minuteCount = 0;
          window.minuteResetAt = currentMs + windowMs;
        }
        if (window.dayKey !== dayKey) {
          window.dayKey = dayKey;
          window.dayCount = 0;
        }
      }

      if (window.dayCount >= perDay) {
        return {
          allowed: false,
          reason: 'day',
          remainingInMinute: Math.max(0, perMinute - window.minuteCount),
          remainingToday: 0,
        };
      }
      if (window.minuteCount >= perMinute) {
        return {
          allowed: false,
          reason: 'minute',
          retryAfterMs: Math.max(0, window.minuteResetAt - currentMs),
          remainingInMinute: 0,
          remainingToday: Math.max(0, perDay - window.dayCount),
        };
      }

      window.minuteCount += 1;
      window.dayCount += 1;
      prune(currentMs);
      return {
        allowed: true,
        remainingInMinute: perMinute - window.minuteCount,
        remainingToday: perDay - window.dayCount,
      };
    },

    reset(): void {
      windows.clear();
    },
  };
}

/** Friendly refusal texts - never a stack trace, never an internal detail. */
export function botRateLimitMessage(
  reason: BotRateLimitReason,
  limits: BotRateLimiterLimits = { perMinute: BOT_RATE_LIMIT_PER_MINUTE, perDay: BOT_RATE_LIMIT_PER_DAY },
): string {
  return reason === 'day'
    ? `📵 今日命令次数已达上限（${limits.perDay} 条），请明天再试。`
    : `⏳ 操作太频繁了：每个聊天每分钟最多 ${limits.perMinute} 条命令，请稍后再试。`;
}

/** The `check` shape the webhook consumes; keeps the limiter object out of the call site. */
export type BotRateLimitCheck = (chatId: string) => BotRateLimitDecision;

/** Process-wide limiter used by the Telegram webhook. */
export const botRateLimiter: BotRateLimiter = createBotRateLimiter();
