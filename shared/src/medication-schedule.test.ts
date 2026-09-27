import { describe, expect, it } from 'vitest';
import {
  MEDICATION_ESCALATION_MINUTES,
  MEDICATION_REFILL_DAYS,
  MEDICATION_SNOOZE_MINUTES,
  averageDosesPerDay,
  buildDoseEscalationKey,
  buildDoseReminderKey,
  buildDoseSnoozeKey,
  computeDaysOfSupply,
  isMedicationScheduledOn,
  isWithinMinutes,
  normalizeMedicationTimes,
} from './medication-schedule.js';

/**
 * 用药提醒纯函数（D3，checkbox 72/73）—— 与 habit-schedule 同构：
 * 所有日期运算基于 YMD + UTC，不读系统时区，任意服务器 TZ 结果一致。
 */
describe('normalizeMedicationTimes', () => {
  it('keeps valid HH:mm, drops junk, dedupes and sorts', () => {
    expect(normalizeMedicationTimes(['20:00', '08:00', '08:00', '8:00', '25:00', '', '23:59'])).toEqual([
      '08:00',
      '20:00',
      '23:59',
    ]);
  });

  it('returns [] for a non-array', () => {
    expect(normalizeMedicationTimes(null)).toEqual([]);
    expect(normalizeMedicationTimes('08:00')).toEqual([]);
  });
});

describe('isMedicationScheduledOn', () => {
  it('treats null / empty schedule_days as every day', () => {
    expect(isMedicationScheduledOn('2026-09-28', null)).toBe(true); // Monday
    expect(isMedicationScheduledOn('2026-09-28', [])).toBe(true);
  });

  it('only matches the configured weekdays (0=Sunday..6=Saturday)', () => {
    expect(isMedicationScheduledOn('2026-09-28', [1, 3, 5])).toBe(true); // Monday
    expect(isMedicationScheduledOn('2026-09-27', [1, 3, 5])).toBe(false); // Sunday
    expect(isMedicationScheduledOn('2026-09-30', [1, 3, 5])).toBe(true); // Wednesday
  });
});

describe('averageDosesPerDay / computeDaysOfSupply', () => {
  it('daily regimen: times per day', () => {
    expect(averageDosesPerDay(['08:00', '20:00'], null)).toBe(2);
    expect(averageDosesPerDay(['08:00'], null)).toBe(1);
  });

  it('weekly regimen is pro-rated by scheduled days / 7', () => {
    expect(averageDosesPerDay(['08:00'], [1, 3, 5])).toBeCloseTo(3 / 7, 6);
    expect(computeDaysOfSupply(10, 1, ['08:00'], [1, 3, 5])).toBeCloseTo(10 / (3 / 7), 6);
  });

  it('projects days-of-supply from stock, units per dose and schedule', () => {
    expect(computeDaysOfSupply(10, 0.5, ['08:00'], null)).toBe(20); // 10 / 0.5
    expect(computeDaysOfSupply(6, 1, ['08:00'], null)).toBe(6);
    expect(computeDaysOfSupply(10, 1, ['08:00', '20:00'], null)).toBe(5);
  });

  it('returns null when it cannot be projected (no stock / PRN / bad unit)', () => {
    expect(computeDaysOfSupply(null, 1, ['08:00'], null)).toBeNull();
    expect(computeDaysOfSupply(100, 1, [], null)).toBeNull();
    expect(computeDaysOfSupply(100, 0, ['08:00'], null)).toBeNull();
  });
});

describe('isWithinMinutes', () => {
  it('matches inside the window (inclusive) and rejects outside', () => {
    const base = new Date('2026-09-28T08:00:00Z');
    expect(isWithinMinutes(new Date('2026-09-28T08:02:00Z'), base, 2)).toBe(true);
    expect(isWithinMinutes(new Date('2026-09-28T07:58:00Z'), base, 2)).toBe(true);
    expect(isWithinMinutes(new Date('2026-09-28T08:03:00Z'), base, 2)).toBe(false);
  });
});

describe('dose dedup keys', () => {
  it('namespaces reminder / escalation / snooze keys per dose', () => {
    const iso = '2026-09-28T00:00:00.000Z';
    expect(buildDoseReminderKey(7, iso)).toBe(`med:dose#7#${iso}`);
    expect(buildDoseEscalationKey(7, iso)).toBe(`med:esc#7#${iso}`);
    expect(buildDoseSnoozeKey(7, iso)).toBe(`med:snooze#7#${iso}`);
  });

  it('exposes the documented medication constants', () => {
    expect(MEDICATION_REFILL_DAYS).toBe(7);
    expect(MEDICATION_SNOOZE_MINUTES).toBe(10);
    expect(MEDICATION_ESCALATION_MINUTES).toBe(30);
  });
});
