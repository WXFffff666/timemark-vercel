import type { Context, Next } from 'hono';
import { checkPgRateLimit } from '../services/pg-rate-limit.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup expired entries every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) {
      store.delete(key);
    }
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

function getClientIP(c: Context): string {
  const cfIp = c.req.header('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp.startsWith('::ffff:') ? cfIp.slice(7) : cfIp;

  return (
    c.req.header('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    '127.0.0.1'
  );
}

function memoryRateLimit(maxRequests: number, windowMs: number) {
  return async (c: Context, next: Next) => {
    const ip = getClientIP(c);
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }
    entry.count++;

    if (store.size > 10000) {
      const now2 = Date.now();
      for (const [k, v] of store) {
        if (v.resetAt <= now2) store.delete(k);
      }
    }

    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ success: false, error: '请求过于频繁，请稍后再试' }, 429);
    }
    await next();
  };
}

/**
 * Rate limiter: PostgreSQL when DATABASE_URL set, else in-memory fallback.
 */
export function rateLimit(maxRequests: number, windowMs: number) {
  const windowSec = Math.ceil(windowMs / 1000);
  return async (c: Context, next: Next) => {
    if (!process.env.DATABASE_URL) {
      return memoryRateLimit(maxRequests, windowMs)(c, next);
    }

    const ip = getClientIP(c);
    const key = `rl:${ip}:${c.req.path}`;
    try {
      const result = await checkPgRateLimit(key, maxRequests, windowSec);
      c.header('X-RateLimit-Limit', String(maxRequests));
      c.header('X-RateLimit-Remaining', String(result.remaining));
      c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
      if (!result.allowed) {
        const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
        c.header('Retry-After', String(retryAfter));
        return c.json({ success: false, error: '请求过于频繁，请稍后再试' }, 429);
      }
      await next();
    } catch {
      return memoryRateLimit(maxRequests, windowMs)(c, next);
    }
  };
}

/**
 * Login POST only: 20 attempts per 15 minutes per IP.
 * Session/refresh/turnstile-config are not counted — avoids locking users out while loading the page.
 */
export const loginRateLimit = rateLimit(20, 15 * 60 * 1000);

/**
 * Auth mutation endpoints (password change, etc.): 30 requests per 15 minutes per IP.
 */
export const authMutationRateLimit = rateLimit(30, 15 * 60 * 1000);

/**
 * General API rate limiter (100 requests per minute)
 */
export const apiRateLimit = rateLimit(100, 60 * 1000);
