import { describe, expect, it } from 'vitest';
import {
  addDaysYmd,
  holidayContextLabel,
  isYmd,
  jieqiOn,
  JIEQI_NAMES,
  nextWorkday,
  normalizeJieqiList,
  resolveHolidayEvalDays,
  resolveHolidayMode,
  safeHolidayName,
  safeIsHoliday,
  safeIsWorkday,
  shiftedHolidaySources,
} from '../services/holiday-reminder.service.js';

/**
 * Checkbox 78 — pure unit tests for the holiday/节气 helper layer.
 *
 * Pinned dataset facts (chinese-days@1.5.9):
 * - 2026 国庆节 block: 2026-10-01 .. 2026-10-07 (all 休), first workday 2026-10-08.
 * - 2026-10-10 (Saturday) is a 调休 班 workday.
 * - 2026 中秋: 2026-09-26 (Sat) + 2026-09-27 (Sun) are 休; 2026-09-28 (Mon) is a workday.
 */

describe('holiday-reminder.service — dates', () => {
  it('addDaysYmd rolls months/years and never yields a non-existent date', () => {
    expect(addDaysYmd('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysYmd('2025-02-28', 1)).toBe('2025-03-01');
    expect(addDaysYmd('not-a-date', 1)).toBeNull();
    expect(isYmd('2025-02-29')).toBe(false);
    expect(isYmd('2025-02-28')).toBe(true);
  });
});

describe('holiday-reminder.service — fail-open wrappers', () => {
  it('returns null (never throws) for an out-of-range year', () => {
    expect(safeIsHoliday('2031-01-01')).toBeNull();
    expect(safeIsWorkday('2031-01-01')).toBeNull();
    expect(safeHolidayName('2031-01-01')).toBeNull();
  });

  it('returns real values inside the covered range', () => {
    expect(safeIsHoliday('2026-10-01')).toBe(true);
    expect(safeIsWorkday('2026-10-08')).toBe(true);
    expect(safeHolidayName('2026-10-01')).toBe('国庆节');
  });
});

describe('holiday-reminder.service — mode parsing', () => {
  it('accepts the three modes and defaults to keep otherwise', () => {
    expect(resolveHolidayMode('shift')).toBe('shift');
    expect(resolveHolidayMode('suppress')).toBe('suppress');
    expect(resolveHolidayMode('keep')).toBe('keep');
    expect(resolveHolidayMode(undefined)).toBe('keep');
    expect(resolveHolidayMode(null)).toBe('keep');
    expect(resolveHolidayMode('weekly')).toBe('keep');
    expect(resolveHolidayMode(42)).toBe('keep');
  });
});

describe('holiday-reminder.service — jieqi', () => {
  it('detects the 24 节气 on the correct day and nothing otherwise', () => {
    expect(jieqiOn('2026-10-08')).toBe('寒露');
    expect(jieqiOn('2026-03-20')).toBe('春分');
    expect(jieqiOn('2026-06-21')).toBe('夏至');
    expect(jieqiOn('2026-10-01')).toBeNull();
    expect(jieqiOn('2031-01-01')).toBeNull(); // fail-open
    expect(jieqiOn('bad')).toBeNull();
  });

  it('normalizes a selection: drops non-节气 values, dedupes, keeps the fixed 24 order', () => {
    expect(normalizeJieqiList(['寒露', 'bogus', '寒露', '立春'])).toEqual(['立春', '寒露']);
    expect(normalizeJieqiList('["寒露","惊蛰"]')).toEqual(['惊蛰', '寒露']);
    expect(normalizeJieqiList('not json')).toEqual([]);
    expect(normalizeJieqiList(null)).toEqual([]);
    expect(normalizeJieqiList({ nope: true })).toEqual([]);
  });

  it('exposes exactly the 24 canonical names', () => {
    expect(JIEQI_NAMES).toHaveLength(24);
    expect(new Set(JIEQI_NAMES).size).toBe(24);
    expect(JIEQI_NAMES).toContain('寒露');
    expect(JIEQI_NAMES).toContain('大寒');
  });
});

describe('holiday-reminder.service — shift target', () => {
  it('skips the whole 国庆节 block to the first workday', () => {
    expect(nextWorkday('2026-10-07')).toBe('2026-10-08');
    expect(nextWorkday('2026-10-01')).toBe('2026-10-08');
  });

  it('treats a 调休 Saturday as a workday (weekend + 调休 resolution)', () => {
    expect(safeIsWorkday('2026-10-10')).toBe(true);
    expect(safeIsWorkday('2026-10-11')).toBe(false);
    expect(nextWorkday('2026-10-09')).toBe('2026-10-10');
  });

  it('resolves a statutory holiday that falls on a weekend to a valid workday', () => {
    expect(safeIsHoliday('2026-09-26')).toBe(true); // Saturday 中秋
    expect(nextWorkday('2026-09-26')).toBe('2026-09-28');
  });

  it('shifts a weekend holiday onto a 调休 Sunday workday (never a non-existent date)', () => {
    expect(safeIsHoliday('2026-01-03')).toBe(true); // Saturday 元旦
    expect(new Date('2026-01-04T00:00:00Z').getUTCDay()).toBe(0); // genuinely a Sunday
    expect(safeIsWorkday('2026-01-04')).toBe(true); // ...that is a 调休 班 workday
    expect(nextWorkday('2026-01-03')).toBe('2026-01-04');
    expect(resolveHolidayEvalDays('2026-01-04', 'shift')).toContain('2026-01-03');
    expect(shiftedHolidaySources('2026-01-04')).toContain('2026-01-03');
  });

  it('never lands on a non-existent or non-workday date across all covered holidays', () => {
    let cursor = '2025-01-01';
    let checked = 0;
    while (isYmd(cursor)) {
      if (safeIsHoliday(cursor) === true) {
        checked += 1;
        const target = nextWorkday(cursor);
        if (target !== null) {
          expect(isYmd(target), `${cursor} -> ${target} is not a real date`).toBe(true);
          expect(safeIsWorkday(target), `${cursor} -> ${target} is not a workday`).toBe(true);
          expect(target > cursor).toBe(true);
        }
      }
      const next = addDaysYmd(cursor, 1);
      if (!next || next.startsWith('2027-')) break;
      cursor = next;
    }
    expect(checked).toBeGreaterThan(40); // sanity: the dataset really was scanned (≈27 休 days/year)
  });

  it('fails open to null at the edge of the covered range', () => {
    expect(nextWorkday('2026-12-31')).toBeNull(); // 2027 is not covered
  });
});

describe('holiday-reminder.service — evaluation days', () => {
  it('keep keeps only today', () => {
    expect(resolveHolidayEvalDays('2026-10-01', 'keep')).toEqual(['2026-10-01']);
    expect(resolveHolidayEvalDays('2026-10-08', 'keep')).toEqual(['2026-10-08']);
  });

  it('suppress drops the holiday day and keeps workdays', () => {
    expect(resolveHolidayEvalDays('2026-10-01', 'suppress')).toEqual([]);
    expect(resolveHolidayEvalDays('2026-10-08', 'suppress')).toEqual(['2026-10-08']);
  });

  it('shift skips the holiday day and replays holiday sources on the next workday', () => {
    expect(resolveHolidayEvalDays('2026-10-01', 'shift')).toEqual([]);
    const days = resolveHolidayEvalDays('2026-10-08', 'shift');
    expect(days[0]).toBe('2026-10-08');
    expect(days).toContain('2026-10-01');
    expect(days).toContain('2026-10-07');
    // descending source days after today
    expect(days.slice(1)).toEqual(['2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01']);
  });

  it('shift leaves ordinary workdays and non-holiday weekends unchanged', () => {
    expect(resolveHolidayEvalDays('2026-10-10', 'shift')).toEqual(['2026-10-10']); // 调休 Sat workday, no holiday source
    expect(resolveHolidayEvalDays('2026-10-11', 'shift')).toEqual(['2026-10-11']); // plain Sunday
  });

  it('fails open to [today] for an uncovered year', () => {
    expect(resolveHolidayEvalDays('2031-10-01', 'shift')).toEqual(['2031-10-01']);
    expect(resolveHolidayEvalDays('2031-10-01', 'suppress')).toEqual(['2031-10-01']);
  });

  it('lists the holiday sources that map onto a workday', () => {
    expect(shiftedHolidaySources('2026-10-08')).toEqual([
      '2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01',
    ]);
    expect(shiftedHolidaySources('2026-09-28')).toEqual(['2026-09-27', '2026-09-26', '2026-09-25']);
    expect(shiftedHolidaySources('2026-10-10')).toEqual([]);
  });
});

describe('holiday-reminder.service — labels', () => {
  it('labels a holiday-day (keep) reminder with the holiday name', () => {
    expect(holidayContextLabel('2026-10-01', '2026-10-01')).toBe('今日国庆节（法定假日）');
    expect(holidayContextLabel('2026-09-26', '2026-09-26')).toBe('今日中秋（法定假日）');
  });

  it('labels a shifted reminder as a holiday-postponed one', () => {
    expect(holidayContextLabel('2026-10-07', '2026-10-08')).toBe('法定假日「国庆节」顺延提醒');
    expect(holidayContextLabel('2026-09-26', '2026-09-28')).toBe('法定假日「中秋」顺延提醒');
  });

  it('returns undefined for non-holidays', () => {
    expect(holidayContextLabel('2026-10-08', '2026-10-08')).toBeUndefined();
    expect(holidayContextLabel('2031-01-01', '2031-01-01')).toBeUndefined();
  });
});
