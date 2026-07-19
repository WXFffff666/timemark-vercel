import { describe, it, expect } from 'vitest';
import {
  buildReminderSendKey,
  diffCalendarDays,
  resolveNextGregorianOccurrence,
} from '@timemark/shared/event-schedule';

describe('reminder scheduling', () => {
  it('fires 7 days before birthday stored with birth year', () => {
    const today = '2026-07-21';
    const next = resolveNextGregorianOccurrence('1990-07-28', today, { eventType: 'birthday' });
    const daysUntil = diffCalendarDays(today, next);
    expect(daysUntil).toBe(7);
    expect([7, 1, 0].includes(daysUntil)).toBe(true);
  });

  it('fires on the day of event', () => {
    const today = '2026-07-28';
    const next = resolveNextGregorianOccurrence('1990-07-28', today, { eventType: 'birthday' });
    expect(diffCalendarDays(today, next)).toBe(0);
  });

  it('allows multiple reminder times on same day via distinct send keys', () => {
    const day = '2026-07-21';
    const k1 = buildReminderSendKey(day, 7, '09:00');
    const k2 = buildReminderSendKey(day, 7, '18:00');
    expect(k1).not.toBe(k2);
  });

  it('allows separate sends for 7-day, 1-day, and same-day tiers', () => {
    const keys = [
      buildReminderSendKey('2026-07-21', 7, '09:00'),
      buildReminderSendKey('2026-07-27', 1, '09:00'),
      buildReminderSendKey('2026-07-28', 0, '09:00'),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});
