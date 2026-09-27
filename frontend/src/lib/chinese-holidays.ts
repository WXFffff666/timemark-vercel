import {
  CHINESE_DAYS_COVERAGE,
  getDayInfo,
  isDateCovered,
} from '@timemark/shared/chinese-days';

/**
 * UI-facing wrapper around @timemark/shared/chinese-days (plan todo 76d).
 *
 * The calendar renders 休 (statutory holiday) / 班 (调休 shift workday) markers
 * and holiday names per day; years outside the vendored range show a
 * 数据未覆盖 state instead of a wrong "no holiday" answer.
 */

export interface HolidayCoverage {
  minYear: number;
  maxYear: number;
  label: string;
  version: string;
}

export type HolidayMarkerKind = 'holiday' | 'shift-workday';

export interface HolidayMarker {
  kind: HolidayMarkerKind;
  /** 休 for statutory holidays, 班 for compensated workdays. */
  label: '休' | '班';
  /** Chinese statutory-holiday name (e.g. 国庆节) when known. */
  name: string | null;
}

export function getHolidayCoverage(): HolidayCoverage {
  const years = CHINESE_DAYS_COVERAGE.years;
  const minYear = years[0];
  const maxYear = years[years.length - 1];
  return {
    minYear,
    maxYear,
    label: `${minYear}-${maxYear}`,
    version: CHINESE_DAYS_COVERAGE.version,
  };
}

export function isYearCovered(year: number): boolean {
  const { minYear, maxYear } = getHolidayCoverage();
  return Number.isInteger(year) && year >= minYear && year <= maxYear;
}

/** Non-throwing: malformed / out-of-range dates simply have no marker. */
export function getHolidayMarker(dateKey: string): HolidayMarker | null {
  if (!isDateCovered(dateKey)) return null;
  const info = getDayInfo(dateKey);
  if (info.status === 'holiday') {
    return { kind: 'holiday', label: '休', name: info.holidayName };
  }
  if (info.status === 'shift-workday') {
    return { kind: 'shift-workday', label: '班', name: null };
  }
  return null;
}
