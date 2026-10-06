import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * v2.30 全链路实测发现的 bug：inbox_receive_token 只在 v23 迁移时一次性回填，
 * 之后创建的用户（全新安装的 admin）永远没有收件地址。现在 getInboxReceiveTokens
 * 必须按需生成并落库。
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { getInboxReceiveTokens } from '../services/inbox.service.js';

beforeEach(() => {
  mockQuery.mockReset();
});

describe('getInboxReceiveTokens', () => {
  it('returns existing token without writing', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ inbox_receive_token: 'tok', inbox_receive_secret: 'sec' }],
    });
    const result = await getInboxReceiveTokens(1);
    expect(result).toEqual({ inboxReceiveToken: 'tok', inboxReceiveSecret: 'sec' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('generates and persists a token when the row has none (fresh install)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ inbox_receive_token: null, inbox_receive_secret: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const result = await getInboxReceiveTokens(7);
    expect(result.inboxReceiveToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result.inboxReceiveSecret).toMatch(/^[0-9a-f]{64}$/);
    const updateSql = mockQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain('COALESCE(inbox_receive_token');
    expect(updateSql).toContain('COALESCE(inbox_receive_secret');
  });

  it('still returns a usable token when the user has no configs row (ephemeral until row exists)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 0 });
    const result = await getInboxReceiveTokens(99);
    expect(result.inboxReceiveToken).toMatch(/^[0-9a-f]{48}$/);
  });
});
