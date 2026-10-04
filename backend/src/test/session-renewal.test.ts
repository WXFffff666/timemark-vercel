import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({ query: dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));

import { renewRememberedSession } from '../services/session.service.js';

/**
 * 滑动续期（保持登录修复）：/auth/refresh 在 rememberMe 时把 remembered 会话的
 * 绝对截止顺延到 now+30d，活跃用户不再在第 30 天被硬踢下线。
 */
describe('renewRememberedSession', () => {
  beforeEach(() => {
    dbQuery.mockReset();
  });

  it('extends expires_at to now+30d and returns the new deadline', async () => {
    dbQuery.mockResolvedValue({
      rows: [{ expires_at: new Date(Date.now() + 30 * 86400_000).toISOString() }],
      rowCount: 1,
    });

    const renewed = await renewRememberedSession('tok-1');
    expect(renewed).toBeInstanceOf(Date);
    expect(renewed!.getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);

    const [params] = dbQuery.mock.calls[0][1] as unknown[];
    expect(new Date(String(params)).getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
  });

  it('returns null when the session row is gone (expired / revoked)', async () => {
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(renewRememberedSession('tok-dead')).resolves.toBeNull();
  });
});
