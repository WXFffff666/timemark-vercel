import { describe, expect, it } from 'vitest';
import { getHolidayCoverage, getHolidayMarker, isYearCovered } from './chinese-holidays';

describe('chinese-holidays UI helpers (plan todo 76d)', () => {
  it('marks 2025-10-01 as a 休 statutory holiday with its Chinese name', () => {
    expect(getHolidayMarker('2025-10-01')).toEqual({ kind: 'holiday', label: '休', name: '国庆节' });
  });

  it('marks the 2025-09-28 compensated Sunday as 班', () => {
    expect(getHolidayMarker('2025-09-28')).toEqual({ kind: 'shift-workday', label: '班', name: null });
    expect(getHolidayMarker('2025-10-11')).toEqual({ kind: 'shift-workday', label: '班', name: null });
  });

  it('returns null for ordinary workdays and weekends', () => {
    expect(getHolidayMarker('2025-10-13')).toBeNull();
    expect(getHolidayMarker('2025-10-18')).toBeNull();
  });

  it('out-of-range years have no marker and report uncovered coverage', () => {
    expect(getHolidayMarker('1999-01-01')).toBeNull();
    expect(getHolidayMarker('2027-10-01')).toBeNull();
    expect(isYearCovered(1999)).toBe(false);
    expect(isYearCovered(2027)).toBe(false);
    expect(isYearCovered(2004)).toBe(true);
    expect(isYearCovered(2026)).toBe(true);
    expect(getHolidayCoverage()).toMatchObject({ minYear: 2004, maxYear: 2026, label: '2004-2026' });
  });

  it('malformed date keys degrade to null instead of throwing', () => {
    expect(getHolidayMarker('not-a-date')).toBeNull();
    expect(getHolidayMarker('')).toBeNull();
  });
});
