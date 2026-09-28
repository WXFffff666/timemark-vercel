import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dateStringInTimeZone } from '@timemark/shared/habit-schedule';

/**
 * Checkbox: trigger_date TEXT reader sweep (migration 51).
 *
 * Invariant: `event_trigger_logs.trigger_date` is TEXT. A row's first 10 characters are a
 * calendar day `YYYY-MM-DD` ONLY for legacy rows (exactly 10 chars) and for normal dedup
 * tokens `YYYY-MM-DD#d<n>#tHH:mm`. Namespaced keys such as `snooze:event#<id>#<ISO>`
 * (`buildSnoozeSendKey` -> `recordEventTrigger`) carry NO leading date - `LEFT(..., 10)` is
 * `snooze:eve` - so every reader must EXCLUDE them with a guard, never truncate them. A DATE
 * comparison raises `text = date` (42883) and a `::date` cast raises 22007 on any token row.
 *
 * Engine-level proof (a mock cannot produce 42883/22007) lives in the PGlite harness
 * `%TEMP%/opencode/wave12-97r2-laneA/pglite-probe.mts`; this file pins the SQL the services
 * generate and the date-diff math on legacy, token and namespaced rows.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { aggregateDailyStats } from '../services/stats-daily.service.js';
import { updateEvent } from '../services/event.service.js';
import { getRecommendedDaysFromHistory } from '../services/recommendations.js';

const SERVICES_SOURCE = readFileSync(new URL('../services/stats-daily.service.ts', import.meta.url), 'utf8');
const EVENT_SERVICE_SOURCE = readFileSync(new URL('../services/event.service.ts', import.meta.url), 'utf8');
const RECOMMENDATIONS_SOURCE = readFileSync(new URL('../services/recommendations.ts', import.meta.url), 'utf8');
const EVENTS_ROUTE_SOURCE = readFileSync(new URL('../routes/events.ts', import.meta.url), 'utf8');
const TRIGGER_LOGS_ROUTE_SOURCE = readFileSync(new URL('../routes/trigger-logs.ts', import.meta.url), 'utf8');
const TRIGGER_LOGS_PAGE_SOURCE = readFileSync(
  new URL('../../../frontend/src/pages/TriggerLogs.tsx', import.meta.url),
  'utf8',
);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('D-1 aggregateDailyStats computes the day in SQL so host and DB clocks cannot diverge', () => {
  it('uses one DB-local day for the INSERT target and the trigger_date prefix comparison', async () => {
    const inserted = await aggregateDailyStats();
    expect(inserted).toBe(1);

    const [sql, params] = mockQuery.mock.calls[0];
    // Both the stat_date target and the comparison are DB-local: (CURRENT_DATE - 1 day).
    expect(sql).toContain('(CURRENT_DATE - INTERVAL \'1 day\')::date');
    expect(sql).toContain('LEFT(trigger_date, 10) = (CURRENT_DATE - INTERVAL \'1 day\')::date::text');
    // No host-computed ymd may be passed in (that was the host/DB divergence defect).
    expect(params ?? []).toEqual([]);
    expect(sql).not.toContain('$1');
    expect(SERVICES_SOURCE).not.toMatch(/function\s+yesterdayYmd/);
    // The old shapes must not come back: text = date (42883) and ::date (22007 on tokens).
    expect(sql).not.toMatch(/trigger_date\s*=\s*\(CURRENT_DATE(?!\s*-)/);
    expect(sql).not.toMatch(/LEFT\(trigger_date, 10\)\s*::\s*date/);
    expect(sql).not.toMatch(/trigger_date\s*::\s*date(?!\s*::)/);
    // LEFT(trigger_date, 10) stays the documented 10-char-prefix rule for real ymd rows.
    expect(SERVICES_SOURCE).toContain('LEFT(trigger_date, 10)');
  });

  it('matches legacy rows and token rows alike and can never match a namespaced key', async () => {
    await aggregateDailyStats();

    const [sql] = mockQuery.mock.calls[0];
    // Prefix equality covers a legacy '2026-09-27' and '2026-09-27#d0#t09:00' in one predicate.
    expect(sql).toContain('LEFT(trigger_date, 10) = (CURRENT_DATE - INTERVAL \'1 day\')::date::text');
    expect(sql).not.toContain("LIKE '");
    // A namespaced key can never satisfy the predicate: its prefix is 'snooze:eve', not a ymd.
    expect('snooze:event#1#2026-09-28T09:30:00.000Z'.slice(0, 10)).toBe('snooze:eve');
    expect(/^\d{4}-\d{2}-\d{2}$/.test('snooze:eve')).toBe(false);
  });
});

describe('D-2 updateEvent clears the USER-local today using CURRENT_DATE-independent ymd', () => {
  it('deletes today legacy + token rows with the 10-char prefix of the event-timezone day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 2026-09-28T20:00Z = 2026-09-29 04:00 in Asia/Shanghai (user) but still 2026-09-28 in UTC (DB).
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 28, 20, 0, 0)));
    mockQuery.mockImplementation((sql: string) =>
      sql.includes('COALESCE(NULLIF(p.timezone')
        ? Promise.resolve({ rows: [{ timezone: 'Asia/Shanghai' }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 1 }),
    );

    const updated = await updateEvent('7', '1', {
      reminderConfig: { enabled: true, daysBeforeList: [1], emailRecipients: [] },
    });
    expect(updated).toBe(true);

    const tzCall = mockQuery.mock.calls.find(([sql]) => /COALESCE\(NULLIF\(p\.timezone/.test(sql));
    expect(tzCall).toBeDefined();
    expect(tzCall![1]).toEqual(['7', 1]);

    const call = mockQuery.mock.calls.find(([sql]) => /DELETE FROM event_trigger_logs/.test(sql));
    expect(call).toBeDefined();
    const [sql, params] = call!;
    // User-local today (04:00 +08 on 09-29), NOT the DB-local UTC day (09-28).
    expect(params).toEqual(['7', '2026-09-29']);
    expect(dateStringInTimeZone(new Date(), 'UTC')).toBe('2026-09-28');
    // The prefix equality excludes namespaced keys (LEFT -> 'snooze:eve') and needs no cast.
    expect(sql).toContain('LEFT(trigger_date, 10) = $2');
    expect(sql).not.toMatch(/CURRENT_DATE/);
    expect(sql).not.toMatch(/trigger_date\s*::\s*date(?!\s*::)/);
    expect(EVENT_SERVICE_SOURCE).toContain('LEFT(trigger_date, 10) = $2');
    expect(EVENT_SERVICE_SOURCE).toContain('dateStringInTimeZone(new Date(), timeZone)');
  });

  it('falls back to Asia/Shanghai when the event has no profile/user timezone row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 28, 20, 0, 0)));

    await updateEvent('7', '1', {
      reminderConfig: { enabled: true, daysBeforeList: [1], emailRecipients: [] },
    });

    const call = mockQuery.mock.calls.find(([sql]) => /DELETE FROM event_trigger_logs/.test(sql));
    expect(call![1]).toEqual(['7', '2026-09-29']);
  });
});

describe('D-3 getRecommendedDaysFromHistory derives day diffs from trigger history', () => {
  it('produces a non-config-only day from a token-only history', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          reminder_config: JSON.stringify({ enabled: true, daysBeforeList: [0, 1, 3, 7], emailRecipients: [] }),
          date: '2026-06-10',
          trigger_date: '2026-06-05#d5#t09:00',
          status: 'success',
        },
      ],
      rowCount: 1,
    });

    const days = await getRecommendedDaysFromHistory(1, 'birthday');
    // 5 is NOT in daysBeforeList: it can only come from the token row's day diff.
    expect(days).toContain(5);
    expect(days).not.toEqual([7, 3, 1, 0]);
  });

  it('normalises a pg DATE Date instance with LOCAL getters (local midnight)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          reminder_config: JSON.stringify({ enabled: true, daysBeforeList: [0], emailReceivers: [] }),
          date: new Date(2026, 5, 10), // pg DATE -> local midnight
          trigger_date: '2026-06-08#d2#t09:00',
          status: 'success',
        },
      ],
      rowCount: 1,
    });

    const days = await getRecommendedDaysFromHistory(1, 'birthday');
    // UTC getters would read '2026-06-09' in +08 and yield 1 instead of 2.
    expect(days).toContain(2);
  });

  it('still counts a legacy 10-char trigger_date row', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          reminder_config: JSON.stringify({ enabled: true, daysBeforeList: [0], emailReceivers: [] }),
          date: '2026-06-10',
          trigger_date: '2026-06-06',
          status: 'success',
        },
      ],
      rowCount: 1,
    });

    const days = await getRecommendedDaysFromHistory(1, 'birthday');
    expect(days).toContain(4);
    expect(RECOMMENDATIONS_SOURCE).not.toMatch(/new Date\(row\.trigger_date\)/);
  });
});

describe('AUDIT: display endpoints never hand a token to a date parser', () => {
  it('/events/reminder-logs exposes the 10-char ymd prefix only behind the CASE guard', () => {
    expect(EVENTS_ROUTE_SOURCE).toContain(
      "CASE WHEN tl.trigger_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN LEFT(tl.trigger_date, 10) ELSE tl.trigger_date END AS trigger_date",
    );
    expect(EVENTS_ROUTE_SOURCE).not.toContain('LEFT(tl.trigger_date, 10) AS trigger_date');
  });

  it('the TriggerLogs page treats trigger_date as an opaque label (no new Date parse)', () => {
    expect(TRIGGER_LOGS_PAGE_SOURCE).not.toMatch(/new Date\((?:log\.)?trigger_date/);
  });

  it('the raw CSV export keeps the original trigger_date value (harmless raw text)', () => {
    expect(TRIGGER_LOGS_ROUTE_SOURCE).toContain('tl.trigger_date,');
  });
});
