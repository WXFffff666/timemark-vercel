import { describe, expect, it } from 'vitest';
import { checkPgRateLimit } from '../services/pg-rate-limit.js';

/**
 * 真库集成测试（无 DATABASE_URL 时跳过）。
 *
 * 回归背景：旧 SQL 传了 3 个参数但只引用 $1/$3，Postgres 抛 42P18
 * "could not determine data type of parameter $2"——单测全 mock 了 db 层抓不到，
 * 只有真库跑一次才会炸。这正是 v2.30 全链路真连测试抓到的第一个生产 bug
 * （限流每次调用都失败，中间件静默降级成单实例内存限流）。
 */
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)('checkPgRateLimit (real postgres)', () => {
  it('counts within window, allows under limit, and reports resetAt', async () => {
    const key = `test:rl:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try {
      const first = await checkPgRateLimit(key, 3, 60);
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(2);
      expect(first.resetAt).toBeGreaterThan(Date.now());

      const second = await checkPgRateLimit(key, 3, 60);
      expect(second.allowed).toBe(true);
      expect(second.remaining).toBe(1);

      const third = await checkPgRateLimit(key, 3, 60);
      expect(third.allowed).toBe(true);
      expect(third.remaining).toBe(0);

      const fourth = await checkPgRateLimit(key, 3, 60);
      expect(fourth.allowed).toBe(false);
    } finally {
      const { query } = await import('../db/index.js');
      await query('DELETE FROM rate_limits WHERE key = $1', [key]).catch(() => {});
    }
  });
});
