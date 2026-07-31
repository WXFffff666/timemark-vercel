import { describe, it, expect } from 'vitest';
import {
  runLunarCalendarSelfTest,
  verifyLunarGregorianRoundtrip,
  type LunarConverter,
} from './lunar-calendar.js';

const mockConverter: LunarConverter = {
  gregorianToLunar(ymd) {
    if (ymd === '2026-07-31') return { year: 2026, month: 6, day: 17, isLeap: false };
    return null;
  },
  lunarToGregorian(lunar) {
    if (lunar.year === 2026 && lunar.month === 6 && lunar.day === 17) return '2026-07-31';
    return null;
  },
};

describe('lunar-calendar verify', () => {
  it('roundtrips gregorian through lunar and back', () => {
    const sample = verifyLunarGregorianRoundtrip(mockConverter, '2026-07-31', {
      year: 2026,
      month: 6,
      day: 17,
    });
    expect(sample.ok).toBe(true);
    expect(sample.roundtrip).toBe('2026-07-31');
  });

  it('runs self test with injected converter', () => {
    const result = runLunarCalendarSelfTest(mockConverter);
    expect(result.samples.length).toBeGreaterThanOrEqual(3);
  });
});
