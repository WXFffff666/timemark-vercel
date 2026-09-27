import { describe, expect, it } from 'vitest';
import {
  buildHabitReminderSendKey,
  buildHabitRiskSendKey,
  computeHabitStreak,
  DEFAULT_HABIT_STREAK_NUDGE_HOUR,
  habitPeriodKey,
  isHabitScheduledOn,
  isoWeekStartYmd,
  normalizeReminderTimes,
  normalizeScheduleDays,
} from './habit-schedule.js';

/**
 * checkbox 64 的验收用例（共享纯函数）：
 * - 跨月的每日连胜；
 * - 缺卡一天归零；
 * - weekly + target=3：ISO 周内累计 3 次才算达标；
 * - 时区/DST：一律按显式 IANA 时区（Asia/Shanghai 缺省），与服务器 TZ 无关。
 * 所有断言都直接命中行为：若「缺卡不重置」「周目标按天算」「用服务器时区」
 * 任何一项被错写，对应测试立即失败。
 */

const SHANGHAI = 'Asia/Shanghai';

/** now = 上海时间某日 12:00（04:00Z） */
function shanghaiNoon(ymd: string): Date {
  return new Date(`${ymd}T04:00:00Z`);
}

describe('habit streak — daily periods', () => {
  it('counts a daily streak across a month boundary', () => {
    const logs = ['2026-01-29', '2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02', '2026-02-03'].map(
      (loggedOn) => ({ loggedOn, count: 1 }),
    );
    const result = computeHabitStreak({
      period: 'day',
      targetPerPeriod: 1,
      logs,
      now: shanghaiNoon('2026-02-03'),
      timeZone: SHANGHAI,
    });
    expect(result.todayYmd).toBe('2026-02-03');
    expect(result.currentStreak).toBe(6);
    expect(result.longestStreak).toBe(6);
    expect(result.targetMet).toBe(true);
  });

  it('resets to 0 when a full day is missed (and keeps the historic longest)', () => {
    const logs = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05'].map((loggedOn) => ({
      loggedOn,
      count: 1,
    }));
    const result = computeHabitStreak({
      period: 'day',
      targetPerPeriod: 1,
      logs,
      // 2026-02-06 缺卡；在 02-07 看结果：昨天(02-06)也未达标 → 连胜归零
      now: shanghaiNoon('2026-02-07'),
      timeZone: SHANGHAI,
    });
    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(5);
    expect(result.todayCount).toBe(0);
  });

  it('keeps the streak alive during the still-open current period', () => {
    const logs = ['2026-02-01', '2026-02-02'].map((loggedOn) => ({ loggedOn, count: 1 }));
    // 02-03 当天还没打卡：当前周期未结束，连胜按 02-02 为止计
    const result = computeHabitStreak({
      period: 'day',
      targetPerPeriod: 1,
      logs,
      now: shanghaiNoon('2026-02-03'),
      timeZone: SHANGHAI,
    });
    expect(result.currentStreak).toBe(2);
    expect(result.targetMet).toBe(false);
  });

  it('supports target > 1 per day via summed counts', () => {
    const logs = [
      { loggedOn: '2026-02-01', count: 2 },
      { loggedOn: '2026-02-02', count: 1 },
      { loggedOn: '2026-02-02', count: 1 },
      { loggedOn: '2026-02-03', count: 1 },
    ];
    const result = computeHabitStreak({
      period: 'day',
      targetPerPeriod: 2,
      logs,
      now: shanghaiNoon('2026-02-03'),
      timeZone: SHANGHAI,
    });
    expect(result.currentStreak).toBe(2); // 02-01 与 02-02 达标（各 2 次）；02-03 只有 1 次
    expect(result.longestStreak).toBe(2);
    // 若把 target 当 1：三天的 ≥1 次全都算达标 → streak 会是 3，而不是 2
  });

  it('ignores unscheduled weekdays for streak continuity (schedule [1,3,5])', () => {
    // 周一/三/五计划：周三 → 周一 → 上周五 都是计划日；周末不该打断连胜
    const logs = ['2026-06-05', '2026-06-08', '2026-06-10'].map((loggedOn) => ({ loggedOn, count: 1 }));
    const result = computeHabitStreak({
      period: 'day',
      targetPerPeriod: 1,
      logs,
      now: shanghaiNoon('2026-06-10'),
      timeZone: SHANGHAI,
      scheduleDays: [1, 3, 5],
    });
    expect(result.currentStreak).toBe(3);
    expect(result.longestStreak).toBe(3);
  });
});

describe('habit streak — weekly periods (target_per_period = 3)', () => {
  it('only reaches a streak after 3 logs in the ISO week', () => {
    const twoLogs = ['2026-06-01', '2026-06-03'].map((loggedOn) => ({ loggedOn, count: 1 }));
    const before = computeHabitStreak({
      period: 'week',
      targetPerPeriod: 3,
      logs: twoLogs,
      now: shanghaiNoon('2026-06-05'),
      timeZone: SHANGHAI,
    });
    expect(before.currentStreak).toBe(0);
    expect(before.targetMet).toBe(false);

    const withThird = [...twoLogs, { loggedOn: '2026-06-05', count: 1 }];
    const after = computeHabitStreak({
      period: 'week',
      targetPerPeriod: 3,
      logs: withThird,
      now: shanghaiNoon('2026-06-05'),
      timeZone: SHANGHAI,
    });
    expect(after.currentStreak).toBe(1);
    expect(after.targetMet).toBe(true);
  });

  it('chains across weeks: previous week met + current week met = 2', () => {
    const logs = [
      '2026-05-25',
      '2026-05-27',
      '2026-05-29', // ISO 周 W:2026-05-25 达标
      '2026-06-01',
      '2026-06-03', // 本周 2 次，未完
    ].map((loggedOn) => ({ loggedOn, count: 1 }));

    const midWeek = computeHabitStreak({
      period: 'week',
      targetPerPeriod: 3,
      logs,
      now: shanghaiNoon('2026-06-05'),
      timeZone: SHANGHAI,
    });
    expect(midWeek.currentStreak).toBe(1); // 当前周未达标，先数上一周

    const completed = computeHabitStreak({
      period: 'week',
      targetPerPeriod: 3,
      logs: [...logs, { loggedOn: '2026-06-05', count: 1 }],
      now: shanghaiNoon('2026-06-05'),
      timeZone: SHANGHAI,
    });
    expect(completed.currentStreak).toBe(2);
    expect(completed.longestStreak).toBe(2);
  });

  it('resets when a whole ISO week is missed', () => {
    const logs = [
      '2026-05-11',
      '2026-05-12',
      '2026-05-13', // W:2026-05-11 达标
      // W:2026-05-18 整周缺卡
      '2026-05-25',
      '2026-05-26',
      '2026-05-27', // W:2026-05-25 达标
    ].map((loggedOn) => ({ loggedOn, count: 1 }));
    const result = computeHabitStreak({
      period: 'week',
      targetPerPeriod: 3,
      logs,
      now: shanghaiNoon('2026-05-29'),
      timeZone: SHANGHAI,
    });
    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
  });

  it('maps ISO weeks with the standard Monday anchor', () => {
    expect(isoWeekStartYmd('2026-06-01')).toBe('2026-06-01'); // 周一
    expect(isoWeekStartYmd('2026-06-07')).toBe('2026-06-01'); // 周日
    expect(isoWeekStartYmd('2026-01-01')).toBe('2025-12-29'); // 周四属于上一年最后一周
    expect(habitPeriodKey('2026-06-03', 'week')).toBe('W:2026-06-01');
    expect(habitPeriodKey('2026-06-03', 'day')).toBe('D:2026-06-03');
  });
});

describe('habit streak — timezone independence and DST', () => {
  it('uses the user IANA timezone, not UTC (2026-01-02 in Shanghai vs 01-01 in UTC)', () => {
    const logs = [
      { loggedOn: '2026-01-01', count: 1 },
      { loggedOn: '2026-01-02', count: 1 },
    ];
    // 这一刻：UTC 还是 01-01，上海已是 01-02
    const now = new Date('2026-01-01T20:00:00Z');

    const shanghai = computeHabitStreak({ period: 'day', targetPerPeriod: 1, logs, now, timeZone: SHANGHAI });
    expect(shanghai.todayYmd).toBe('2026-01-02');
    expect(shanghai.currentStreak).toBe(2);

    // 同一个瞬间按 UTC 解释应只看到 01-01 的 1 连（证明 today 来自显式时区参数）
    const utc = computeHabitStreak({ period: 'day', targetPerPeriod: 1, logs, now, timeZone: 'UTC' });
    expect(utc.todayYmd).toBe('2026-01-01');
    expect(utc.currentStreak).toBe(1);
  });

  it('gives the same result regardless of the server process TZ', () => {
    const logs = [
      { loggedOn: '2026-01-01', count: 1 },
      { loggedOn: '2026-01-02', count: 1 },
    ];
    const now = new Date('2026-01-01T20:00:00Z');
    const originalTz = process.env.TZ;
    try {
      const results: number[] = [];
      for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
        process.env.TZ = tz;
        results.push(
          computeHabitStreak({ period: 'day', targetPerPeriod: 1, logs, now, timeZone: SHANGHAI }).currentStreak,
        );
      }
      expect(results).toEqual([2, 2, 2]);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('keeps calendar-day continuity across a DST spring-forward boundary', () => {
    // 2026-03-08 美国东部进入夏令时（当地只有 23 小时）；连胜按日历日推进
    const logs = ['2026-03-07', '2026-03-08', '2026-03-09'].map((loggedOn) => ({ loggedOn, count: 1 }));
    const result = computeHabitStreak({
      period: 'day',
      targetPerPeriod: 1,
      logs,
      // 2026-03-09T08:00Z = 04:00 EDT
      now: new Date('2026-03-09T08:00:00Z'),
      timeZone: 'America/New_York',
    });
    expect(result.todayYmd).toBe('2026-03-09');
    expect(result.currentStreak).toBe(3);
  });
});

describe('habit scheduling helpers', () => {
  it('treats null/empty schedule_days as every day', () => {
    expect(isHabitScheduledOn('2026-06-02', null)).toBe(true); // 周二
    expect(isHabitScheduledOn('2026-06-02', [])).toBe(true);
  });

  it('filters out-of-range schedule days and dedupes', () => {
    expect(normalizeScheduleDays([1, 3, 5])).toEqual([1, 3, 5]);
    expect(normalizeScheduleDays([9, -1, 2, 2, 3.5])).toEqual([2]);
    expect(normalizeScheduleDays('nope')).toBeNull();
    expect(normalizeScheduleDays([7])).toBeNull();
  });

  it('matches only the configured weekdays (0=Sunday .. 6=Saturday)', () => {
    // 2026-06-01 周一 .. 2026-06-07 周日
    const week = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07'];
    const scheduled = week.filter((ymd) => isHabitScheduledOn(ymd, [1, 3, 5]));
    expect(scheduled).toEqual(['2026-06-01', '2026-06-03', '2026-06-05']);
  });

  it('normalizes reminder times and keeps the default nudge hour', () => {
    expect(normalizeReminderTimes(['08:00', '08:00', '25:00', '7:30', '20:00'])).toEqual(['08:00', '20:00']);
    expect(normalizeReminderTimes(null)).toEqual([]);
    expect(DEFAULT_HABIT_STREAK_NUDGE_HOUR).toBe('20:00');
  });

  it('builds distinct, stable claim keys for reminders and the risk nudge', () => {
    expect(buildHabitReminderSendKey(3, '2026-06-01', '08:00')).toBe('habit#h3#d2026-06-01#t08:00');
    expect(buildHabitRiskSendKey(3, '2026-06-01')).toBe('habit:risk#h3#d2026-06-01');
    expect(buildHabitReminderSendKey(3, '2026-06-01', '08:00')).not.toBe(
      buildHabitReminderSendKey(3, '2026-06-01', '20:00'),
    );
    expect(buildHabitRiskSendKey(3, '2026-06-01')).not.toBe(buildHabitRiskSendKey(3, '2026-06-02'));
  });
});
