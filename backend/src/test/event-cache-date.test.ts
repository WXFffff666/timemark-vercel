import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 12 lane B / D-4 regression.
 *
 * `pg` returns a DATE column as a JS `Date` at LOCAL midnight. Persisting the raw
 * row with `JSON.stringify` coerces that to a UTC ISO instant, so the cached
 * calendar day shifts on read-back under a positive UTC offset (a today event
 * never fires while the cache is warm). These tests pin the write-side fix:
 * DATE columns are stored as plain `YYYY-MM-DD`, timezone-independently.
 */

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

import { refreshUserEventCache } from '../services/event-cache.service.js';
import { toYmdString } from '@timemark/shared/event-schedule';

const DATE_COLUMNS = ['date', 'birth_date', 'next_occurrence'] as const;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

let insertParams: unknown[] | null;

function installDb(rows: Record<string, unknown>[]): void {
  insertParams = null;
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM events')) return { rows, rowCount: rows.length };
    if (s.startsWith('INSERT INTO event_reminder_cache')) {
      insertParams = params;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('refreshUserEventCache — events DATE columns survive the JSON round-trip', () => {
  beforeEach(() => installDb([]));

  it('persists DATE columns as plain YYYY-MM-DD, not a JSON Date instant', async () => {
    // `new Date(2026, 8, 29)` is the exact shape pg builds for DATE 2026-09-29;
    // under TZ=Asia/Shanghai JSON.stringify would emit 2026-09-28T16:00:00.000Z.
    installDb([
      {
        id: 1,
        user_id: 1,
        name: 'CacheProbe',
        date: new Date(2026, 8, 29),
        birth_date: new Date(1990, 0, 15),
        next_occurrence: new Date(2026, 8, 29),
        reminder_config: null,
        notification_channels: '[]',
      },
    ]);

    await refreshUserEventCache(1);

    expect(insertParams).not.toBeNull();
    const payload = JSON.parse(String(insertParams![1])) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    for (const col of DATE_COLUMNS) {
      expect(payload[0][col]).toBeTypeOf('string');
      expect(payload[0][col]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(payload[0][col]).not.toMatch(ISO_INSTANT);
    }
    expect(payload[0].date).toBe('2026-09-29');
    expect(payload[0].birth_date).toBe('1990-01-15');
    expect(payload[0].next_occurrence).toBe('2026-09-29');
  });

  it('reads back to the same calendar day via toYmdString (warm-cache round-trip)', async () => {
    installDb([
      { id: 1, user_id: 1, name: 'x', date: new Date(2026, 8, 29), birth_date: null, next_occurrence: null },
    ]);

    await refreshUserEventCache(1);
    const payload = JSON.parse(String(insertParams![1])) as Array<Record<string, unknown>>;

    // TZ-independent: with the old write path this would be
    // "2026-09-28T16:00:00.000Z" under +08 and shift to 2026-09-28.
    expect(payload[0].date).toBe('2026-09-29');
    expect(toYmdString(payload[0].date)).toBe('2026-09-29');
  });

  it('leaves nullable DATE columns as null', async () => {
    installDb([
      { id: 1, user_id: 1, name: 'x', date: new Date(2026, 8, 29), birth_date: null, next_occurrence: null },
    ]);

    await refreshUserEventCache(1);
    const payload = JSON.parse(String(insertParams![1])) as Array<Record<string, unknown>>;
    expect(payload[0].birth_date).toBeNull();
    expect(payload[0].next_occurrence).toBeNull();
  });
});
