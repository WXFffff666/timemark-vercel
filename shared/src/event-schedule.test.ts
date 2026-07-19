import { describe, it, expect } from 'vitest';
import {
  buildReminderSendKey,
  diffCalendarDays,
  isYearlyOccurrenceEvent,
  resolveNextGregorianOccurrence,
} from './event-schedule.js';

describe('event-schedule', () => {
  it('rolls birthday year forward to next occurrence', () => {
    expect(
      resolveNextGregorianOccurrence('1990-07-28', '2026-07-18', { eventType: 'birthday' }),
    ).toBe('2026-07-28');
    expect(
      resolveNextGregorianOccurrence('1990-07-28', '2026-07-28', { eventType: 'birthday' }),
    ).toBe('2026-07-28');
    expect(
      resolveNextGregorianOccurrence('1990-07-28', '2026-07-29', { eventType: 'birthday' }),
    ).toBe('2027-07-28');
  });

  it('uses nextOccurrence when still in the future', () => {
    expect(
      resolveNextGregorianOccurrence('1990-07-28', '2026-07-01', {
        eventType: 'birthday',
        nextOccurrence: '2026-08-01',
      }),
    ).toBe('2026-08-01');
  });

  it('detects yearly events', () => {
    expect(isYearlyOccurrenceEvent('birthday')).toBe(true);
    expect(isYearlyOccurrenceEvent('meeting', { enabled: true, frequency: 'yearly' })).toBe(true);
    expect(isYearlyOccurrenceEvent('meeting', { enabled: true, frequency: 'monthly' })).toBe(false);
  });

  it('diffCalendarDays matches cron helper', () => {
    expect(diffCalendarDays('2026-07-18', '2026-07-28')).toBe(10);
    expect(diffCalendarDays('2026-07-18', '2026-07-11')).toBe(-7);
  });

  it('buildReminderSendKey encodes day tier and time slot', () => {
    expect(buildReminderSendKey('2026-07-21', 7, '09:00')).toBe('2026-07-21#d7#t09:00');
    expect(buildReminderSendKey('2026-07-21', 7, '18:00')).not.toBe(
      buildReminderSendKey('2026-07-21', 7, '09:00'),
    );
  });
});
