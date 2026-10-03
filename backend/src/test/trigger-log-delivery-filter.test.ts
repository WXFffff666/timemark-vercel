import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * fetchLogsByOutcome —— 提醒日志按「真实投递结果」筛选。
 *
 * 「部分失败」落库时 status='success'，按裸 status 筛不出来。这里钉住推导语义与
 * shared 的 readDelivery 一致，且分页 total 是过滤后的数量。
 */

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({ query: dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));

import { fetchLogsByOutcome } from '../services/trigger-log-delivery-filter.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: 'success',
    channel_results: { email: { success: true }, fcm: { success: false, error: 'HTTP 500' } },
    error_message: null,
    created_at: '2026-10-01',
    ...overrides,
  };
}

beforeEach(() => {
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('fetchLogsByOutcome', () => {
  it('partial 命中「部分失败」的行（status=success 但有真实渠道失败）', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('ANY($2::int[])')) return { rows: [{ id: 1, status: 'success' }], rowCount: 1 };
      return {
        rows: [
          row({ id: 1 }),
          row({ id: 2, channel_results: { email: { success: true } } }),
          row({ id: 3, status: 'failed', channel_results: { fcm: { success: false, error: 'x' } } }),
        ],
        rowCount: 3,
      };
    });

    const { rows, total } = await fetchLogsByOutcome(7, 'partial', 50, 0);
    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('delivered 只收真正全成功的行，不混入部分失败', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('ANY($2::int[])')) return { rows: [{ id: 2 }], rowCount: 1 };
      return {
        rows: [row({ id: 1 }), row({ id: 2, channel_results: { email: { success: true } } })],
        rowCount: 2,
      };
    });

    const { rows, total } = await fetchLogsByOutcome(7, 'delivered', 50, 0);
    expect(total).toBe(1);
    expect(rows[0].id).toBe(2);
  });

  it('failed 收 status=failed 的行，即使没有 channel_results（历史异常行）', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('ANY($2::int[])')) return { rows: [{ id: 5 }], rowCount: 1 };
      return { rows: [row({ id: 5, status: 'failed', channel_results: null, error_message: 'boom' })], rowCount: 1 };
    });

    const { total } = await fetchLogsByOutcome(7, 'failed', 50, 0);
    expect(total).toBe(1);
  });

  it('skipped 收 status=skipped 与只有内部标记键的行', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('ANY($2::int[])')) return { rows: [{ id: 6 }, { id: 7 }], rowCount: 2 };
      return {
        rows: [
          row({ id: 6, status: 'skipped', channel_results: null }),
          row({ id: 7, channel_results: { _quiet_hours: { success: false, error: 'quiet_hours' } } }),
        ],
        rowCount: 2,
      };
    });

    const { total } = await fetchLogsByOutcome(7, 'skipped', 50, 0);
    expect(total).toBe(2);
  });

  it('分页：offset/limit 作用于过滤后的结果，total 是过滤后的总数', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('ANY($2::int[])')) return { rows: [{ id: 3 }], rowCount: 1 };
      return {
        rows: [
          row({ id: 1 }),
          row({ id: 2 }),
          row({ id: 3 }),
        ],
        rowCount: 3,
      };
    });

    const { rows, total } = await fetchLogsByOutcome(7, 'partial', 1, 2);
    expect(total).toBe(3);
    expect((rows[0] as { id: number }).id).toBe(3);
  });
});
