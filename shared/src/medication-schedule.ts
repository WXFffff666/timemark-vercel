/**
 * 家庭用药提醒（D3，checkbox 72/73）—— 纯函数：时刻归一、计划日判定、库存可维持
 * 天数预估、提醒窗口与去重键。backend（提醒任务 / medication.service）与
 * frontend（用药页，checkbox 75）共用，因此这里绝不 import 后端模块。
 *
 * 用药用自己的 `schedule_times`（HH:mm 列表）表达计划时刻，绝不套用事件的
 * ±2 分钟 `reminder_time` 模型。`schedule_days` 与习惯同一约定：0=周日 … 6=周六，
 * 空/null = 每天。
 */
import { normalizeScheduleDays, isHabitScheduledOn } from './habit-schedule.js';

/** 计划时刻匹配窗口（分钟）：与事件/习惯提醒一致 */
export const MEDICATION_REMINDER_WINDOW_MINUTES = 2;
/** 稍后提醒间隔（分钟） */
export const MEDICATION_SNOOZE_MINUTES = 10;
/** 计划时刻后仍未记录触发的升级提醒（分钟） */
export const MEDICATION_ESCALATION_MINUTES = 30;
/** 「库存不足」的剩余可维持天数阈值 */
export const MEDICATION_REFILL_DAYS = 7;

/** 剂量提醒去重键前缀：`med:dose#<doseId>` */
export const MEDICATION_DOSE_KEY_PREFIX = 'med:dose';
/** 升级提醒去重键前缀：`med:esc#<doseId>` */
export const MEDICATION_ESCALATION_KEY_PREFIX = 'med:esc';
/** 稍后提醒去重键前缀：`med:snooze#<doseId>` */
export const MEDICATION_SNOOZE_KEY_PREFIX = 'med:snooze';

/** 归一化 schedule_times：只保留合法 HH:mm，去重并升序；无非法项时原样语义 */
export function normalizeMedicationTimes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((value) => String(value).trim())
        .filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)),
    ),
  ].sort();
}

/** ymd 这天是否在用药计划内（schedule_days 空 = 每天） */
export function isMedicationScheduledOn(
  ymd: string,
  scheduleDays: readonly number[] | null | undefined,
): boolean {
  return isHabitScheduledOn(ymd, normalizeScheduleDays(scheduleDays ?? null));
}

/**
 * 平均每天的计划剂量次数（PRN = 0）。
 * schedule_days 给定非空时按 天数/7 折算（如每周 3 次 → times * 3/7）。
 */
export function averageDosesPerDay(
  scheduleTimes: readonly string[] | null | undefined,
  scheduleDays: readonly number[] | null | undefined,
): number {
  const times = normalizeMedicationTimes(scheduleTimes ?? null).length;
  if (times === 0) return 0;
  const days = normalizeScheduleDays(scheduleDays ?? null);
  if (!days) return times;
  return (times * days.length) / 7;
}

/**
 * 库存可维持天数 = 库存 / (每次用量 × 平均每天次数)。
 * 无库存或没有计划次数（PRN）时返回 null（无法推算，只看阈值）。
 */
export function computeDaysOfSupply(
  stockQuantity: number | null | undefined,
  unitsPerDose: number | null | undefined,
  scheduleTimes: readonly string[] | null | undefined,
  scheduleDays: readonly number[] | null | undefined,
): number | null {
  const stock = Number(stockQuantity);
  const perDose = Number(unitsPerDose);
  if (stockQuantity == null || !Number.isFinite(stock) || stock < 0) return null;
  if (unitsPerDose == null || !Number.isFinite(perDose) || perDose <= 0) return null;
  const perDay = averageDosesPerDay(scheduleTimes, scheduleDays);
  if (perDay <= 0) return null;
  return stock / (perDose * perDay);
}

/** now 是否落在 target 的 ±windowMinutes 窗口内 */
export function isWithinMinutes(
  now: Date,
  target: Date,
  windowMinutes = MEDICATION_REMINDER_WINDOW_MINUTES,
): boolean {
  const diff = Math.abs(now.getTime() - target.getTime());
  return diff <= Math.max(0, windowMinutes) * 60_000;
}

/** 单剂量计划提醒去重键：`med:dose#<doseId>#<ISO>`（同一剂量同一计划时刻至多一条） */
export function buildDoseReminderKey(doseId: number, scheduledForIso: string): string {
  return `${MEDICATION_DOSE_KEY_PREFIX}#${doseId}#${scheduledForIso}`;
}

/** 升级提醒去重键：`med:esc#<doseId>#<ISO>`（同一剂量至多一条） */
export function buildDoseEscalationKey(doseId: number, scheduledForIso: string): string {
  return `${MEDICATION_ESCALATION_KEY_PREFIX}#${doseId}#${scheduledForIso}`;
}

/** 稍后提醒去重键：`med:snooze#<doseId>#<snoozeAtISO>`（每次稍后各一条） */
export function buildDoseSnoozeKey(doseId: number, snoozeAtIso: string): string {
  return `${MEDICATION_SNOOZE_KEY_PREFIX}#${doseId}#${snoozeAtIso}`;
}
