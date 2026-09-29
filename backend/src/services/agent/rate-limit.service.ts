import type { Context, Next } from 'hono';
import { checkPgRateLimit } from '../pg-rate-limit.js';
import { hashAgentToken } from '../agent-tokens.service.js';
import { getClientIp } from '../../utils/client-ip.js';

/**
 * Checkbox 102: a per-credential rate limit for the agent action API.
 *
 * The repo's generic `rateLimit` keys on IP + path only, which would let one token starve
 * every other caller behind the same NAT and would not bound a single runaway token. Here the
 * key is derived from the credential itself:
 *   - Bearer `tmt_` token -> sha256(token)  (per token, raw value never stored)
 *   - session / anything else -> client IP  (the session path still needs its own limit)
 *
 * PostgreSQL-backed fixed-window (serverless-safe, shared across invocations) with an
 * in-memory fallback when the DB is unreachable, mirroring `middleware/rate-limit.ts`.
 */

export const AGENT_RATE_LIMIT_MAX = 60;
export const AGENT_RATE_LIMIT_WINDOW_MS = 60_000;

interface MemoryEntry {
  count: number;
  resetAt: number;
}

const memory = new Map<string, MemoryEntry>();

function memoryCheck(key: string, max: number, windowMs: number): { allowed: boolean; remaining: number; resetAt: number } {
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

/** Derive the rate-limit key without ever persisting the raw token. */
export function agentRateLimitKey(c: Context): string {
  const bearer = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer && bearer.startsWith('tmt_')) {
    return `rl:agent:tok:${hashAgentToken(bearer)}`;
  }
  return `rl:agent:sess:${getClientIp(c)}`;
}

export function agentRateLimit(max = AGENT_RATE_LIMIT_MAX, windowMs = AGENT_RATE_LIMIT_WINDOW_MS) {
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  return async (c: Context, next: Next) => {
    const key = agentRateLimitKey(c);
    let allowed: boolean;
    let remaining: number;
    let resetAt: number;
    try {
      const result = await checkPgRateLimit(key, max, windowSec);
      allowed = result.allowed;
      remaining = result.remaining;
      resetAt = result.resetAt;
    } catch {
      const result = memoryCheck(key, max, windowMs);
      allowed = result.allowed;
      remaining = result.remaining;
      resetAt = result.resetAt;
    }

    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(Math.max(0, remaining)));
    c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    if (!allowed) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json({ success: false, error: '请求过于频繁，请稍后再试' }, 429);
    }
    await next();
  };
}

/** Test-only: clear the in-memory fallback between cases. */
export function resetAgentRateLimitMemory(): void {
  memory.clear();
}
