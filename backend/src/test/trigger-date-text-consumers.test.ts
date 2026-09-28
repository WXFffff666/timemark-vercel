import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox: trigger_date TEXT reader sweep (migration 51).
 *
 * Invariant: `event_trigger_logs.trigger_date` is TEXT; its first 10 characters are ALWAYS
 * the calendar day `YYYY-MM-DD` - legacy rows are exactly 10 chars, new dedup tokens append
 * `#d<n>#tHH:mm`. A DATE comparison raises `text = date` (42883) and a `::date` cast raises
 * 22007 on any token row, so every reader must use the 10-char prefix.
 *
 * Engine-level proof (a mock cannot produce 42883/22007) lives in the PGlite harness
 * `%TEMP%/opencode/wave12-triggerdate-laneA/laneA-probe2.mts`; this file pins the SQL the
 * services generate and the date-diff math on both legacy and token rows.
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

describe('D-1 aggregateDailyStats compares the 10-char prefix of trigger_date', () => {
  it('uses LEFT(trigger_date, 10) = $1::text against yesterday, never text = date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0)); // local noon -> yesterday is 2026-06-14 in any TZ

    const inserted = await aggregateDailyStats();
    expect(inserted).toBe(1);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('LEFT(trigger_date, 10) = $1::text');
    expect(params).toEqual(['2026-06-14']);
    // The old shape is a type error on TEXT columns; the cast is a 22007 trap.
    expect(sql).not.toMatch(/trigger_date\s*=\s*\(CURRENT_DATE/);
    expect(sql).not.toMatch(/trigger_date\s*::\s*date/);
    // stat_date remains a DATE INSERT target (only its value source changed).
    expect(sql).toContain('$1::date');
    expect(SERVICES_SOURCE).toContain('LEFT(trigger_date, 10)');
  });

  it('matches legacy rows and token rows alike - one prefix equality covers both', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));

    await aggregateDailyStats();

    const [sql, params] = mockQuery.mock.calls[0];
    // A 10-char prefix equals '2026-06-14' for a legacy '2026-06-14' and for
    // '2026-06-14#d0#t09:00', so both kinds are counted by the same predicate.
    expect(sql).toContain('LEFT(trigger_date, 10) = $1::text');
    expect(params).toEqual(['2026-06-14']);
    expect(sql).not.toContain("LIKE '");
  });
});

describe('D-2 updateEvent clears today using CURRENT_DATE ymd, not ::date', () => {
  it('deletes today legacy + token rows with the 10-char prefix', async () => {
    const updated = await updateEvent('7', '1', {
      reminderConfig: { enabled: true, daysBeforeList: [1], emailRecipients: [] },
    });
    expect(updated).toBe(true);

    const call = mockQuery.mock.calls.find(([sql]) => /DELETE FROM event_trigger_logs/.test(sql));
    expect(call).toBeDefined();
    const [sql, params] = call!;
    expect(sql).toContain('LEFT(trigger_date, 10) = CURRENT_DATE::text');
    expect(sql).not.toMatch(/trigger_date\s*::\s*date/);
    expect(params).toEqual(['7']);
    expect(EVENT_SERVICE_SOURCE).toContain('LEFT(trigger_date, 10) = CURRENT_DATE::text');
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
  it('/events/reminder-logs exposes the 10-char ymd prefix', () => {
    expect(EVENTS_ROUTE_SOURCE).toContain('LEFT(tl.trigger_date, 10) AS trigger_date');
  });

  it('the TriggerLogs page treats trigger_date as an opaque label (no new Date parse)', () => {
    expect(TRIGGER_LOGS_PAGE_SOURCE).not.toMatch(/new Date\((?:log\.)?trigger_date/);
  });

  it('the raw CSV export keeps the original trigger_date value (harmless raw text)', () => {
    expect(TRIGGER_LOGS_ROUTE_SOURCE).toContain('tl.trigger_date,');
  });
});
