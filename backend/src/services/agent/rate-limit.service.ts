import type { Context, Next } from 'hono';
import { checkPgRateLimit } from '../pg-rate-limit.js';
import { hashAgentToken } from '../agent-tokens.service.js';
import { getClientIp } from '../../utils/client-ip.js';

/**
 * Checkbox 102 + task 110 (b): per-credential rate limits for the agent surface.
 *
 * The repo's generic `rateLimit` keys on IP + path only, which would let one token starve
 * every other caller behind the same NAT and would not bound a single runaway token. Here the
 * key is derived from the credential itself:
 *   - Bearer `tmt_` token -> sha256(token)  (per token, raw value never stored)
 *   - session / anything else -> client IP  (the session path still needs its own limit)
 *
 * TWO windows are enforced per credential (task 110):
 *   - `AGENT_RATE_LIMIT_MAX = 60` requests per rolling `AGENT_RATE_LIMIT_WINDOW_MS = 60s`, and
 *   - `AGENT_RATE_LIMIT_DAILY_MAX = 1000` requests per rolling 24h `:day` window.
 * The day window starts at the credential's first request and rolls after 24h - deliberately
 * NOT a calendar-day boundary, so no UTC-string slicing is involved (standing lesson from
 * issues.md) and the window is timezone-independent.
 *
 * PostgreSQL-backed fixed-window (serverless-safe, shared across invocations) with an
 * in-memory fallback when the DB is unreachable, mirroring `middleware/rate-limit.ts`. Both
 * windows keep the same fallback, so the limit never silently disappears when the DB is down.
 *
 * Refusals carry DISTINCT, documented errors: `rate_limited_minute` / `rate_limited_daily`
 * (plus `scope` + `retryAfterSeconds` and a `Retry-After` header), so a client can tell a
 * burst from a total daily exhaustion.
 */

export const AGENT_RATE_LIMIT_MAX = 60;
export const AGENT_RATE_LIMIT_WINDOW_MS = 60_000;
export const AGENT_RATE_LIMIT_DAILY_MAX = 1000;
export const AGENT_RATE_LIMIT_DAY_MS = 24 * 60 * 60 * 1000;

/** Which window refused a call. */
export type AgentRateLimitScope = 'minute' | 'daily';

export interface AgentRateLimitDecision {
  allowed: boolean;
  /** Refusal window; absent when allowed. */
  scope?: AgentRateLimitScope;
  /** Seconds until the refusing window resets (refusals only). */
  retryAfterSeconds?: number;
  /** Minute-window state for the `X-RateLimit-*` headers. */
  limit: number;
  remaining: number;
  resetAt: number;
}

interface WindowResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface MemoryEntry {
  count: number;
  resetAt: number;
}

const memory = new Map<string, MemoryEntry>();

function memoryCheck(key: string, max: number, windowMs: number): WindowResult {
  const now = Date.now();
  let entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    memory.set(key, entry);
  }
  entry.count += 1;
  if (memory.size > 10_000) {
    for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
  }
  return { allowed: entry.count <= max, remaining: Math.max(0, max - entry.count), resetAt: entry.resetAt };
}

/** One fixed window: PG first (shared across instances), in-memory fallback when the DB is down. */
async function windowCheck(key: string, max: number, windowMs: number): Promise<WindowResult> {
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  try {
    return await checkPgRateLimit(key, max, windowSec);
  } catch {
    return memoryCheck(key, max, windowMs);
  }
}

/**
 * Count one request against BOTH windows and decide. The minute window is checked first: a
 * burst refusal does not burn the daily budget (a throttled client should not lose its day).
 */
export async function checkAgentRateLimit(
  key: string,
  options: { perMinute?: number; windowMs?: number } = {},
): Promise<AgentRateLimitDecision> {
  const perMinute = options.perMinute ?? AGENT_RATE_LIMIT_MAX;
  const windowMs = options.windowMs ?? AGENT_RATE_LIMIT_WINDOW_MS;

  const minute = await windowCheck(key, perMinute, windowMs);
  if (!minute.allowed) {
    return {
      allowed: false,
      scope: 'minute',
      retryAfterSeconds: Math.max(1, Math.ceil((minute.resetAt - Date.now()) / 1000)),
      limit: perMinute,
      remaining: 0,
      resetAt: minute.resetAt,
    };
  }

  const day = await windowCheck(`${key}:day`, AGENT_RATE_LIMIT_DAILY_MAX, AGENT_RATE_LIMIT_DAY_MS);
  if (!day.allowed) {
    return {
      allowed: false,
      scope: 'daily',
      retryAfterSeconds: Math.max(1, Math.ceil((day.resetAt - Date.now()) / 1000)),
      limit: perMinute,
      remaining: minute.remaining,
      resetAt: minute.resetAt,
    };
  }

  return { allowed: true, limit: perMinute, remaining: minute.remaining, resetAt: minute.resetAt };
}

/** Derive the rate-limit key without ever persisting the raw token. */
export function agentRateLimitKey(c: Context): string {
  const bearer = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer && bearer.startsWith('tmt_')) {
    return `rl:agent:tok:${hashAgentToken(bearer)}`;
  }
  return `rl:agent:sess:${getClientIp(c)}`;
}

export function agentRateLimit(max = AGENT_RATE_LIMIT_MAX, windowMs = AGENT_RATE_LIMIT_WINDOW_MS) {
  return async (c: Context, next: Next) => {
    const decision = await checkAgentRateLimit(agentRateLimitKey(c), { perMinute: max, windowMs });

    c.header('X-RateLimit-Limit', String(decision.limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, decision.remaining)));
    c.header('X-RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));
    if (!decision.allowed) {
      const daily = decision.scope === 'daily';
      const retryAfter = decision.retryAfterSeconds ?? 1;
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          success: false,
          error: daily ? 'rate_limited_daily' : 'rate_limited_minute',
          message: daily
            ? `已达到该令牌的每日请求上限（${AGENT_RATE_LIMIT_DAILY_MAX} 次），请明天再试`
            : `请求过于频繁：该令牌每分钟最多 ${max} 次请求，请稍后再试`,
          scope: decision.scope,
          retryAfterSeconds: retryAfter,
        },
        429,
      );
    }
    await next();
  };
}

/** Test-only: clear the in-memory fallback between cases. */
export function resetAgentRateLimitMemory(): void {
  memory.clear();
}
