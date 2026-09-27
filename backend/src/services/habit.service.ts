import { query } from '../db/index.js';
import { diffCalendarDays } from '@timemark/shared/event-schedule';
import {
  computeHabitStreak,
  dateStringInTimeZone,
  normalizeReminderTimes,
  normalizeScheduleDays,
  shiftCalendarDays,
} from '@timemark/shared/habit-schedule';
import type {
  CreateHabitInput,
  HabitGridDay,
  HabitGridResult,
  HabitLogRow,
  HabitRow,
  HabitStreakInfo,
  HabitWithStreak,
  LogHabitInput,
  UpdateHabitInput,
} from '@timemark/shared';

/**
 * 习惯服务（D6，checkbox 64/65）。
 *
 * 约定与 expiry/document 服务相同：
 * - 所有读取按 user_id 限定；他人的行 = null，由路由映射 404。
 * - 连胜是纯函数（shared/src/habit-schedule.ts）的产物，服务只负责取数与组装；
 *   服务端时区不参与计算，一律用用户配置的 IANA 时区（缺省 Asia/Shanghai）。
 * - 同日打卡是 UPSERT（UNIQUE(habit_id, logged_on)，count 累加），绝不产生第二行。
 */

/** 网格端点单次最大跨度（天） */
export const MAX_HABIT_GRID_DAYS = 400;

type HabitRowRaw = Record<string, unknown>;

function parseDateText(value: unknown): string | null {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function mapHabit(row: HabitRowRaw): HabitRow {
  const rawSchedule = row.schedule_days;
  const rawTimes = row.reminder_times;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    profile_id: row.profile_id == null ? null : Number(row.profile_id),
    name: String(row.name ?? ''),
    icon: row.icon == null ? null : String(row.icon),
    target_per_period: Math.max(1, Math.trunc(Number(row.target_per_period) || 1)),
    period: row.period === 'week' ? 'week' : 'day',
    schedule_days: rawSchedule == null ? null : normalizeScheduleDays(rawSchedule),
    reminder_times: rawTimes == null ? null : normalizeReminderTimes(rawTimes),
    color: row.color == null ? null : String(row.color),
    is_active: row.is_active !== false,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

function mapLog(row: HabitRowRaw): HabitLogRow {
  return {
    id: Number(row.id),
    habit_id: Number(row.habit_id),
    user_id: Number(row.user_id),
    logged_on: parseDateText(row.logged_on) ?? '',
    count: Number(row.count ?? 0),
    note: row.note == null ? null : String(row.note),
    created_at: String(row.created_at ?? ''),
  };
}

async function getUserTimezone(userId: number): Promise<string> {
  const result = await query('SELECT timezone FROM user_configs WHERE user_id = $1', [userId]);
  const tz = result.rows[0]?.timezone;
  return typeof tz === 'string' && tz.trim() ? tz : 'Asia/Shanghai';
}

/** 读取日志（logged_on 直接以文本取出，避免 pg 的 DATE→本地 Date 时区漂移） */
async function loadLogs(userId: number, habitId?: number): Promise<HabitLogRow[]> {
  const result =
    habitId === undefined
      ? await query(
          `SELECT id, habit_id, user_id, logged_on::text AS logged_on, count, note, created_at
           FROM habit_logs WHERE user_id = $1 ORDER BY logged_on ASC, id ASC`,
          [userId],
        )
      : await query(
          `SELECT id, habit_id, user_id, logged_on::text AS logged_on, count, note, created_at
           FROM habit_logs WHERE user_id = $1 AND habit_id = $2 ORDER BY logged_on ASC, id ASC`,
          [userId, habitId],
        );
  return result.rows.map(mapLog);
}

function streakFor(habit: HabitRow, logs: HabitLogRow[], now: Date, timeZone: string): HabitStreakInfo {
  const result = computeHabitStreak({
    period: habit.period,
    targetPerPeriod: habit.target_per_period,
    logs: logs.map((log) => ({ loggedOn: log.logged_on, count: log.count })),
    now,
    timeZone,
    scheduleDays: habit.schedule_days,
  });
  return {
    current: result.currentStreak,
    longest: result.longestStreak,
    todayCount: result.todayCount,
    targetMet: result.targetMet,
    today: result.todayYmd,
    periodKey: result.currentPeriodKey,
  };
}

export async function listHabits(
  userId: number,
  opts: { active?: boolean; now?: Date; profileId?: number | null } = {},
): Promise<HabitWithStreak[]> {
  const activeClause = opts.active === undefined ? '' : opts.active ? ' AND is_active = TRUE' : ' AND is_active = FALSE';
  // 可选档案过滤（checkbox 69）：省略 = 全部档案。只加谓词，不改写原查询。
  const params: number[] = [userId];
  let profileClause = '';
  if (opts.profileId != null) {
    params.push(opts.profileId);
    profileClause = ' AND profile_id = $2';
  }
  const result = await query(
    `SELECT * FROM habits WHERE user_id = $1${activeClause}${profileClause} ORDER BY created_at ASC, id ASC`,
    params,
  );
  const habits = result.rows.map(mapHabit);
  if (habits.length === 0) return [];

  const logs = await loadLogs(userId);
  const byHabit = new Map<number, HabitLogRow[]>();
  for (const log of logs) {
    const list = byHabit.get(log.habit_id);
    if (list) list.push(log);
    else byHabit.set(log.habit_id, [log]);
  }

  const timeZone = await getUserTimezone(userId);
  const now = opts.now ?? new Date();
  return habits.map((habit) => ({
    ...habit,
    streak: streakFor(habit, byHabit.get(habit.id) ?? [], now, timeZone),
  }));
}

export async function getHabitWithStreak(
  userId: number,
  habitId: number,
  now: Date = new Date(),
): Promise<HabitWithStreak | null> {
  const result = await query('SELECT * FROM habits WHERE id = $1 AND user_id = $2', [habitId, userId]);
  if (!result.rows[0]) return null;
  const habit = mapHabit(result.rows[0]);
  const logs = await loadLogs(userId, habitId);
  const timeZone = await getUserTimezone(userId);
  return { ...habit, streak: streakFor(habit, logs, now, timeZone) };
}

export async function getHabitStreak(
  userId: number,
  habitId: number,
  now: Date = new Date(),
): Promise<HabitStreakInfo | null> {
  const result = await query('SELECT * FROM habits WHERE id = $1 AND user_id = $2', [habitId, userId]);
  if (!result.rows[0]) return null;
  const habit = mapHabit(result.rows[0]);
  const logs = await loadLogs(userId, habitId);
  const timeZone = await getUserTimezone(userId);
  return streakFor(habit, logs, now, timeZone);
}

export async function createHabit(userId: number, input: CreateHabitInput): Promise<HabitWithStreak> {
  const result = await query(
    `INSERT INTO habits
       (user_id, profile_id, name, icon, target_per_period, period, schedule_days, reminder_times, color, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, TRUE))
     RETURNING *`,
    [
      userId,
      input.profileId ?? null,
      input.name,
      input.icon ?? null,
      input.targetPerPeriod ?? 1,
      input.period ?? 'day',
      input.scheduleDays ? normalizeScheduleDays(input.scheduleDays) : null,
      input.reminderTimes ? normalizeReminderTimes(input.reminderTimes) : null,
      input.color ?? null,
      input.isActive ?? null,
    ],
  );
  const habit = mapHabit(result.rows[0]);
  const timeZone = await getUserTimezone(userId);
  return { ...habit, streak: streakFor(habit, [], new Date(), timeZone) };
}

export async function updateHabit(
  userId: number,
  habitId: number,
  input: UpdateHabitInput,
): Promise<HabitWithStreak | null> {
  const updates: string[] = ['updated_at = CURRENT_TIMESTAMP'];
  const values: unknown[] = [];
  let idx = 1;
  const set = (column: string, value: unknown): void => {
    updates.push(`${column} = $${idx++}`);
    values.push(value);
  };

  if (input.name !== undefined) set('name', input.name);
  if (input.icon !== undefined) set('icon', input.icon ?? null);
  if (input.targetPerPeriod !== undefined) set('target_per_period', input.targetPerPeriod);
  if (input.period !== undefined) set('period', input.period);
  if (input.scheduleDays !== undefined) {
    set('schedule_days', input.scheduleDays ? normalizeScheduleDays(input.scheduleDays) : null);
  }
  if (input.reminderTimes !== undefined) {
    set('reminder_times', input.reminderTimes ? normalizeReminderTimes(input.reminderTimes) : null);
  }
  if (input.color !== undefined) set('color', input.color ?? null);
  if (input.profileId !== undefined) set('profile_id', input.profileId ?? null);
  if (input.isActive !== undefined) set('is_active', input.isActive);

  if (updates.length === 1) return getHabitWithStreak(userId, habitId);

  values.push(habitId, userId);
  const result = await query(
    `UPDATE habits SET ${updates.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
    values,
  );
  if (!result.rows[0]) return null;
  const habit = mapHabit(result.rows[0]);
  const logs = await loadLogs(userId, habitId);
  const timeZone = await getUserTimezone(userId);
  return { ...habit, streak: streakFor(habit, logs, new Date(), timeZone) };
}

export async function deleteHabit(userId: number, habitId: number): Promise<boolean> {
  const result = await query('DELETE FROM habits WHERE id = $1 AND user_id = $2 RETURNING id', [
    habitId,
    userId,
  ]);
  return result.rows.length > 0;
}

export type LogHabitResult =
  | { status: 'ok'; log: HabitLogRow }
  | { status: 'not_found' }
  | { status: 'future_date'; today: string };

/**
 * UPSERT 打卡：同一天重复调用累加 count（`count = habit_logs.count + EXCLUDED.count`），
 * 唯一约束保证永远只有一行。未来日期（用户时区的今天之后）直接拒绝，不写入。
 */
export async function logHabit(
  userId: number,
  habitId: number,
  input: LogHabitInput,
): Promise<LogHabitResult> {
  const owned = await query('SELECT id FROM habits WHERE id = $1 AND user_id = $2', [habitId, userId]);
  if (!owned.rows[0]) return { status: 'not_found' };

  const timeZone = await getUserTimezone(userId);
  const today = dateStringInTimeZone(new Date(), timeZone);
  const loggedOn = input.loggedOn ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(loggedOn) || diffCalendarDays(today, loggedOn) > 0) {
    return { status: 'future_date', today };
  }

  const result = await query(
    `INSERT INTO habit_logs (habit_id, user_id, logged_on, count, note)
     VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (habit_id, logged_on)
     DO UPDATE SET count = habit_logs.count + EXCLUDED.count,
                   note = COALESCE(EXCLUDED.note, habit_logs.note)
     RETURNING id, habit_id, user_id, logged_on::text AS logged_on, count, note, created_at`,
    [habitId, userId, loggedOn, input.count ?? 1, input.note ?? null],
  );
  return { status: 'ok', log: mapLog(result.rows[0]) };
}

/** 365 天保留（与 todo_completions 的清理策略一致），由 daily-maintenance 调用 */
export async function purgeOldHabitLogs(retentionDays = 365): Promise<number> {
  const result = await query(
    `DELETE FROM habit_logs WHERE logged_on < CURRENT_DATE - ($1::int * INTERVAL '1 day')`,
    [retentionDays],
  );
  return result.rowCount ?? 0;
}

/** 日历网格：请求窗口内每个习惯的逐日次数（只返回窗口内，绝不回传全量历史） */
export async function getHabitGrid(
  userId: number,
  from: string,
  to: string,
  opts: { activeOnly?: boolean; profileId?: number | null } = {},
): Promise<HabitGridResult> {
  const span = diffCalendarDays(from, to);
  if (span < 0 || span >= MAX_HABIT_GRID_DAYS) {
    throw new RangeError(`习惯网格窗口必须在 1..${MAX_HABIT_GRID_DAYS} 天内`);
  }

  const activeClause = opts.activeOnly === false ? '' : ' AND is_active = TRUE';
  // 可选档案过滤（checkbox 69）：省略 = 全部档案。
  const params: number[] = [userId];
  let profileClause = '';
  if (opts.profileId != null) {
    params.push(opts.profileId);
    profileClause = ' AND profile_id = $2';
  }
  const habitsResult = await query(
    `SELECT * FROM habits WHERE user_id = $1${activeClause}${profileClause} ORDER BY created_at ASC, id ASC`,
    params,
  );
  const habits = habitsResult.rows.map(mapHabit);

  const logsResult = await query(
    `SELECT habit_id, logged_on::text AS logged_on, SUM(count)::int AS count
     FROM habit_logs
     WHERE user_id = $1 AND logged_on BETWEEN $2::date AND $3::date
     GROUP BY habit_id, logged_on`,
    [userId, from, to],
  );
  const counts = new Map<number, Map<string, number>>();
  for (const row of logsResult.rows as HabitRowRaw[]) {
    const habitId = Number(row.habit_id);
    const date = parseDateText(row.logged_on);
    if (!date) continue;
    const byDate = counts.get(habitId) ?? new Map<string, number>();
    byDate.set(date, Number(row.count ?? 0));
    counts.set(habitId, byDate);
  }

  const gridHabits = habits.map((habit) => {
    const byDate = counts.get(habit.id);
    const days: HabitGridDay[] = [];
    let cursor: string | null = from;
    while (cursor && diffCalendarDays(cursor, to) >= 0) {
      const count = byDate?.get(cursor) ?? 0;
      days.push({ date: cursor, count, met: count >= habit.target_per_period });
      cursor = shiftCalendarDays(cursor, 1);
    }
    return {
      id: habit.id,
      name: habit.name,
      icon: habit.icon,
      color: habit.color,
      targetPerPeriod: habit.target_per_period,
      period: habit.period,
      days,
    };
  });

  return { from, to, habits: gridHabits };
}
