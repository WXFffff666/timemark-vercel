import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 74 - the per-day aggregation must reuse the same window/timezone
 * semantics as `getAdherence` and stay user/profile-scoped. Pending doses are
 * excluded in SQL, so they can never inflate a doctor-facing number.
 */

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));

import { getAdherenceDaily } from '../services/medication.service.js';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function calls(): QueryCall[] {
  const rawCalls = dbQuery.mock.calls as unknown as Array<[string, unknown[]?]>;
  return rawCalls.map(([sql, params]) => ({ sql, params: params ?? [] }));
}

beforeEach(() => {
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM user_configs')) {
      return { rows: [{ timezone: 'Asia/Shanghai' }], rowCount: 1 };
    }
    return {
      rows: [
        { dose_date: '2026-09-01', taken: '2', skipped: '0', missed: '1' },
        { dose_date: '2026-09-02', taken: '1', skipped: '1', missed: '0' },
      ],
      rowCount: 2,
    };
  });
});

describe('getAdherenceDaily (checkbox 74)', () => {
  it('maps per-day counts and scopes the window to user + local timezone', async () => {
    const daily = await getAdherenceDaily(7, '2026-09-01', '2026-09-03');
    expect(daily).toEqual([
      { date: '2026-09-01', taken: 2, skipped: 0, missed: 1 },
      { date: '2026-09-02', taken: 1, skipped: 1, missed: 0 },
    ]);

    const doseCall = calls().find((entry) => entry.sql.includes('medication_doses d'));
    expect(doseCall).toBeDefined();
    expect(doseCall?.params.slice(0, 4)).toEqual([7, 'Asia/Shanghai', '2026-09-01', '2026-09-03']);
    expect(doseCall?.sql).toContain("d.status IN ('taken', 'skipped', 'missed')");
    expect(doseCall?.sql).not.toContain('m.profile_id');
  });

  it('appends the profile predicate only when a profile is requested', async () => {
    await getAdherenceDaily(7, '2026-09-01', '2026-09-03', { profileId: 11 });
    const doseCall = calls().find((entry) => entry.sql.includes('medication_doses d'));
    expect(doseCall?.params).toEqual([7, 'Asia/Shanghai', '2026-09-01', '2026-09-03', 11]);
    expect(doseCall?.sql).toContain('m.profile_id = $5');
  });

  it('returns an empty array for an empty period', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM user_configs')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    expect(await getAdherenceDaily(7, '2026-09-01', '2026-09-03')).toEqual([]);
  });
});
