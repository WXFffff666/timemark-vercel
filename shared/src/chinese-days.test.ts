import { describe, it, expect } from 'vitest';
import {
  CHINESE_DAYS_COVERAGE,
  CHINESE_DAYS_VERSION,
  ChineseDaysError,
  getCoverage,
  getDayInfo,
  holidayName,
  isDateCovered,
  isHoliday,
  isInLieu,
  isWorkday,
} from './chinese-days';

describe('chinese-days: acceptance pins (plan todo 76)', () => {
  it('isHoliday(2025-10-01) is true and holidayName is 国庆节', () => {
    expect(isHoliday('2025-10-01')).toBe(true);
    expect(holidayName('2025-10-01')).toBe('国庆节');
    expect(getDayInfo('2025-10-01').status).toBe('holiday');
  });

  it('a 调休 workday (2025-09-28, a Sunday) is isWorkday true && isHoliday false', () => {
    // 2025-09-28 is a Sunday compensated as a workday for the National Day block.
    expect(new Date('2025-09-28T00:00:00Z').getUTCDay()).toBe(0);
    expect(isWorkday('2025-09-28')).toBe(true);
    expect(isHoliday('2025-09-28')).toBe(false);
    expect(getDayInfo('2025-09-28').status).toBe('shift-workday');
    // The second compensated day of the same block.
    expect(isWorkday('2025-10-11')).toBe(true);
    expect(isHoliday('2025-10-11')).toBe(false);
  });

  it('an out-of-range year fails with a clear 数据未覆盖 message (never a silent false)', () => {
    for (const call of [
      () => isHoliday('1999-01-01'),
      () => isWorkday('1999-01-01'),
      () => holidayName('1999-01-01'),
      () => getDayInfo('2027-01-01'),
    ]) {
      let caught: unknown;
      try {
        call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChineseDaysError);
      const err = caught as ChineseDaysError;
      expect(err.code).toBe('OUT_OF_RANGE');
      expect(err.message).toContain('数据未覆盖');
      expect(err.message).toContain('2004');
      expect(err.message).toContain('2026');
    }
  });

  it('out-of-range probe isDateCovered returns false without throwing', () => {
    expect(isDateCovered('1999-12-31')).toBe(false);
    expect(isDateCovered('2026-12-31')).toBe(true);
    expect(isDateCovered('2004-01-01')).toBe(true);
    expect(isDateCovered('2027-01-01')).toBe(false);
  });
});

describe('chinese-days: dataset coverage', () => {
  it('records the vendored years (2004-2026) in the coverage metadata', () => {
    expect(CHINESE_DAYS_VERSION).toBe('1.5.9');
    expect(CHINESE_DAYS_COVERAGE.years[0]).toBe(2004);
    expect(CHINESE_DAYS_COVERAGE.years[CHINESE_DAYS_COVERAGE.years.length - 1]).toBe(2026);
    expect(CHINESE_DAYS_COVERAGE.years).toHaveLength(23);
    expect(getCoverage().minDate).toBe('2004-01-01');
    expect(getCoverage().maxDate).toBe('2026-12-31');
  });
});

describe('chinese-days: day-status semantics', () => {
  it('ordinary Mon-Fri is a workday, a plain weekend is neither holiday nor workday', () => {
    expect(getDayInfo('2025-10-13')).toMatchObject({ status: 'workday', isHoliday: false, isWorkday: true });
    expect(getDayInfo('2025-10-18')).toMatchObject({ status: 'weekend', isHoliday: false, isWorkday: false });
    expect(getDayInfo('2025-10-19')).toMatchObject({ status: 'weekend', isHoliday: false, isWorkday: false });
  });

  it('in-lieu rest days (补休) are flagged inside the holiday block', () => {
    expect(getDayInfo('2025-10-07').isInLieu).toBe(true);
    expect(isInLieu('2025-10-08')).toBe(true);
    expect(isInLieu('2025-10-01')).toBe(false);
    expect(isHoliday('2025-10-06')).toBe(true);
    expect(holidayName('2025-10-06')).toBe('中秋');
  });

  it('chained-holiday block 2025-10-01..08 all count as 休, and 2025-10-09 resumes work', () => {
    for (let d = 1; d <= 8; d += 1) {
      expect(isHoliday(`2025-10-${String(d).padStart(2, '0')}`), `2025-10-${d}`).toBe(true);
    }
    expect(isWorkday('2025-10-09')).toBe(true);
    expect(isHoliday('2025-10-09')).toBe(false);
  });

  it('accepts Date instances using local calendar components', () => {
    expect(isHoliday(new Date(2025, 9, 1))).toBe(true);
    expect(isWorkday(new Date(2025, 8, 28))).toBe(true);
  });
});

describe('chinese-days: malformed input', () => {
  it.each(['2025-13-01', '2025-02-29', '2025-00-10', '2025-1-1', 'not-a-date', '', '2025/10/01'])(
    'rejects invalid date %j with a clear INVALID_DATE error',
    (input) => {
      let caught: unknown;
      try {
        isHoliday(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChineseDaysError);
      expect((caught as ChineseDaysError).code).toBe('INVALID_DATE');
      expect((caught as ChineseDaysError).message).toContain('无效日期');
    },
  );

  it('2024-02-29 (a real leap day) is accepted', () => {
    expect(isDateCovered('2024-02-29')).toBe(true);
    expect(() => isWorkday('2024-02-29')).not.toThrow();
  });
});
