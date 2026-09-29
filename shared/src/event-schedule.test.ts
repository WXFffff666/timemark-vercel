import { describe, it, expect } from 'vitest';
import {
  buildReminderSendKey,
  diffCalendarDays,
  isYearlyOccurrenceEvent,
  matchesReminderTimeWindow,
  pickSoonestOccurrenceOnOrAfter,
  reminderOffsetMinutes,
  resolveNextGregorianOccurrence,
  toYmdString,
  REMINDER_CATCH_UP_MAX_MINUTES,
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

  it('accepts pg DATE values as JavaScript Date', () => {
    // pg DATE is built at LOCAL midnight (`new Date(y, m, d)`); use the local ctor
    // so this stays correct under any TZ (see `toYmdString` invariant).
    expect(
      resolveNextGregorianOccurrence('1990-07-28', '2026-07-01', {
        eventType: 'birthday',
        nextOccurrence: new Date(2026, 7, 1),
      }),
    ).toBe('2026-08-01');
    expect(
      resolveNextGregorianOccurrence(new Date(1990, 6, 28), '2026-07-18', {
        eventType: 'birthday',
      }),
    ).toBe('2026-07-28');
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

  it('matchesReminderTimeWindow within ±2 minutes', () => {
    expect(matchesReminderTimeWindow('09:00', '09:00')).toBe(true);
    expect(matchesReminderTimeWindow('09:01', '09:00')).toBe(true);
    expect(matchesReminderTimeWindow('08:58', '09:00')).toBe(true);
    expect(matchesReminderTimeWindow('08:57', '09:00')).toBe(false);
    expect(matchesReminderTimeWindow('09:02', '09:00')).toBe(true);
    expect(matchesReminderTimeWindow('09:03', '09:00')).toBe(false);
  });

  it('catch-up window is a late-only SUPERSET of the ±2 on-time window (checkbox 166)', () => {
    const win = (t: string) => matchesReminderTimeWindow(t, '09:00', 2, 10);
    // 准时窗口的每个命中在开启补发后仍命中（不回归）
    for (const t of ['08:58', '08:59', '09:00', '09:01', '09:02']) {
      expect(win(t)).toBe(true);
    }
    // 迟到方向扩展到 [target, target + 10]
    expect(win('09:03')).toBe(true);
    expect(win('09:05')).toBe(true);
    expect(win('09:10')).toBe(true);
    expect(win('09:11')).toBe(false);
    // 提前方向绝不扩展（提醒永不提前）
    expect(win('08:57')).toBe(false);
    expect(win('08:50')).toBe(false);
  });

  it('catch-up = 0 / absent keeps the legacy ±2 behaviour byte-for-byte', () => {
    expect(matchesReminderTimeWindow('09:03', '09:00', 2, 0)).toBe(false);
    expect(matchesReminderTimeWindow('09:02', '09:00', 2, 0)).toBe(true);
    expect(matchesReminderTimeWindow('08:58', '09:00', 2, 0)).toBe(true);
    expect(matchesReminderTimeWindow('08:57', '09:00', 2, 0)).toBe(false);
    // 默认第 4 参数 = 0
    expect(matchesReminderTimeWindow('09:03', '09:00', 2)).toBe(false);
  });

  it('clamps the catch-up window to the 60-minute ceiling (cannot reach the previous day)', () => {
    expect(REMINDER_CATCH_UP_MAX_MINUTES).toBe(60);
    // 请求 5000 分钟 -> 夹到 60：10:00 (= target + 60) 命中，10:01 不命中
    expect(matchesReminderTimeWindow('10:00', '09:00', 2, 5000)).toBe(true);
    expect(matchesReminderTimeWindow('10:01', '09:00', 2, 5000)).toBe(false);
    // 负数按 0 处理 -> 旧行为
    expect(matchesReminderTimeWindow('09:03', '09:00', 2, -5)).toBe(false);
    // 一天上限内的 23:00（+14h）绝不命中
    expect(matchesReminderTimeWindow('23:00', '09:00', 2, 5000)).toBe(false);
  });

  it('reminderOffsetMinutes returns signed offset or null', () => {
    expect(reminderOffsetMinutes('09:05', '09:00')).toBe(5);
    expect(reminderOffsetMinutes('08:55', '09:00')).toBe(-5);
    expect(reminderOffsetMinutes('09:00', '09:00')).toBe(0);
    expect(reminderOffsetMinutes('nope', '09:00')).toBeNull();
    expect(reminderOffsetMinutes('09:00', '')).toBeNull();
  });

  it('pickSoonestOccurrenceOnOrAfter chooses nearest future date', () => {
    expect(pickSoonestOccurrenceOnOrAfter('2026-07-18', ['2026-07-28', '2026-08-01'])).toBe('2026-07-28');
    expect(pickSoonestOccurrenceOnOrAfter('2026-07-28', ['2026-07-20', '2026-07-28'])).toBe('2026-07-28');
    expect(pickSoonestOccurrenceOnOrAfter('2026-07-29', ['2026-07-20', '2026-07-28'])).toBeNull();
  });
});

describe('toYmdString (pg DATE → local midnight)', () => {
  it('keeps the calendar day of a pg DATE Date — the /expiry off-by-one regression', () => {
    // pg DATE "2026-10-03" → postgres-date builds new Date(2026, 9, 3) = local midnight.
    // Under TZ=Asia/Shanghai the old getUTC* getters returned "2026-10-02".
    expect(toYmdString(new Date(2026, 9, 3))).toBe('2026-10-03');
  });

  it('round-trips a locally-constructed calendar date', () => {
    expect(toYmdString(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(toYmdString(new Date(2024, 1, 29))).toBe('2024-02-29');
    expect(toYmdString(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('uses the local calendar day for a Date shifted by N hours', () => {
    // Stale-state guard: time-of-day must not leak the day within the same local day.
    expect(toYmdString(new Date(2026, 9, 3, 0, 0, 0))).toBe('2026-10-03');
    expect(toYmdString(new Date(2026, 9, 3, 5, 45, 30))).toBe('2026-10-03');
    expect(toYmdString(new Date(2026, 9, 3, 23, 59, 59))).toBe('2026-10-03');
    // Crossing local midnight rolls the day.
    expect(toYmdString(new Date(2026, 9, 3, 25))).toBe('2026-10-04');
  });

  it('passes a plain YYYY-MM-DD string through unchanged (no parse → local-getter shift)', () => {
    // A plain calendar day MUST NOT be re-parsed: `new Date('2026-09-29')` is UTC
    // midnight, which slides to 2026-09-28 under a negative UTC offset (America/New_York).
    expect(toYmdString('2026-09-29')).toBe('2026-09-29');
    expect(toYmdString('2026-10-03')).toBe('2026-10-03');
  });

  it('round-trips a local-midnight Date through toISOString() (warm-cache round-trip)', () => {
    // The exact shape the cache persisted: pg DATE → local midnight → JSON.stringify
    // (= toISOString). Local-midnight ISO decodes back to the same calendar day in
    // EVERY timezone — this is what the write-side normalisation replaces.
    const cases: ReadonlyArray<readonly [number, number, number]> = [
      [2026, 8, 29],
      [2026, 9, 3],
      [2026, 0, 1],
      [2024, 1, 29],
    ];
    for (const [y, m, d] of cases) {
      const expected = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      expect(toYmdString(new Date(y, m, d).toISOString())).toBe(expected);
    }
  });

  it('reads a full ISO instant with LOCAL getters', () => {
    // Expected = the instant's local calendar day, so the assertion is timezone-
    // invariant (holds under Asia/Shanghai +08 AND America/New_York -04/-05).
    const toLocal = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    for (const iso of ['2026-09-29T00:00:00.000Z', '2026-10-03T23:59:59+08:00']) {
      expect(toYmdString(iso)).toBe(toLocal(iso));
    }
  });

  it('returns null for empty / missing / invalid values', () => {
    expect(toYmdString(null)).toBeNull();
    expect(toYmdString(undefined)).toBeNull();
    expect(toYmdString('')).toBeNull();
    expect(toYmdString(new Date('nope'))).toBeNull();
    expect(toYmdString('2026-09-29T25:99:99Z')).toBeNull();
  });

  it('shape-normalises but does not validate malformed strings', () => {
    // Regex only checks the YYYY-MM-DD shape; DB/FK constraints stay the validity gate.
    expect(toYmdString('20261003')).toBeNull();
    expect(toYmdString('2026-13-45')).toBe('2026-13-45');
    expect(toYmdString('not-a-date')).toBeNull();
  });
});
