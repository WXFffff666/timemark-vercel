import { describe, expect, it } from 'vitest';
import { getTodayDateKey } from '../lib/timezone-utils';
import { daysUntilEvent } from '../lib/calendar-utils';

describe('timezone-utils', () => {
  it('uses Asia/Shanghai calendar day by default', () => {
    const ref = new Date('2026-07-18T20:00:00Z'); // Jul 19 04:00 in Shanghai
    expect(getTodayDateKey('Asia/Shanghai', ref)).toBe('2026-07-19');
    expect(getTodayDateKey('UTC', ref)).toBe('2026-07-18');
  });

  it('computes days until event in selected timezone', () => {
    const ref = new Date('2026-07-18T12:00:00');
    expect(daysUntilEvent('2026-07-28', ref, 'Asia/Shanghai')).toBe(10);
    expect(daysUntilEvent('2026-07-28', ref, 'UTC')).toBeGreaterThanOrEqual(9);
  });
});
