import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * v2.30 收件箱升级：来源标签页（all/inbound/broadcast）与批量操作。
 * 此前 listInboxMessages 硬编码 source='inbound'，广播类消息（cron 告警、
 * 摘要归档）在 UI 里是死信；批量操作走 ANY($2::int[]) 数组参数。
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: mockQuery }));

import {
  listInboxMessages,
  batchMarkInboxRead,
  batchDeleteInboxMessages,
} from '../services/inbox.service.js';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
    if (sql.includes('COUNT(*)::int AS unread')) return { rows: [{ unread: 0 }] };
    return { rows: [] };
  });
});

describe('listInboxMessages source filter', () => {
  it('default all: passes NULL source so no source filter applies', async () => {
    await listInboxMessages(1, {});
    const listSql = mockQuery.mock.calls[0][0] as string;
    expect(listSql).toContain('$2::text IS NULL OR source = $2::text');
    expect(mockQuery.mock.calls[0][1][1]).toBeNull();
  });

  it('inbound tab: binds the source param', async () => {
    await listInboxMessages(1, { source: 'inbound' });
    expect(mockQuery.mock.calls[0][1][1]).toBe('inbound');
  });

  it('broadcast tab: binds broadcast', async () => {
    await listInboxMessages(1, { source: 'broadcast' });
    expect(mockQuery.mock.calls[0][1][1]).toBe('broadcast');
  });

  it('unread count spans all sources (badge semantics)', async () => {
    await listInboxMessages(1, { source: 'inbound' });
    const unreadCall = mockQuery.mock.calls.find((c) => (c[0] as string).includes('AS unread'));
    expect(unreadCall?.[0]).not.toContain("source = 'inbound'");
    expect(unreadCall?.[0]).not.toContain('source = $2');
  });

  it('no dynamic SQL string assembly in list query (static placeholders only)', async () => {
    await listInboxMessages(1, { q: "x'; DROP TABLE users; --" });
    const listSql = mockQuery.mock.calls[0][0] as string;
    expect(listSql).not.toContain('${');
    expect(listSql).not.toContain("DROP TABLE");
    // 搜索词只作为参数出现
    expect(mockQuery.mock.calls[0][1]).toContain("%x'; DROP TABLE users; --%");
  });
});

describe('batch inbox ops', () => {
  it('batch read uses ANY array param, no string interpolation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
    const affected = await batchMarkInboxRead(1, [1, 2, 3]);
    expect(affected).toBe(2);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('= ANY($2::int[])');
    expect(sql).not.toContain('${');
    expect(params).toEqual([1, [1, 2, 3]]);
  });

  it('batch delete uses ANY array param and scopes by user_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 9 }] });
    const affected = await batchDeleteInboxMessages(7, [9]);
    expect(affected).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('user_id = $1');
    expect(sql).toContain('= ANY($2::int[])');
    expect(params).toEqual([7, [9]]);
  });

  it('empty ids short-circuits without touching db', async () => {
    expect(await batchMarkInboxRead(1, [])).toBe(0);
    expect(await batchDeleteInboxMessages(1, [])).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
