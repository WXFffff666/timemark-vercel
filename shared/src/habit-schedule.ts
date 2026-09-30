/**
 * 习惯打卡（D6，checkbox 64/65）—— 纯函数：周期键、连胜计算、计划星期判定、
 * 提醒去重键。backend（提醒任务 / habit.service）与 frontend（习惯页）共用，
 * 因此这里绝不 import 任何后端模块，也绝不读系统时区（一律显式 IANA 时区）。
 *
 * 术语：
 * - period=day：一个周期 = 用户时区里的一个日历日
 * - period=week：一个周期 = ISO 周（周一锚定；ISO 8601 的周边界）
 * - 达标（met）：周期内 habit_logs.count 之和 >= target_per_period
 * - 连胜（streak）= 连续的达标周期数。当前周期尚未达标时，它「还没结束」，
 *   连胜先不中断（显示为进行中）；上一个完整周期未达标才归零——这正是
 *   「连胜告急」提醒存在的前提。
 *
 * schedule_days 约定与 JS Date.getUTCDay() 一致：0=周日 … 6=周六；
 * [1,3,5] = 周一/三/五。null / 空数组 = 每天都算计划日。
 */
import { formatYmd, parseYmd } from './event-schedule.js';

export const HABIT_PERIODS = ['day', 'week'] as const;
export type HabitPeriod = (typeof HABIT_PERIODS)[number];

/** 提醒去重键前缀（与事件/到期/证件的键空间隔离，共用 reminder_send_claims） */
export const HABIT_REMINDER_SEND_KEY_PREFIX = 'habit';
/** 连胜告急去重键前缀：`habit:risk#h<id>#d<YYYY-MM-DD>` */
export const HABIT_RISK_SEND_KEY_PREFIX = 'habit:risk';

/** 「连胜告急」默认小时（用户时区；可被 user_configs.habit_streak_nudge_hour 覆盖） */
export const DEFAULT_HABIT_STREAK_NUDGE_HOUR = '20:00';

/** 单次连胜扫描的周期数上限（约 20 年日周期 / 380 年周周期），防脏数据死循环 */
const MAX_PERIOD_SCAN = 7400;

/** 归一化 schedule_days：只保留 0..6 的整数并去重排序；空/非法 → null（= 每天） */
export function normalizeScheduleDays(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const days = [
    ...new Set(
      raw
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
    ),
  ].sort((a, b) => a - b);
  return days.length > 0 ? days : null;
}

/** 归一化 reminder_times：只保留合法的 HH:mm；非法项直接丢弃 */
export function normalizeReminderTimes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((value) => String(value).trim())
        .filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)),
    ),
  ];
}

/** ymd 这天是否在计划星期内；schedule_days 为空 = 每天 */
export function isHabitScheduledOn(
  ymd: string,
  scheduleDays: readonly number[] | null | undefined,
): boolean {
  const normalized = normalizeScheduleDays(scheduleDays ?? null);
  if (!normalized) return true;
  const parts = parseYmd(ymd);
  if (!parts) return false;
  const dow = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
  return normalized.includes(dow);
}

/** ymd 所在 ISO 周的周一（YYYY-MM-DD）；非法输入返回 null */
export function isoWeekStartYmd(ymd: string): string | null {
  const parts = parseYmd(ymd);
  if (!parts) return null;
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  const isoDow = (date.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  date.setUTCDate(date.getUTCDate() - isoDow);
  return formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** 周期键：day → `D:YYYY-MM-DD`；week → `W:<周一 YYYY-MM-DD>`；非法输入 null */
export function habitPeriodKey(ymd: string, period: HabitPeriod): string | null {
  const parts = parseYmd(ymd);
  if (!parts) return null;
  if (period === 'week') {
    const monday = isoWeekStartYmd(ymd);
    return monday ? `W:${monday}` : null;
  }
  return `D:${formatYmd(parts.y, parts.m, parts.d)}`;
}

/** 指定日期的前后 N 天（UTC 日历日运算，DST 安全） */
export function shiftCalendarDays(ymd: string, days: number): string | null {
  const parts = parseYmd(ymd);
  if (!parts) return null;
  const t = Date.UTC(parts.y, parts.m - 1, parts.d) + Math.trunc(days) * 86400000;
  const d = new Date(t);
  return formatYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 按时区把时刻换算成 YYYY-MM-DD（与 tasks.ts 的 getTodayString 同构） */
export function dateStringInTimeZone(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    // Task 171: an already-stored invalid IANA name must never crash a render
    // or a send - degrade to Asia/Shanghai with a logged warning.
    console.warn(`[time] invalid IANA timezone "${timeZone}"; falling back to Asia/Shanghai`);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  }
}

/** 单次习惯提醒去重键：`habit#h<id>#d<YYYY-MM-DD>#t<HH:mm>` */
export function buildHabitReminderSendKey(habitId: number, ymd: string, time: string): string {
  return `${HABIT_REMINDER_SEND_KEY_PREFIX}#h${habitId}#d${ymd}#t${time}`;
}

/** 连胜告急去重键：`habit:risk#h<id>#d<YYYY-MM-DD>`（每天至多一条） */
export function buildHabitRiskSendKey(habitId: number, ymd: string): string {
  return `${HABIT_RISK_SEND_KEY_PREFIX}#h${habitId}#d${ymd}`;
}

export interface HabitLogLike {
  /** habit_logs.logged_on（YYYY-MM-DD） */
  loggedOn: string;
  count: number;
}

export interface HabitStreakInput {
  period: HabitPeriod;
  /** 每周期目标次数；缺省/非法按 1 处理（>=1） */
  targetPerPeriod?: number;
  logs: readonly HabitLogLike[];
  now: Date;
  /** IANA 时区；缺省 Asia/Shanghai（用户时区优先，与服务器时区无关） */
  timeZone?: string;
  /** 计划星期（0=周日..6=周六）；空/缺省 = 每天。weekly 周期忽略该字段 */
  scheduleDays?: readonly number[] | null;
}

export interface HabitStreakResult {
  /** 进行中的连胜（当前周期未达标时按「上一个完整周期」计；上周期也未达标 → 0） */
  currentStreak: number;
  /** 历史最长连胜（只统计已达标的周期，不受当前周期是否达标影响） */
  longestStreak: number;
  /** 当前周期（day=今天；week=本周）的累计次数 */
  todayCount: number;
  /** 当前周期是否已达标（≥ targetPerPeriod） */
  targetMet: boolean;
  /** 用户时区里的今天（YYYY-MM-DD） */
  todayYmd: string;
  /** 当前周期键（D:YYYY-MM-DD / W:<周一>） */
  currentPeriodKey: string;
}

interface PeriodBucket {
  key: string;
  count: number;
}

/**
 * 连胜计算（纯函数）。
 *
 * - 从「今天」所在的周期向后回溯；day 周期只评估计划星期内的日子（未排期
 *   的日子不打断连胜——它们本来就不要求打卡）。
 * - 当前周期尚未达标 → 先跳过（周期还没结束），上周期也未达标 → 0。
 * - longestStreak 从最早的日志周期正向扫到当前周期。
 * - 所有日期运算基于 YMD 字符串 + UTC，绝不使用本地时区方法 → 同一 now+时区
 *   在任意服务器 TZ 下结果一致；跨月、跨年、DST 边界都由日历日算术保证。
 */
export function computeHabitStreak(input: HabitStreakInput): HabitStreakResult {
  const period: HabitPeriod = input.period === 'week' ? 'week' : 'day';
  const rawTarget = Number(input.targetPerPeriod);
  const target = Number.isFinite(rawTarget) ? Math.max(1, Math.trunc(rawTarget)) : 1;
  const timeZone = input.timeZone && input.timeZone.trim() ? input.timeZone.trim() : 'Asia/Shanghai';
  const todayYmd = dateStringInTimeZone(input.now, timeZone);
  const currentPeriodKey = habitPeriodKey(todayYmd, period) ?? `D:${todayYmd}`;

  // 汇总每个周期的次数
  const buckets = new Map<string, PeriodBucket>();
  let earliestAnchor: string | null = null;
  for (const log of input.logs ?? []) {
    const ymd = typeof log?.loggedOn === 'string' ? log.loggedOn.slice(0, 10) : '';
    if (!parseYmd(ymd)) continue;
    const key = habitPeriodKey(ymd, period);
    if (!key) continue;
    const rawCount = Number(log.count);
    const count = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 0;
    const bucket = buckets.get(key) ?? { key, count: 0 };
    bucket.count += count;
    buckets.set(key, bucket);
    if (earliestAnchor === null || ymd < earliestAnchor) earliestAnchor = ymd;
  }

  const met = (key: string): boolean => (buckets.get(key)?.count ?? 0) >= target;

  /** day 周期的「上一个评估日」（跳过未排期日）；week 周期 = 上一个周一 */
  function stepBack(anchor: string): string | null {
    if (period === 'week') return shiftCalendarDays(anchor, -7);
    let cursor = shiftCalendarDays(anchor, -1);
    let guard = 0;
    while (cursor && !isHabitScheduledOn(cursor, input.scheduleDays) && guard < MAX_PERIOD_SCAN) {
      cursor = shiftCalendarDays(cursor, -1);
      guard += 1;
    }
    return cursor;
  }

  function stepForward(anchor: string): string | null {
    if (period === 'week') return shiftCalendarDays(anchor, 7);
    let cursor = shiftCalendarDays(anchor, 1);
    let guard = 0;
    while (cursor && !isHabitScheduledOn(cursor, input.scheduleDays) && guard < MAX_PERIOD_SCAN) {
      cursor = shiftCalendarDays(cursor, 1);
      guard += 1;
    }
    return cursor;
  }

  /** 当前周期锚点：day=今天；week=本周一 */
  const currentAnchor = period === 'week' ? isoWeekStartYmd(todayYmd) : todayYmd;
  if (!currentAnchor) {
    return {
      currentStreak: 0,
      longestStreak: 0,
      todayCount: 0,
      targetMet: false,
      todayYmd,
      currentPeriodKey,
    };
  }

  // ---- currentStreak：从当前周期向后回溯 ----
  let currentStreak = 0;
  let anchor: string | null = currentAnchor;
  let first = true;
  let guard = 0;
  while (anchor && guard < MAX_PERIOD_SCAN) {
    guard += 1;
    // day 周期：未排期的日子直接跳过（不算断，也不计）
    if (period === 'day' && !isHabitScheduledOn(anchor, input.scheduleDays)) {
      anchor = stepBack(anchor);
      continue;
    }
    if (met(habitPeriodKey(anchor, period) ?? '')) {
      currentStreak += 1;
    } else if (!first) {
      // 上一个完整周期未达标 → 连胜结束
      break;
    }
    // first 且未达标：当前周期还没结束，先跳过它继续看上一个完整周期
    first = false;
    anchor = stepBack(anchor);
  }

  // ---- longestStreak：从最早日志周期正向扫描 ----
  const earliestRelevant = earliestAnchor ?? currentAnchor;
  let longestStreak = 0;
  let run = 0;
  let forward: string | null = period === 'week' ? isoWeekStartYmd(earliestRelevant) : earliestRelevant;
  let forwardGuard = 0;
  while (forward && forwardGuard < MAX_PERIOD_SCAN) {
    if (forward > currentAnchor) break;
    forwardGuard += 1;
    if (period === 'day' && !isHabitScheduledOn(forward, input.scheduleDays)) {
      forward = stepForward(forward);
      continue;
    }
    if (met(habitPeriodKey(forward, period) ?? '')) {
      run += 1;
      if (run > longestStreak) longestStreak = run;
    } else {
      run = 0;
    }
    if (forward === currentAnchor) break;
    forward = stepForward(forward);
  }

  const todayCount = buckets.get(currentPeriodKey)?.count ?? 0;
  return {
    currentStreak,
    longestStreak,
    todayCount,
    targetMet: todayCount >= target,
    todayYmd,
    currentPeriodKey,
  };
}
