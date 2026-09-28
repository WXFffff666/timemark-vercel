import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Namespaced `trigger_date` keys vs the 10-char-prefix rule (migration 51).
 *
 * `event_trigger_logs.trigger_date` is TEXT and carries three shapes today:
 *   - legacy plain `YYYY-MM-DD` (exactly 10 chars),
 *   - normal dedup tokens `YYYY-MM-DD#d<n>#tHH:mm` (`buildReminderSendKey`),
 *   - namespaced snooze keys `snooze:event#<id>#<ISO>` (`buildSnoozeSendKey` -> `recordEventTrigger`
 *     at `backend/src/jobs/tasks.ts` L1709/L1716).
 * Only the first two have a leading calendar day. `LEFT('snooze:event#...', 10)` is
 * `snooze:eve`, so:
 *   - `/events/reminder-logs` must return the RAW key for namespaced rows (CASE guard), and
 *   - every day-based predicate must be an equality against a real ymd, which namespaced rows
 *     can never satisfy.
 * Engine-level proof of both lives in the PGlite harness
 * `%TEMP%/opencode/wave12-97r2-laneA/pglite-probe.mts`.
 */
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { getRecommendedDaysFromHistory } from '../services/recommendations.js';

const SNOOZE_KEY = 'snooze:event#1#2026-09-28T09:30:00.000Z';
const TOKEN_KEY = '2026-09-28#d1#t09:00';
const LEGACY_KEY = '2026-09-28';

const EVENTS_ROUTE_SOURCE = readFileSync(new URL('../routes/events.ts', import.meta.url), 'utf8');
const STATS_SOURCE = readFileSync(new URL('../services/stats-daily.service.ts', import.meta.url), 'utf8');
const RECOMMENDATIONS_SOURCE = readFileSync(new URL('../services/recommendations.ts', import.meta.url), 'utf8');
const FEATURES_ROUTE_SOURCE = readFileSync(new URL('../routes/features.ts', import.meta.url), 'utf8');
const TASKS_SOURCE = readFileSync(new URL('../jobs/tasks.ts', import.meta.url), 'utf8');
const TRIGGER_LOG_SERVICE_SOURCE = readFileSync(new URL('../services/trigger-log.service.ts', import.meta.url), 'utf8');

/**
 * Mirror of the SQL guard in `/events/reminder-logs`:
 * `CASE WHEN trigger_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN LEFT(trigger_date, 10) ELSE trigger_date END`
 */
function projectTriggerDate(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('namespaced snooze:event# keys survive the reminder-logs projection intact', () => {
  it('guarded projection preserves the raw key instead of truncating it to snooze:eve', () => {
    // The defect: the unguarded projection truncates a namespaced key.
    expect(SNOOZE_KEY.slice(0, 10)).toBe('snooze:eve');
    // The guard returns the raw key unchanged...
    expect(projectTriggerDate(SNOOZE_KEY)).toBe(SNOOZE_KEY);
    // ...while normal/token rows still get their ymd.
    expect(projectTriggerDate(TOKEN_KEY)).toBe('2026-09-28');
    expect(projectTriggerDate(LEGACY_KEY)).toBe('2026-09-28');
  });

  it('/events/reminder-logs SQL applies the CASE guard and never aliases a bare LEFT', () => {
    expect(EVENTS_ROUTE_SOURCE).toContain(
      "CASE WHEN tl.trigger_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN LEFT(tl.trigger_date, 10) ELSE tl.trigger_date END AS trigger_date",
    );
    expect(EVENTS_ROUTE_SOURCE).not.toContain('LEFT(tl.trigger_date, 10) AS trigger_date');
  });
});

describe('namespaced keys are excluded from every day-based aggregation', () => {
  it('a snooze key prefix is not a ymd and can never equal the DB-local yesterday', () => {
    expect(SNOOZE_KEY.slice(0, 10)).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(STATS_SOURCE).toContain("LEFT(trigger_date, 10) = (CURRENT_DATE - INTERVAL '1 day')::date::text");
    // Equality only: a LIKE/comparison against a partial prefix would risk matching namespaced keys.
    expect(STATS_SOURCE).not.toContain('LIKE');
  });

  it('annual-report year filter excludes namespaced keys (prefix snoo is never a year)', () => {
    expect(FEATURES_ROUTE_SOURCE).toContain('LEFT(trigger_date, 4) = $2::text');
    expect(SNOOZE_KEY.slice(0, 4)).toBe('snoo');
    expect(/^\d{4}$/.test(SNOOZE_KEY.slice(0, 4))).toBe(false);
  });

  it('recommendations guard contributes no history day for a namespaced row', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          reminder_config: JSON.stringify({ enabled: true, daysBeforeList: [0], emailRecipients: [] }),
          date: '2026-09-10',
          trigger_date: SNOOZE_KEY,
          status: 'success',
        },
      ],
      rowCount: 1,
    });

    const days = await getRecommendedDaysFromHistory(1, 'birthday');
    // Only 0 (from daysBeforeList) may appear: the snooze row's ISO minute contains no ymd
    // prefix, so the regex guard drops it instead of fabricating an +11 day.
    expect(days).toEqual([0]);
    expect(RECOMMENDATIONS_SOURCE).toContain("return /^\\d{4}-\\d{2}-\\d{2}/.test(s) ? s.slice(0, 10) : null;");
  });
});

describe('prefix audit: which key families can reach event_trigger_logs', () => {
  it('recordEventTrigger call sites carry only ymd / ymd-token / snooze:event# keys', () => {
    // The namespaced writer exists and its shape is snooze:event#<id>#<ISO>.
    expect(TASKS_SOURCE).toContain('return `snooze:event#${eventId}#${minute}`;');
    // Scheduled reminders pass the same `sendKey` (snooze key or ymd token) to recordEventTrigger.
    expect(TASKS_SOURCE).toContain("await recordEventTrigger(event.id, event.user_id, 'scheduled', sendKey,");
    // The lunar-failure path passes a plain ymd.
    expect(TASKS_SOURCE).toContain("await recordEventTrigger(event.id, event.user_id, 'scheduled', evalDay,");

    const callLines = TASKS_SOURCE.split('\n').filter((line) => line.includes('recordEventTrigger(') && !line.includes('import'));
    expect(callLines.length).toBeGreaterThanOrEqual(3);
    for (const line of callLines) {
      // med:/habit/maintenance/expiry:/inventory:/document: keys are reminder_send_claims-only.
      expect(line).not.toMatch(/med:snooze|habit|maintenance|expiry:|inventory:|document:/);
    }
  });

  it('reminder_send_claims namespace prefixes are never inserted into event_trigger_logs', () => {
    // recordEventTrigger writes exactly the four columns-agnostic params; the only source of
    // namespaced values it can receive is the audited call sites above (snooze:event#).
    expect(TRIGGER_LOG_SERVICE_SOURCE).toContain('INSERT INTO event_trigger_logs');
    for (const prefix of ['med:snooze#', 'habit#h', 'habit:risk#h', 'maintenance:usage#', 'expiry:', 'inventory:', 'document:']) {
      const recordLines = TASKS_SOURCE.split('\n').filter((line) => line.includes('recordEventTrigger('));
      for (const line of recordLines) {
        expect(line).not.toContain(prefix);
      }
    }
  });
});
