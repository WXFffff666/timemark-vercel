import { describe, expect, it } from 'vitest';
import { formatLunarDate, lunarToSolar, solarToLunar } from '../lib/lunar';

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
});
