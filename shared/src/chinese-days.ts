/**
 * Chinese statutory holidays & 调休 (compensated workdays).
 *
 * Data: vendored `chinese-days` dataset (MIT, https://github.com/vsme/chinese-days),
 * pinned + checksum-verified by `scripts/fetch-chinese-days.mjs` into
 * `./data/chinese-days.json`. Coverage: 2004-01-01 .. 2026-12-31 (full years
 * 2004-2026). The dataset is bundled — never fetched over the network at runtime.
 *
 * Semantic contract (deliberately narrower than the upstream `isHoliday` helper,
 * which counts every weekend as a holiday):
 *   - `isHoliday(date)`  → true only for STATUTORY holidays (休), e.g. 2025-10-01.
 *   - `isWorkday(date)`  → true for 调休 shift workdays (班) and ordinary Mon-Fri
 *                          workdays that are not statutory holidays.
 *   - `holidayName(date)`→ Chinese statutory-holiday name (e.g. 国庆节), else null.
 *   - A regular weekend is neither: `isHoliday` false, `isWorkday` false,
 *     `getDayStatus` → 'weekend'.
 *
 * Any date outside the vendored range THROWS {@link ChineseDaysError} with code
 * `OUT_OF_RANGE` (message starts with `数据未覆盖`) — it never silently answers
 * `false`. Callers that must render a fallback can probe with
 * {@link isDateCovered} first.
 */

import rawDataset from './data/chinese-days.json' with { type: 'json' };
import rawMeta from './data/chinese-days.meta.json' with { type: 'json' };

export interface ChineseDaysDataset {
  /** date → "English name,中文名,type" — statutory holidays (休). */
  holidays: Record<string, string>;
  /** date → "English name,中文名,type" — 调休 compensated workdays (班). */
  workdays: Record<string, string>;
  /** date → "English name,中文名,type" — in-lieu rest days (补休). */
  inLieuDays: Record<string, string>;
}

export interface ChineseDaysCoverage {
  version: string;
  minDate: string;
  maxDate: string;
  years: number[];
}

export type ChineseDaysErrorCode = 'INVALID_DATE' | 'OUT_OF_RANGE';

export class ChineseDaysError extends Error {
  readonly code: ChineseDaysErrorCode;

  constructor(code: ChineseDaysErrorCode, message: string) {
    super(message);
    this.name = 'ChineseDaysError';
    this.code = code;
  }
}

export type ChineseDayStatus = 'holiday' | 'shift-workday' | 'workday' | 'weekend';

export interface ChineseDayInfo {
  date: string;
  status: ChineseDayStatus;
  /** Statutory holiday (休). */
  isHoliday: boolean;
  /** Working day, including 调休 shift workdays (班). */
  isWorkday: boolean;
  /** In-lieu rest day (补休) belonging to a statutory holiday block. */
  isInLieu: boolean;
  /** Chinese holiday name when the date is a statutory holiday, else null. */
  holidayName: string | null;
}

const dataset = rawDataset as unknown as ChineseDaysDataset;
const meta = rawMeta as unknown as {
  version: string;
  minDate: string;
  maxDate: string;
  yearsCovered: number[];
};

export const CHINESE_DAYS_VERSION = meta.version;

/** Years fully covered by the vendored dataset (2004-2026 for chinese-days@1.5.9). */
export const CHINESE_DAYS_COVERAGE: ChineseDaysCoverage = Object.freeze({
  version: meta.version,
  minDate: `${meta.yearsCovered[0]}-01-01`,
  maxDate: `${meta.yearsCovered[meta.yearsCovered.length - 1]}-12-31`,
  years: [...meta.yearsCovered],
});

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const COVERAGE_LABEL = `${CHINESE_DAYS_COVERAGE.minDate} ~ ${CHINESE_DAYS_COVERAGE.maxDate}`;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-calendar date key, matching the frontend's `dateKey()` helper. */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Validates a `YYYY-MM-DD` string (or Date) and rejects impossible calendar
 * dates such as 2025-02-29 or 2025-13-01.
 */
function normalizeDate(input: string | Date): string {
  const key = typeof input === 'string' ? input : toDateKey(input);
  const match = DATE_PATTERN.exec(key);
  if (!match) {
    throw new ChineseDaysError(
      'INVALID_DATE',
      `无效日期: "${key}"，期望 YYYY-MM-DD 格式（例如 2025-10-01）`,
    );
  }
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new ChineseDaysError('INVALID_DATE', `无效日期: "${key}" 不是真实存在的公历日期`);
  }
  return key;
}

function assertCovered(key: string): void {
  const year = Number(key.slice(0, 4));
  const first = CHINESE_DAYS_COVERAGE.years[0];
  const last = CHINESE_DAYS_COVERAGE.years[CHINESE_DAYS_COVERAGE.years.length - 1];
  if (year < first || year > last) {
    throw new ChineseDaysError(
      'OUT_OF_RANGE',
      `数据未覆盖: ${key} 不在已收录范围 ${COVERAGE_LABEL} 内（chinese-days@${CHINESE_DAYS_VERSION}，共 ${CHINESE_DAYS_COVERAGE.years.length} 年）`,
    );
  }
}

/** Non-throwing probe: is this date inside the vendored dataset range? */
export function isDateCovered(input: string | Date): boolean {
  try {
    assertCovered(normalizeDate(input));
    return true;
  } catch {
    return false;
  }
}

export function getCoverage(): ChineseDaysCoverage {
  return { ...CHINESE_DAYS_COVERAGE, years: [...CHINESE_DAYS_COVERAGE.years] };
}

/** Chinese statutory holiday name (休), or null for non-holidays. */
export function holidayName(input: string | Date): string | null {
  const key = normalizeDate(input);
  assertCovered(key);
  const raw = dataset.holidays[key];
  if (!raw) return null;
  const parts = raw.split(',');
  return (parts[1] || parts[0]).trim() || null;
}

/** Statutory holiday (休) — weekends are NOT counted; see module contract. */
export function isHoliday(input: string | Date): boolean {
  const key = normalizeDate(input);
  assertCovered(key);
  return Boolean(dataset.holidays[key]);
}

/** Working day, including 调休 shift workdays (班). Weekends return false. */
export function isWorkday(input: string | Date): boolean {
  const key = normalizeDate(input);
  assertCovered(key);
  if (dataset.workdays[key]) return true;
  if (dataset.holidays[key]) return false;
  const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

/** In-lieu rest day (补休) inside a statutory holiday block. */
export function isInLieu(input: string | Date): boolean {
  const key = normalizeDate(input);
  assertCovered(key);
  return Boolean(dataset.inLieuDays[key]);
}

/** Full per-day picture used by the calendar UI (休/班 markers, legend). */
export function getDayInfo(input: string | Date): ChineseDayInfo {
  const key = normalizeDate(input);
  assertCovered(key);
  const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  const holiday = Boolean(dataset.holidays[key]);
  const shiftWorkday = Boolean(dataset.workdays[key]);
  const inLieu = Boolean(dataset.inLieuDays[key]);
  const workday = shiftWorkday || (!holiday && weekday >= 1 && weekday <= 5);
  const status: ChineseDayStatus = holiday
    ? 'holiday'
    : shiftWorkday
      ? 'shift-workday'
      : workday
        ? 'workday'
        : 'weekend';
  return {
    date: key,
    status,
    isHoliday: holiday,
    isWorkday: workday,
    isInLieu: inLieu,
    holidayName: holiday ? holidayName(key) : null,
  };
}
