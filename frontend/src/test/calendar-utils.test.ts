import { describe, expect, it } from 'vitest';
import type { Event } from '@timemark/shared';
import {
  daysUntilEvent,
  diffToCountdownParts,
  getEventCountdownTarget,
  resolveNextOccurrenceDate,
} from '../lib/calendar-utils';

const birthdayEvent = (date: string): Event => ({
  id: '1',
  userId: '1',
  name: '测试生日',
  type: 'birthday',
  date,
  calendarType: 'gregorian',
  reminderConfig: {
    enabled: true,
    daysBeforeList: [7],
    emailRecipients: [],
    reminderTimes: ['09:00'],
  },
  createdAt: '',
});

describe('event countdown', () => {
  it('rolls birthday to next year when stored date is in the past', () => {
    const ref = new Date('2026-07-18T11:00:00');
    const next = resolveNextOccurrenceDate(birthdayEvent('1990-07-28'), ref);
    expect(next).toBe('2026-07-28');
    expect(daysUntilEvent(next, ref)).toBe(10);
  });

  it('counts down to event day not next reminder push', () => {
    const ref = new Date('2026-07-18T11:00:00');
    const target = getEventCountdownTarget(birthdayEvent('2026-07-28'), ref)!;
    const parts = diffToCountdownParts(target, ref)!;
    expect(parts.days).toBe(9);
    expect(parts.hours).toBe(22);
    expect(parts.days).toBeGreaterThan(1);
  });

  it('uses nextOccurrence when provided', () => {
    const ref = new Date('2026-07-18T12:00:00');
    const event = { ...birthdayEvent('1990-07-28'), nextOccurrence: '2026-07-28' };
    expect(resolveNextOccurrenceDate(event, ref)).toBe('2026-07-28');
  });
});
