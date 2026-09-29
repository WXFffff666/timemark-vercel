import { describe, expect, it } from 'vitest';
import { formatLunarDate, formatLunarMonthDay, lunarToSolar, resolveEventLunarLabel, solarToLunar } from '../lib/lunar';
import type { LunarDate } from '../lib/lunar';

const testCases = [
  { solar: '2024-01-01', lunar: { year: 2023, month: 11, day: 20, isLeap: false }, desc: '元旦' },
  { solar: '2024-02-10', lunar: { year: 2024, month: 1, day: 1, isLeap: false }, desc: '春节' },
  { solar: '2025-10-06', lunar: { year: 2025, month: 8, day: 15, isLeap: false }, desc: '2025中秋' },
];

describe('lunar conversion', () => {
  it.each(testCases)('converts $desc from solar to lunar and back', ({ solar, lunar }) => {
    const [year, month, day] = solar.split('-').map(Number);
    const solarDate = new Date(year, month - 1, day, 12, 0, 0);
    const lunarDate = solarToLunar(solarDate);
    expect(lunarDate).toMatchObject(lunar);
    expect(formatLunarDate(lunarDate)).toContain('年');

    const backToSolar = lunarToSolar(lunar);
    expect(backToSolar.getFullYear()).toBe(year);
    expect(backToSolar.getMonth()).toBe(month - 1);
    expect(backToSolar.getDate()).toBe(day);
  });

  it('formats a lunar month-day label', () => {
    expect(formatLunarMonthDay({ year: 2025, month: 8, day: 15, isLeap: false })).toBe('八月十五');
    expect(formatLunarMonthDay({ year: 2025, month: 2, day: 1, isLeap: true })).toBe('闰二月初一');
  });
});

const dualEvent = (lunarDate: LunarDate | undefined, date = '2026-10-05') =>
  ({ calendarType: 'both' as const, date, lunarDate });

describe('resolveEventLunarLabel (checkbox 169)', () => {
  it('reads the persisted lunar_date as-is for a dual-calendar event', () => {
    expect(resolveEventLunarLabel(dualEvent({ year: 2026, month: 8, day: 15, isLeap: false }))).toEqual({
      label: '农历八月十五',
      error: null,
    });
  });

  it('handles a leap month encoded as a negative month', () => {
    expect(resolveEventLunarLabel(dualEvent({ year: 2025, month: -2, day: 1, isLeap: false }, '2025-03-01'))).toEqual({
      label: '农历闰二月初一',
      error: null,
    });
  });

  it('derives the label from the Gregorian date when lunar_date is missing (in range)', () => {
    const result = resolveEventLunarLabel({ calendarType: 'lunar', date: '2025-10-06', lunarDate: undefined });
    expect(result.error).toBeNull();
    expect(result.label).toBe('农历八月十五');
  });

  it('surfaces a clear error for an out-of-range year instead of a wrong date', () => {
    const result = resolveEventLunarLabel({ calendarType: 'lunar', date: '2027-01-01', lunarDate: undefined });
    expect(result.label).toBe('');
    expect(result.error).toBe('农历数据不可用（仅支持 2004–2026 年）');
  });

  it('degrades gracefully when a lunar event has no lunar_date and an unusable date', () => {
    expect(resolveEventLunarLabel({ calendarType: 'both', date: '', lunarDate: undefined })).toEqual({
      label: '',
      error: null,
    });
  });

  it('returns nothing for a Gregorian event', () => {
    expect(resolveEventLunarLabel({ calendarType: 'gregorian', date: '2026-10-05', lunarDate: { year: 2026, month: 8, day: 15, isLeap: false } })).toEqual({
      label: '',
      error: null,
    });
  });
});
