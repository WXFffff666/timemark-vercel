/**
 * 习惯打卡（D6，checkbox 64/65）—— Zod 校验与行类型。
 *
 * 习惯是独立概念，不复用 todo_completions（v29）：todo 是「事件的当天打勾」，
 * 这里是「按日/周目标计数的行为追踪」。
 */
import { z } from 'zod';
import { HABIT_PERIODS, type HabitPeriod } from '../habit-schedule.js';

/** 单条提醒时刻 HH:mm */
export const habitTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '提醒时刻必须为 HH:mm');

/** 计划星期：0=周日 … 6=周六（与 JS getUTCDay 一致） */
export const habitScheduleDaySchema = z
  .number()
  .int('计划星期必须为整数')
  .min(0, '计划星期必须在 0..6')
  .max(6, '计划星期必须在 0..6');

export const createHabitSchema = z.object({
  name: z.string().min(1, '习惯名称不能为空').max(100),
  /** emoji / 短图标 */
  icon: z.string().max(16).nullish(),
  /** 每周期目标次数（天/周） */
  targetPerPeriod: z.number().int('目标次数必须为整数').min(1, '目标次数至少为 1').max(1000).optional(),
  period: z.enum(HABIT_PERIODS).optional(),
  /** 计划星期；null/空 = 每天 */
  scheduleDays: z.array(habitScheduleDaySchema).max(7).nullish(),
  /** 提醒时刻列表；null/空 = 不发定时提醒 */
  reminderTimes: z.array(habitTimeSchema).max(12).nullish(),
  color: z.string().max(32).nullish(),
  /** 家庭档案（v41+）；当前仅存储 */
  profileId: z.number().int().positive().nullish(),
  isActive: z.boolean().optional(),
});
export type CreateHabitInput = z.infer<typeof createHabitSchema>;

export const updateHabitSchema = createHabitSchema.partial();
export type UpdateHabitInput = z.infer<typeof updateHabitSchema>;

/** POST /api/habits/:id/log —— 同日重复打卡是 UPSERT（count 累加），不是新行 */
export const logHabitSchema = z.object({
  /** YYYY-MM-DD；缺省 = 用户时区的今天。未来日期一律 400 */
  loggedOn: z.iso.date().optional(),
  /** 本次打卡次数（正整数）；缺省 1。累加到当天已有的 count 上 */
  count: z.number().int('打卡次数必须为整数').positive('打卡次数必须大于 0').max(1000).optional(),
  note: z.string().max(500).nullish(),
});
export type LogHabitInput = z.infer<typeof logHabitSchema>;

/** habits 行（schedule_days / reminder_times 是 PG 数组，node-postgres 返回 number[]/string[]） */
export interface HabitRow {
  id: number;
  user_id: number;
  profile_id: number | null;
  name: string;
  icon: string | null;
  target_per_period: number;
  period: HabitPeriod;
  schedule_days: number[] | null;
  reminder_times: string[] | null;
  color: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface HabitLogRow {
  id: number;
  habit_id: number;
  user_id: number;
  logged_on: string;
  count: number;
  note: string | null;
  created_at: string;
}

/** GET /api/habits、GET /api/habits/:id 附带的连胜信息 */
export interface HabitStreakInfo {
  current: number;
  longest: number;
  todayCount: number;
  targetMet: boolean;
  today: string;
  periodKey: string;
}

export interface HabitWithStreak extends HabitRow {
  streak: HabitStreakInfo;
}

export interface HabitGridDay {
  date: string;
  count: number;
  met: boolean;
}

export interface HabitGridHabit {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  targetPerPeriod: number;
  period: HabitPeriod;
  days: HabitGridDay[];
}

export interface HabitGridResult {
  from: string;
  to: string;
  habits: HabitGridHabit[];
}
