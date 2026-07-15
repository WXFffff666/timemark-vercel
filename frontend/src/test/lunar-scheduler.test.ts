import { describe, it, expect } from 'vitest';
import { Lunar } from 'lunar-javascript';

/** Mirror backend resolveLunarTarget logic */
function resolveLunarDiff(today: string, lunarData: { month: number; day: number; isLeap?: boolean }, years: number[]) {
  const month = lunarData.isLeap ? -lunarData.month : lunarData.month;
  for (const year of years) {
    const solar = Lunar.fromYmd(year, month, lunarData.day).getSolar();
    const tryDateStr = `${solar.getYear()}-${String(solar.getMonth()).padStart(2, '0')}-${String(solar.getDay()).padStart(2, '0')}`;
    const a = new Date(today + 'T00:00:00Z');
    const b = new Date(tryDateStr + 'T00:00:00Z');
    const diff = Math.round((b.getTime() - a.getTime()) / 86400000);
    if (diff >= 0) return { diff, tryDateStr };
  }
  return null;
}

describe('lunar scheduler edge cases', () => {
  it('handles leap month 2020-闰4-15', () => {
    const r = resolveLunarDiff('2020-05-20', { month: 4, day: 15, isLeap: true }, [2020, 2021]);
    expect(r).not.toBeNull();
  });

  it('handles regular lunar month', () => {
    const r = resolveLunarDiff('2026-01-01', { month: 1, day: 1 }, [2026, 2027]);
    expect(r).not.toBeNull();
  });

  it('rejects invalid lunar day', () => {
    expect(() => Lunar.fromYmd(2024, 12, 30)).toThrow();
  });
});
