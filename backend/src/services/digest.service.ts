import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { htmlToPlainText, EMAIL_CHANNEL_TYPES } from '@timemark/shared';
import { diffCalendarDays } from '@timemark/shared/event-schedule';
import { isHabitScheduledOn, normalizeScheduleDays } from '@timemark/shared/habit-schedule';
import { query } from '../db/index.js';
import { embedReportFont } from '../utils/pdf-font.js';
import { createLogger } from '../utils/logger.js';
import { getAdherence } from './medication.service.js';
import { getExpiryCosts } from './expiry.service.js';
import { createInboxMessage } from './inbox.service.js';
import { getNotificationAccounts, getUserConfig } from './config.service.js';
import { resolveEmailAccount, sendRawEmail } from './email-send.service.js';
import { resolveRecipientEmails } from './notifications/index.js';
import {
  DIGEST_SECTION_KEYS,
  normalizeDigestSections,
  sanitizeDigestRecipients,
  type DigestSectionKey,
} from './digest-sections.js';
import { isDigestNarrativeEnabled, summarizeDigestNarrative } from './ai/summarize.js';
import {
  getLocalDayKey,
  readNotificationBudgetConfig,
  tryConsumeDailyBudget,
} from './agent/notification-budget.service.js';

/**
 * 周期性图文摘要（checkbox 79）。
 *
 * - **确定性渲染**：不调用任何 LLM（叙事版是 checkbox 108）。所有数字都来自 SQL 聚合
 *   或既有 service（`getAdherence` / `getExpiryCosts`），正文由固定模板拼成。
 * - **零常驻算力 / 零额外网络**：只有被 cron 或 `POST /api/digest/send` 触发时才运行；
 *   唯一的网络调用是复用现有的邮件投递器。
 * - PDF 字节稳定：`PDFDocument.create({ updateMetadata: false })`，无 CreationDate/ModDate，
 *   内容只由 payload 决定（与 checkbox 74 的医生报告同一套做法）。
 * - 邮件头注入：主题由静态文本 + 期号构成，绝不拼接用户输入；收件人来自
 *   `resolveRecipientEmails`（只接受含 `@` 的地址）。
 */

const log = createLogger('digest');

/**
 * v2.30 方向 A：period 扩展到日/周粒度。
 * - daily  → 刚结束的那个 UTC 日（过去 24h）
 * - weekly → 过去 7 天（不含今天）
 * monthly/yearly 语义不变。
 */
export type DigestPeriod = 'monthly' | 'yearly' | 'daily' | 'weekly';

const PERIOD_LABEL: Record<DigestPeriod, string> = {
  monthly: '月度',
  yearly: '年度',
  daily: '每日',
  weekly: '每周',
};

/** 无 AI 叙述时逐字节复用的说明文案（task 79 原样）。 */
const DETERMINISTIC_NOTE = '本摘要由 TimeMark 确定性生成，不含 AI 叙述。';
/** 有 AI 叙述时的说明文案。 */
const AI_NOTE = '本摘要的统计为确定性生成；上方叙述段由 AI 依据这些统计数字撰写，数字已做一致性校验。';

/* ------------------------------------------------------------------ */
/* 数据结构                                                            */
/* ------------------------------------------------------------------ */

export interface DigestUpcomingRow { id: number; name: string; type: string; date: string }
export interface DigestOverdueRow { kind: string; title: string; due: string; daysOverdue: number }
export interface DigestHabitRow { name: string; logged: number; target: number; rate: number }
export interface DigestMedicationRow { name: string; taken: number; skipped: number; missed: number; total: number; percentage: number }
export interface DigestMaintenanceRow { assetName: string; due: string; overdue: boolean }
export interface DigestGoalRow { title: string; status: string; progress: number | null; milestonesDone: number; milestonesTotal: number }

/**
 * 日报（daily）补充快照：月/年摘要聚合不到的「过去 24h」计数。
 * 全部来自一次 SQL 多子查询；任一子查询失败整体降级为 0（不阻断摘要）。
 */
export interface DigestDailyStats {
  /** 昨日事件数（ occurrence 落在区间内的事件）。 */
  eventsCount: number;
  /** 完成待办/提醒数（todo_completions）。 */
  todosCompleted: number;
  /** 新增待办/事项数（区间内新建的事件）。 */
  todosAdded: number;
  /** 已服药次数（medication_doses.status='taken'）。 */
  dosesTaken: number;
  /** 错过/漏服次数（status='missed'）。 */
  dosesMissed: number;
  /** 今日到期（expiry_items + 保养 + 证件）。 */
  dueToday: number;
  /** 习惯打卡率（区间内有目标的习惯的平均完成率，0-100；无目标习惯为 null）。 */
  habitRate: number | null;
}

/** 周报（weekly）周对比行：本期 vs 上期。 */
export interface DigestComparisonRow { label: string; current: number; previous: number }

/** 周报周对比：只比较区间型聚合（时点型指标如「未来 30 天」不参与）。 */
export interface DigestComparison {
  from: string;
  to: string;
  rows: DigestComparisonRow[];
}

export interface DigestSpend {
  from: string;
  to: string;
  byCurrency: Record<string, number>;
  onceByCurrency: Record<string, number>;
  onceCount: number;
  byKind: Array<{ kind: string; currency: string; cents: number; count: number }>;
}

export interface DigestMedicationSummary {
  taken: number;
  skipped: number;
  missed: number;
  total: number;
  percentage: number;
  perMedication: DigestMedicationRow[];
}

export interface DigestData {
  userId: number;
  period: DigestPeriod;
  from: string;
  to: string;
  /** 计算「未来 30 天 / 逾期」所用的今天（YYYY-MM-DD）。 */
  today: string;
  upcoming: DigestUpcomingRow[];
  overdue: DigestOverdueRow[];
  spend: DigestSpend;
  habits: DigestHabitRow[];
  medications: DigestMedicationSummary;
  maintenance: DigestMaintenanceRow[];
  goals: DigestGoalRow[];
  /** 生效区块；缺省 = 全部（渲染时按此跳过被排除的区块）。 */
  sections?: DigestSectionKey[];
  /** 所有区块都为空 → 渲染「本期无记录」。 */
  isEmpty: boolean;
  /**
   * 可选的 AI 叙述段（checkbox 108）。缺省 = 无 AI 叙述，渲染结果与 task 79 逐字节一致。
   * 仅在 `AI_DIGEST_NARRATIVE=true` 且模型输出通过数字校验时才有值。
   */
  narrative?: string;
  /** 日报（daily）专属的过去 24h 快照；其余 period 不带此字段。 */
  daily?: DigestDailyStats;
  /** 周报（weekly）专属的上期对比；其余 period 不带此字段。 */
  comparison?: DigestComparison | null;
}

/* ------------------------------------------------------------------ */
/* 日期工具（全部 UTC，确定性强）                                       */
/* ------------------------------------------------------------------ */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toYmd(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + delta));
  return toYmd(shifted);
}

/**
 * 摘要覆盖区间：
 * - monthly → 刚结束的那个自然月（例如 2026-09-01 .. 2026-09-30）
 * - yearly  → 刚结束的那个自然年
 * - daily   → 刚结束的那个 UTC 日（过去 24h，from = to = 昨天）
 * - weekly  → 过去 7 天（今天 -7 .. 今天 -1）
 * 「未来 30 天 / 逾期」始终相对 `now` 当天。
 */
export function digestPeriodBounds(period: DigestPeriod, now: Date): { from: string; to: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = toYmd(now);
  if (period === 'yearly') {
    return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  }
  if (period === 'daily') {
    const yesterday = addDaysYmd(today, -1);
    return { from: yesterday, to: yesterday };
  }
  if (period === 'weekly') {
    return { from: addDaysYmd(today, -7), to: addDaysYmd(today, -1) };
  }
  return {
    from: toYmd(new Date(Date.UTC(year, month - 1, 1))),
    to: toYmd(new Date(Date.UTC(year, month, 0))),
  };
}

function countScheduledDays(from: string, to: string, scheduleDays: number[] | null): number {
  let count = 0;
  let cursor = from;
  for (let i = 0; i < 400 && cursor <= to; i++) {
    if (isHabitScheduledOn(cursor, scheduleDays)) count += 1;
    cursor = addDaysYmd(cursor, 1);
  }
  return count;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asYmd(value: unknown): string {
  if (value instanceof Date) return toYmd(value);
  return String(value ?? '').slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* 日报快照 + 周报对比（v2.30 方向 A）                                   */
/* ------------------------------------------------------------------ */

/**
 * 日报补充快照：一次 SQL 拿齐月/年摘要覆盖不到的「过去 24h」计数。
 * 任一子查询失败（旧库缺表等）→ 整体降级为 0，绝不阻断摘要发送。
 */
async function buildDailyStats(userId: number, from: string, to: string, today: string): Promise<DigestDailyStats> {
  try {
    const result = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM events
           WHERE user_id = $1 AND COALESCE(next_occurrence, date) BETWEEN $2::date AND $3::date) AS events_count,
         (SELECT COUNT(*)::int FROM todo_completions
           WHERE user_id = $1 AND occurrence_date BETWEEN $2::date AND $3::date) AS todos_completed,
         (SELECT COUNT(*)::int FROM events
           WHERE user_id = $1 AND created_at::date BETWEEN $2::date AND $3::date) AS todos_added,
         (SELECT COUNT(*)::int FROM medication_doses
           WHERE user_id = $1 AND status = 'taken' AND scheduled_for::date BETWEEN $2::date AND $3::date) AS doses_taken,
         (SELECT COUNT(*)::int FROM medication_doses
           WHERE user_id = $1 AND status = 'missed' AND scheduled_for::date BETWEEN $2::date AND $3::date) AS doses_missed,
         (SELECT COUNT(*)::int FROM expiry_items
           WHERE user_id = $1 AND is_active = TRUE AND next_due_date = $4::date)
         + (SELECT COUNT(*)::int FROM maintenance_plans
           WHERE user_id = $1 AND is_active = TRUE AND next_due_at::date = $4::date)
         + (SELECT COUNT(*)::int FROM documents
           WHERE user_id = $1 AND is_active = TRUE AND expires_at::date = $4::date) AS due_today`,
      [userId, from, to, today],
    );
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    return {
      eventsCount: asNumber(row.events_count),
      todosCompleted: asNumber(row.todos_completed),
      todosAdded: asNumber(row.todos_added),
      dosesTaken: asNumber(row.doses_taken),
      dosesMissed: asNumber(row.doses_missed),
      dueToday: asNumber(row.due_today),
      habitRate: null, // 由调用方依据 habits 聚合填充
    };
  } catch (error) {
    log.warn({ event: 'digest.daily_stats_failed', userId, err: error }, 'Daily digest stats unavailable; degrading to zeros');
    return {
      eventsCount: 0, todosCompleted: 0, todosAdded: 0, dosesTaken: 0, dosesMissed: 0, dueToday: 0, habitRate: null,
    };
  }
}

/** 区间内「有目标的习惯」的平均完成率；没有可统计的习惯 → null（渲染为 —）。 */
function averageHabitRate(habits: DigestHabitRow[]): number | null {
  const counted = habits.filter((habit) => habit.target > 0);
  if (counted.length === 0) return null;
  return Math.round(counted.reduce((sum, habit) => sum + habit.rate, 0) / counted.length);
}

/**
 * 周报对比：用同一套 buildDigestData 聚合上周（now - 7 天）的区间型指标，
 * 与本期 `current` 的同口径计数逐行对比。时点型指标（未来 30 天 / 逾期）不参与。
 * 失败 → null（渲染时跳过该区块）。
 */
async function buildWeeklyComparison(
  userId: number,
  current: Pick<DigestData, 'habits' | 'medications' | 'spend' | 'goals'>,
  now: Date,
): Promise<DigestComparison | null> {
  try {
    const previous = await buildDigestData(userId, 'weekly', new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), { withComparison: false });
    return {
      from: previous.from,
      to: previous.to,
      rows: [
        { label: '习惯打卡次数', current: current.habits.reduce((sum, habit) => sum + habit.logged, 0), previous: previous.habits.reduce((sum, habit) => sum + habit.logged, 0) },
        { label: '用药记录条数', current: current.medications.total, previous: previous.medications.total },
        { label: '一次性支出笔数', current: current.spend.onceCount, previous: previous.spend.onceCount },
        { label: '目标数', current: current.goals.length, previous: previous.goals.length },
      ],
    };
  } catch (error) {
    log.warn({ event: 'digest.weekly_comparison_failed', userId, err: error }, 'Weekly digest comparison unavailable');
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 数据聚合（真实 SQL + 既有 service）                                  */
/* ------------------------------------------------------------------ */

export interface BuildDigestDataOptions {
  /** 内部递归保护：周报对比聚合上周时不再次触发对比。 */
  withComparison?: boolean;
}

export async function buildDigestData(
  userId: number,
  period: DigestPeriod,
  now: Date = new Date(),
  options: BuildDigestDataOptions = {},
): Promise<DigestData> {
  const bounds = digestPeriodBounds(period, now);
  const today = toYmd(now);
  const horizon = addDaysYmd(today, 30);

  const [upcomingResult, overdueResult, habitsResult, maintenanceResult, goalsResult, spend, adherence] = await Promise.all([
    query(
      `SELECT id, name, type, TO_CHAR(COALESCE(next_occurrence, date), 'YYYY-MM-DD') AS occurrence
       FROM events
       WHERE user_id = $1
         AND COALESCE(next_occurrence, date) >= $2::date
         AND COALESCE(next_occurrence, date) <= $3::date
       ORDER BY occurrence ASC, id ASC
       LIMIT 200`,
      [userId, today, horizon],
    ),
    query(
      `SELECT 'expiry' AS kind, title, TO_CHAR(next_due_date, 'YYYY-MM-DD') AS due
         FROM expiry_items WHERE user_id = $1 AND is_active = TRUE AND next_due_date < $2::date
       UNION ALL
       SELECT 'maintenance', asset_name, TO_CHAR(next_due_at, 'YYYY-MM-DD')
         FROM maintenance_plans WHERE user_id = $1 AND is_active = TRUE AND next_due_at IS NOT NULL AND next_due_at < $2::date
       UNION ALL
       SELECT 'document', title, TO_CHAR(expires_at, 'YYYY-MM-DD')
         FROM documents WHERE user_id = $1 AND is_active = TRUE AND expires_at IS NOT NULL AND expires_at < $2::date
       ORDER BY due ASC`,
      [userId, today],
    ),
    query(
      `SELECT h.id, h.name, h.target_per_period, h.period, h.schedule_days,
              COALESCE((SELECT SUM(hl.count) FROM habit_logs hl
                        WHERE hl.habit_id = h.id AND hl.logged_on BETWEEN $2::date AND $3::date), 0)::int AS logged
       FROM habits h
       WHERE h.user_id = $1 AND h.is_active = TRUE
       ORDER BY h.id ASC`,
      [userId, bounds.from, bounds.to],
    ),
    query(
      `SELECT asset_name, TO_CHAR(next_due_at, 'YYYY-MM-DD') AS due
       FROM maintenance_plans
       WHERE user_id = $1 AND is_active = TRUE AND next_due_at IS NOT NULL AND next_due_at <= $2::date
       ORDER BY next_due_at ASC`,
      [userId, horizon],
    ),
    query(
      `SELECT g.id, g.title, g.status, g.target_value, g.current_value,
              COUNT(m.id)::int AS milestone_total,
              COUNT(m.id) FILTER (WHERE m.done_at IS NOT NULL)::int AS milestone_done
       FROM goals g
       LEFT JOIN milestones m ON m.goal_id = g.id
       WHERE g.user_id = $1 AND g.status IN ('active', 'paused')
       GROUP BY g.id
       ORDER BY g.id ASC`,
      [userId],
    ),
    getExpiryCosts(userId, { granularity: period === 'yearly' ? 'year' : 'month', from: bounds.from, to: bounds.to }),
    getAdherence(userId, bounds.from, bounds.to),
  ]);

  const upcoming: DigestUpcomingRow[] = upcomingResult.rows.map((row) => ({
    id: asNumber(row.id),
    name: String(row.name ?? ''),
    type: String(row.type ?? ''),
    date: asYmd(row.occurrence),
  }));

  const overdue: DigestOverdueRow[] = overdueResult.rows.map((row) => {
    const due = asYmd(row.due);
    return {
      kind: String(row.kind ?? ''),
      title: String(row.title ?? ''),
      due,
      daysOverdue: Math.max(0, diffCalendarDays(due, today)),
    };
  });

  const habits: DigestHabitRow[] = habitsResult.rows.map((row) => {
    const scheduledDays = countScheduledDays(bounds.from, bounds.to, normalizeScheduleDays((row.schedule_days ?? null) as number[] | null));
    const perPeriod = Math.max(1, Math.trunc(asNumber(row.target_per_period, 1)));
    const periods = row.period === 'week' ? Math.ceil(scheduledDays / 7) : scheduledDays;
    const target = perPeriod * Math.max(0, periods);
    const logged = asNumber(row.logged);
    const rate = target > 0 ? Math.min(100, Math.round((logged / target) * 100)) : 0;
    return { name: String(row.name ?? ''), logged, target, rate };
  });

  const maintenance: DigestMaintenanceRow[] = maintenanceResult.rows.map((row) => {
    const due = asYmd(row.due);
    return { assetName: String(row.asset_name ?? ''), due, overdue: due < today };
  });

  const goals: DigestGoalRow[] = goalsResult.rows.map((row) => {
    const target = row.target_value == null ? null : asNumber(row.target_value);
    const current = asNumber(row.current_value);
    const progress = target != null && target > 0 ? Math.min(100, Math.round((current / target) * 100)) : null;
    return {
      title: String(row.title ?? ''),
      status: String(row.status ?? ''),
      progress,
      milestonesDone: asNumber(row.milestone_done),
      milestonesTotal: asNumber(row.milestone_total),
    } as DigestGoalRow;
  });

  const spendData: DigestSpend = {
    from: bounds.from,
    to: bounds.to,
    byCurrency: spend.byCurrency,
    onceByCurrency: spend.once.byCurrency,
    onceCount: spend.once.count,
    byKind: spend.byKind,
  };

  const medications: DigestMedicationSummary = {
    taken: adherence.overall.taken,
    skipped: adherence.overall.skipped,
    missed: adherence.overall.missed,
    total: adherence.overall.total,
    percentage: adherence.overall.percentage,
    perMedication: adherence.medications.map((med) => ({
      name: med.name,
      taken: med.taken,
      skipped: med.skipped,
      missed: med.missed,
      total: med.total,
      percentage: med.percentage,
    })),
  };

  const isEmpty =
    upcoming.length === 0 &&
    overdue.length === 0 &&
    Object.keys(spendData.byCurrency).length === 0 &&
    spendData.onceCount === 0 &&
    habits.every((habit) => habit.logged === 0) &&
    medications.total === 0 &&
    maintenance.length === 0 &&
    goals.length === 0;

  const dailyStats = period === 'daily' ? await buildDailyStats(userId, bounds.from, bounds.to, today) : undefined;
  if (dailyStats) dailyStats.habitRate = averageHabitRate(habits);
  const comparison =
    period === 'weekly' && options.withComparison !== false
      ? await buildWeeklyComparison(userId, { habits, medications, spend: spendData, goals }, now)
      : undefined;

  return {
    userId,
    period,
    from: bounds.from,
    to: bounds.to,
    today,
    upcoming,
    overdue,
    spend: spendData,
    habits,
    medications,
    maintenance,
    goals,
    isEmpty,
    ...(dailyStats ? { daily: dailyStats } : {}),
    ...(comparison ? { comparison } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 偏好与区块过滤（checkbox 80）                                        */
/* ------------------------------------------------------------------ */

export interface DigestPreferences {
  enabled: boolean;
  period: DigestPeriod;
  /** 收件人覆盖；空数组 = 回退到 resolveRecipientEmails。 */
  recipients: string[];
  /** null = 全部区块。 */
  sections: DigestSectionKey[] | null;
  /** null = 自动选择第一个可用邮件渠道。 */
  channelAccountId: number | null;
  /** v2.30 方向 A：日报/周报独立开关与投递时刻（用户本地时区 HH:mm）。 */
  dailyEnabled: boolean;
  dailyTime: string;
  weeklyEnabled: boolean;
  /** 0=周日 … 6=周六 */
  weeklyDay: number;
  weeklyTime: string;
}

/**
 * 从既有 `getUserConfig()` 结果读取摘要偏好。
 *
 * 刻意复用已经取到的 `userConfig`（而不是再引一个 config.service 的新函数）：
 * digest-send 的既有测试只 mock 了 `getUserConfig`/`getNotificationAccounts`，
 * 这样不会破坏它们的 mock 契约；缺字段时回退到「启用 + 全部区块 + 无覆盖」，
 * 与 v79 的行为一致。
 */
function readDigestPreferences(userConfig: Record<string, unknown> | null | undefined): DigestPreferences {
  // v2.30 方向 A：日报/周报的独立开关与时刻（v81 迁移列，全带默认值）
  const hhmm = (value: unknown, fallback: string): string =>
    typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
  const weekday = (value: unknown): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6 ? value : 1;
  return {
    enabled: userConfig?.digest_enabled !== false,
    period: userConfig?.digest_period === 'yearly' ? 'yearly' : 'monthly',
    recipients: sanitizeDigestRecipients(userConfig?.digest_recipients),
    sections: normalizeDigestSections(userConfig?.digest_sections),
    channelAccountId:
      typeof userConfig?.digest_channel_account_id === 'number' ? userConfig.digest_channel_account_id : null,
    dailyEnabled: userConfig?.digest_daily_enabled === true,
    dailyTime: hhmm(userConfig?.digest_daily_time, '21:00'),
    weeklyEnabled: userConfig?.digest_weekly_enabled === true,
    weeklyDay: weekday(userConfig?.digest_weekly_day),
    weeklyTime: hhmm(userConfig?.digest_weekly_time, '09:00'),
  };
}

/**
 * v2.30 方向 A：daily/weekly 是否到了今天的投递时刻（用户本地时区）。
 * 外部 cron 每天调一次 /api/cron/digest?period=daily|weekly；只要本地时间
 * 已过配置时刻即视为到点，配合 digest_archive 查重保证一天最多发一次。
 */
export function isDigestDue(prefs: DigestPreferences, period: DigestPeriod, now: Date, timezone?: string): boolean {
  if (period === 'daily') {
    if (!prefs.dailyEnabled) return false;
    return localHhmm(now, timezone) >= prefs.dailyTime;
  }
  if (period === 'weekly') {
    if (!prefs.weeklyEnabled) return false;
    const localNow = toZonedDate(now, timezone);
    if (localNow.getUTCDay() !== prefs.weeklyDay) return false;
    const hhmm = `${String(localNow.getUTCHours()).padStart(2, '0')}:${String(localNow.getUTCMinutes()).padStart(2, '0')}`;
    return hhmm >= prefs.weeklyTime;
  }
  return true;
}

/** 任意时区的 HH:mm 字符串（依赖 Intl；时区非法时回退 Asia/Shanghai）。 */
function localHhmm(now: Date, timezone?: string): string {
  const localNow = toZonedDate(now, timezone);
  return `${String(localNow.getUTCHours()).padStart(2, '0')}:${String(localNow.getUTCMinutes()).padStart(2, '0')}`;
}

/** 把绝对时刻平移到目标时区的墙钟（以 UTC 字段读出）。 */
function toZonedDate(now: Date, timezone?: string): Date {
  let tz = timezone || 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'Asia/Shanghai';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')));
}

/**
 * 按用户选择裁剪区块。`null` / 空数组 → 原样返回全部区块，
 * 因此「一个区块都不选」永远不会渲染出一份空摘要。
 * 被排除的区块清空为「无记录」，并重算 `isEmpty`。
 */
export function selectDigestSections(
  data: DigestData,
  sections: readonly DigestSectionKey[] | null | undefined,
): DigestData {
  if (!sections || sections.length === 0) return data;
  const want = new Set<DigestSectionKey>(sections);

  const upcoming = want.has('upcoming') ? data.upcoming : [];
  const overdue = want.has('overdue') ? data.overdue : [];
  const spend: DigestSpend = want.has('spend')
    ? data.spend
    : { ...data.spend, byCurrency: {}, onceByCurrency: {}, onceCount: 0, byKind: [] };
  const habits = want.has('habits') ? data.habits : [];
  const medications: DigestMedicationSummary = want.has('medications')
    ? data.medications
    : { taken: 0, skipped: 0, missed: 0, total: 0, percentage: 0, perMedication: [] };
  const maintenance = want.has('maintenance') ? data.maintenance : [];
  const goals = want.has('goals') ? data.goals : [];

  const isEmpty =
    upcoming.length === 0 &&
    overdue.length === 0 &&
    Object.keys(spend.byCurrency).length === 0 &&
    spend.onceCount === 0 &&
    habits.every((habit) => habit.logged === 0) &&
    medications.total === 0 &&
    maintenance.length === 0 &&
    goals.length === 0;

  return { ...data, upcoming, overdue, spend, habits, medications, maintenance, goals, sections: [...want], isEmpty };
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(cents: number, currency = 'CNY'): string {
  const amount = (cents / 100).toFixed(2);
  return currency === 'CNY' ? `¥${amount}` : `${currency} ${amount}`;
}

const HTML_STYLE = `
:root{--bg:#f1f5f9;--card:#fff;--border:#e2e8f0;--muted:#64748b;--text:#0f172a;--primary:#2563eb;--green:#10b981;--amber:#f59e0b;--red:#ef4444}
*{box-sizing:border-box}body{margin:0;padding:32px 16px;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;font-size:14px;line-height:1.65}
.report{max-width:840px;margin:0 auto}.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-bottom:16px;box-shadow:0 1px 2px rgba(15,23,42,.06)}
h1{font-size:22px;margin:0 0 8px}h2{font-size:15px;margin:0 0 12px}.meta{margin:2px 0;color:var(--muted)}.meta strong{color:var(--text)}
table{width:100%;border-collapse:collapse}th,td{padding:7px 9px;border-bottom:1px solid var(--border);text-align:left}th{color:var(--muted);font-size:12px}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.empty{margin:0;padding:6px 0;color:var(--muted)}.banner{padding:14px 18px;margin-bottom:16px}.banner strong{color:var(--primary)}
`;

function htmlSection(title: string, body: string): string {
  return `<section class="card"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

/** 区块是否渲染：未指定 sections = 全部；指定则只渲染命中的。 */
function sectionIncluded(data: DigestData, key: DigestSectionKey): boolean {
  return !data.sections || data.sections.includes(key);
}

/** 变化量文案：正数带 +，0 显示「持平」。 */
function deltaLabel(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return String(delta);
  return '持平';
}

/** 日报「过去 24 小时概览」的固定行序（HTML 与 PDF 共用）。 */
function dailyStatsRows(daily: DigestDailyStats): Array<Array<string | number>> {
  return [
    ['昨日事件', daily.eventsCount],
    ['完成待办/提醒', daily.todosCompleted],
    ['新增待办/事项', daily.todosAdded],
    ['已服药', daily.dosesTaken],
    ['漏服/错过用药', daily.dosesMissed],
    ['今日到期', daily.dueToday],
    ['习惯打卡率（平均）', daily.habitRate == null ? '—' : `${daily.habitRate}%`],
  ];
}

function htmlRows(headers: string[], rows: Array<Array<string | number>>, emptyLabel = '无记录'): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(emptyLabel)}</p>`;
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((cells) => `<tr>${cells.map((cell, i) => `<td${i > 0 ? ' class="num"' : ''}>${escapeHtml(String(cell))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderDigestHtml(data: DigestData): string {
  const banner = data.isEmpty
    ? '<section class="card banner"><strong>本期无记录</strong><p class="meta">该账户在本期没有任何事件、待办、订阅、习惯、用药、保养或目标数据。</p></section>'
    : '';
  const narrative = data.narrative
    ? `<section class="card banner"><strong>本期叙述</strong><p class="meta">${escapeHtml(data.narrative)}</p></section>`
    : '';
  const generationNote = data.narrative ? AI_NOTE : DETERMINISTIC_NOTE;

  const spendRows: Array<Array<string | number>> = Object.entries(data.spend.byCurrency)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => [`周期折算 (${currency})`, money(cents, currency)]);
  for (const [currency, cents] of Object.entries(data.spend.onceByCurrency).sort(([a], [b]) => a.localeCompare(b))) {
    spendRows.push([`一次性支出 (${currency})`, money(cents, currency)]);
  }

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>TimeMark ${escapeHtml(PERIOD_LABEL[data.period])}摘要</title><style>${HTML_STYLE}</style></head>
<body><main class="report">
<section class="card"><h1>TimeMark ${escapeHtml(PERIOD_LABEL[data.period])}摘要</h1>
<p class="meta">统计区间：<strong>${escapeHtml(data.from)}</strong> 至 <strong>${escapeHtml(data.to)}</strong></p>
<p class="meta">生成日期：${escapeHtml(data.today)} · ${generationNote}</p></section>
${narrative}
${banner}
${sectionIncluded(data, 'upcoming') ? htmlSection('未来 30 天', htmlRows(['事项', '类型', '日期'], data.upcoming.map((e) => [e.name, e.type, e.date]))) : ''}
${sectionIncluded(data, 'overdue') ? htmlSection('逾期事项', htmlRows(['类型', '事项', '到期', '逾期天数'], data.overdue.map((o) => [o.kind, o.title, o.due, o.daysOverdue]))) : ''}
${sectionIncluded(data, 'spend') ? htmlSection('订阅与到期支出', htmlRows(['项目', '金额'], spendRows)) : ''}
${sectionIncluded(data, 'habits') ? htmlSection('习惯完成率', htmlRows(['习惯', '已完成', '目标', '完成率'], data.habits.map((h) => [h.name, h.logged, h.target, `${h.rate}%`]))) : ''}
${sectionIncluded(data, 'medications') ? htmlSection('用药依从性', htmlRows(['药品', '已服', '跳过', '漏服', '合计', '依从率'], data.medications.perMedication.map((m) => [m.name, m.taken, m.skipped, m.missed, m.total, `${m.percentage}%`]))) : ''}
${sectionIncluded(data, 'maintenance') ? htmlSection('保养到期', htmlRows(['资产', '到期', '状态'], data.maintenance.map((m) => [m.assetName, m.due, m.overdue ? '已逾期' : '临近']))) : ''}
${sectionIncluded(data, 'goals') ? htmlSection('目标进度', htmlRows(['目标', '状态', '进度', '里程碑'], data.goals.map((g) => [g.title, g.status, g.progress == null ? '—' : `${g.progress}%`, `${g.milestonesDone}/${g.milestonesTotal}`]))) : ''}
${data.period === 'daily' && data.daily ? htmlSection('过去 24 小时概览', htmlRows(['指标', '数量'], dailyStatsRows(data.daily))) : ''}
${data.period === 'weekly' && data.comparison ? htmlSection(`周对比（本周 vs 上周 ${data.comparison.from}~${data.comparison.to}）`, htmlRows(['指标', '本周', '上周', '变化'], data.comparison.rows.map((r) => [r.label, r.current, r.previous, deltaLabel(r.current - r.previous)]))) : ''}
</main></body></html>
`;
}

/* ------------------------------------------------------------------ */
/* PDF（字节稳定）                                                     */
/* ------------------------------------------------------------------ */

const PAGE_SIZE: [number, number] = [595.28, 841.89];
const PAGE_MARGIN = 48;
const PAGE_BOTTOM = 64;
const SLATE_900 = rgb(0.06, 0.09, 0.16);
const SLATE_500 = rgb(0.39, 0.45, 0.55);
const RULE = rgb(0.89, 0.91, 0.94);
const BLUE = rgb(0.15, 0.39, 0.92);

interface PdfWriter { doc: PDFDocument; font: PDFFont; page: PDFPage; y: number }

function ensureSpace(writer: PdfWriter, needed: number): void {
  if (writer.y - needed < PAGE_BOTTOM) {
    writer.page = writer.doc.addPage(PAGE_SIZE);
    writer.y = PAGE_SIZE[1] - PAGE_MARGIN;
  }
}

function writeLine(writer: PdfWriter, text: string, opts: { size?: number; color?: RGB; gap?: number } = {}): void {
  const size = opts.size ?? 10;
  ensureSpace(writer, size + 6);
  writer.page.drawText(text, { x: PAGE_MARGIN, y: writer.y, size, font: writer.font, color: opts.color ?? SLATE_900 });
  writer.y -= size + (opts.gap ?? 6);
}

function fitText(font: PDFFont, text: string, maxWidth: number, size: number): string {
  if (text.length === 0) return text;
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** 把 AI 叙述按固定字符数折行，避免单行溢出 PDF 版心。 */
function wrapPdfText(text: string, maxChars = 46): string[] {
  const lines: string[] = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if (current.length >= maxChars) {
      lines.push(current);
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawRows(writer: PdfWriter, rows: string[][], columns: number[]): void {
  const rowHeight = 15;
  const totalWidth = columns.reduce((sum, w) => sum + w, 0);
  for (const row of rows) {
    ensureSpace(writer, rowHeight);
    let x = PAGE_MARGIN;
    columns.forEach((width, index) => {
      const cell = row[index] ?? '';
      if (cell.length > 0) {
        const text = fitText(writer.font, cell, width - 8, 9.5);
        writer.page.drawText(text, { x, y: writer.y, size: 9.5, font: writer.font, color: SLATE_900 });
      }
      x += width;
    });
    writer.y -= rowHeight;
  }
  writer.page.drawLine({ start: { x: PAGE_MARGIN, y: writer.y + 5 }, end: { x: PAGE_MARGIN + totalWidth, y: writer.y + 5 }, thickness: 0.6, color: RULE });
  writer.y -= 9;
}

function pdfSection(writer: PdfWriter, title: string, headers: string[], rows: string[][], columns: number[]): void {
  writeLine(writer, title, { size: 13, gap: 8 });
  if (rows.length === 0) {
    writeLine(writer, '无记录', { size: 10, color: SLATE_500, gap: 12 });
    return;
  }
  ensureSpace(writer, 20);
  writer.page.drawText(headers.join('   '), { x: PAGE_MARGIN, y: writer.y, size: 9, font: writer.font, color: SLATE_500 });
  writer.y -= 13;
  drawRows(writer, rows, columns);
}

/** A4 PDF。`updateMetadata: false` → 无时间戳；内容完全由 payload 决定（字节稳定）。 */
export async function renderDigestPdf(data: DigestData): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await embedReportFont(doc);
  const writer: PdfWriter = { doc, font, page: doc.addPage(PAGE_SIZE), y: PAGE_SIZE[1] - PAGE_MARGIN };

  writeLine(writer, `TimeMark ${PERIOD_LABEL[data.period]}摘要`, { size: 18, gap: 10, color: BLUE });
  writeLine(writer, `统计区间：${data.from} 至 ${data.to}`, { size: 11, gap: 2 });
  writeLine(writer, `生成日期：${data.today}`, { size: 11, gap: 2 });
  writeLine(writer, data.narrative ? AI_NOTE : DETERMINISTIC_NOTE, { size: 9, color: SLATE_500, gap: data.narrative ? 4 : 14 });
  if (data.narrative) {
    writeLine(writer, '本期叙述', { size: 12, gap: 4, color: BLUE });
    for (const line of wrapPdfText(data.narrative)) writeLine(writer, line, { size: 10, gap: 4 });
    writer.y -= 6;
  }
  if (data.isEmpty) writeLine(writer, '本期无记录', { size: 12, gap: 14, color: SLATE_500 });

  if (sectionIncluded(data, 'upcoming')) pdfSection(writer, '未来 30 天', ['事项', '类型', '日期'], data.upcoming.map((e) => [e.name, e.type, e.date]), [220, 130, 137]);
  if (sectionIncluded(data, 'overdue')) pdfSection(writer, '逾期事项', ['类型', '事项', '到期', '逾期'], data.overdue.map((o) => [o.kind, o.title, o.due, `${o.daysOverdue} 天`]), [90, 230, 100, 67]);
  const spendRows: string[][] = Object.entries(data.spend.byCurrency).sort(([a], [b]) => a.localeCompare(b)).map(([c, cents]) => [`周期折算 (${c})`, money(cents, c)]);
  for (const [c, cents] of Object.entries(data.spend.onceByCurrency).sort(([a], [b]) => a.localeCompare(b))) spendRows.push([`一次性 (${c})`, money(cents, c)]);
  if (sectionIncluded(data, 'spend')) pdfSection(writer, '订阅与到期支出', ['项目', '金额'], spendRows, [340, 147]);
  if (sectionIncluded(data, 'habits')) pdfSection(writer, '习惯完成率', ['习惯', '已完成', '目标', '完成率'], data.habits.map((h) => [h.name, String(h.logged), String(h.target), `${h.rate}%`]), [270, 90, 90, 37]);
  if (sectionIncluded(data, 'medications')) pdfSection(writer, '用药依从性', ['药品', '已服', '跳过', '漏服', '依从率'], data.medications.perMedication.map((m) => [m.name, String(m.taken), String(m.skipped), String(m.missed), `${m.percentage}%`]), [250, 77, 77, 77, 6]);
  if (sectionIncluded(data, 'maintenance')) pdfSection(writer, '保养到期', ['资产', '到期', '状态'], data.maintenance.map((m) => [m.assetName, m.due, m.overdue ? '已逾期' : '临近']), [280, 120, 87]);
  if (sectionIncluded(data, 'goals')) pdfSection(writer, '目标进度', ['目标', '状态', '进度', '里程碑'], data.goals.map((g) => [g.title, g.status, g.progress == null ? '—' : `${g.progress}%`, `${g.milestonesDone}/${g.milestonesTotal}`]), [260, 90, 70, 67]);
  if (data.period === 'daily' && data.daily) pdfSection(writer, '过去 24 小时概览', ['指标', '数量'], dailyStatsRows(data.daily).map(([label, value]) => [String(label), String(value)]), [320, 67]);
  if (data.period === 'weekly' && data.comparison) {
    pdfSection(
      writer,
      `周对比（本周 vs 上周 ${data.comparison.from}~${data.comparison.to}）`,
      ['指标', '本周', '上周', '变化'],
      data.comparison.rows.map((r) => [r.label, String(r.current), String(r.previous), deltaLabel(r.current - r.previous)]),
      [220, 80, 80, 107],
    );
  }

  writeLine(writer, '本摘要由 TimeMark 生成，仅作记录。', { size: 9, color: SLATE_500 });
  return doc.save();
}

/* ------------------------------------------------------------------ */
/* 发送                                                                */
/* ------------------------------------------------------------------ */

export interface DigestSendResult {
  userId: number;
  period: DigestPeriod;
  from: string;
  to: string;
  emailed: boolean;
  recipients: string[];
  inbox: boolean;
  /** cron 路径下因用户关闭摘要而跳过；或查重命中（本期已发过）而跳过。 */
  skipped?: boolean;
  reason?: 'no_email_recipient' | 'no_email_channel' | 'already_sent';
}

export interface DigestSendOptions {
  /**
   * cron 路径传 true：用户关闭摘要时直接跳过（不建数据、不发信）。
   * 手动 `POST /api/digest/send`（默认 false）是用户的显式动作，即使定时任务关闭也照发。
   */
  respectEnabled?: boolean;
  /**
   * v2.30 方向 A：查重防重发。开启时若 digest_archive 已有同 period + 同期号的记录
   * （= 今天/本周已经发过），直接跳过。定时路径固定开启；手动发送不查重（显式动作）。
   */
  skipDuplicates?: boolean;
}

function plainSummary(data: DigestData): string {
  const lines = [
    `TimeMark ${PERIOD_LABEL[data.period]}摘要（${data.from} 至 ${data.to}）`,
    `未来 30 天：${data.upcoming.length} 项`,
    `逾期：${data.overdue.length} 项`,
    `习惯完成：${data.habits.length} 项`,
    `用药剂量：${data.medications.total} 条`,
    `保养到期：${data.maintenance.length} 项`,
    `目标：${data.goals.length} 项`,
  ];
  if (data.daily) {
    lines.push(
      `昨日事件：${data.daily.eventsCount}`,
      `完成待办/提醒：${data.daily.todosCompleted}`,
      `漏服/错过用药：${data.daily.dosesMissed}`,
      `今日到期：${data.daily.dueToday}`,
    );
  }
  if (data.comparison) {
    for (const row of data.comparison.rows) {
      lines.push(`${row.label}：${row.current}（上周 ${row.previous}）`);
    }
  }
  return lines.join('\n');
}

/**
 * 可选的 AI 叙述（checkbox 108），默认关闭。
 *
 * 绝不抛出：功能开关关闭、无 provider、超时、provider 报错、或输出未通过数字校验，
 * 都返回 `null`，即渲染结果与 task 79 逐字节一致（确定性降级）。
 */
async function resolveDigestNarrative(data: DigestData): Promise<string | null> {
  const { narrative } = await summarizeDigestNarrative(data, { enabled: isDigestNarrativeEnabled() });
  return narrative;
}

/**
 * v2.30 方向 A：日报/周报的 AI 叙述受 agent 每日预算闸约束（checkbox 118 的
 * agent_budget_usage 同一计数器）。仅当本地日还剩一个通知名额时才发起 LLM 调用；
 * 预算耗尽 / 计数器不可用（旧库）时分别「跳过 AI」/「放行」——前者省成本，后者
 * 不因缺表阻断既有降级路径。任何异常都不会抛出：AI 不可用 → 纯模板文本。
 * monthly/yearly 维持既有行为（不占预算），避免回归。
 */
async function resolveDigestNarrativeGated(
  userId: number,
  period: DigestPeriod,
  data: DigestData,
  timezone: string | undefined,
  now: Date,
): Promise<string | null> {
  if (period !== 'daily' && period !== 'weekly') return resolveDigestNarrative(data);
  if (!isDigestNarrativeEnabled()) return null;
  try {
    const tz = timezone && timezone.includes('/') ? timezone : 'Asia/Shanghai';
    const dayKey = getLocalDayKey(now, tz);
    const limit = readNotificationBudgetConfig().perDay;
    const consumed = await tryConsumeDailyBudget(userId, dayKey, limit);
    if (!consumed.allowed) {
      log.info(
        { event: 'digest.ai_budget_exhausted', userId, period, dayKey },
        'Digest AI narrative skipped: agent daily budget exhausted',
      );
      return null;
    }
  } catch (error) {
    // 预算闸自身失败（agent_budget_usage 表未建等）→ 放行，与归档写失败同策略。
    log.warn({ event: 'digest.ai_budget_gate_failed', userId, period, err: error }, 'Digest AI budget gate failed open');
  }
  return resolveDigestNarrative(data);
}

/**
 * digest_archive 查重（v2.30 方向 A）：同 period + 同期号（bounds.from）已归档
 * = 今天/本周已发过。表未建/旧库查询失败 → 视为未发过（放行），与归档写失败同策略。
 */
async function hasDigestArchiveForPeriod(userId: number, period: DigestPeriod, periodStart: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT id FROM digest_archive WHERE user_id = $1 AND period = $2 AND period_start = $3::date LIMIT 1`,
      [userId, period, periodStart],
    );
    return result.rows.length > 0;
  } catch (error) {
    log.warn({ event: 'digest.dedupe_probe_failed', userId, period, err: error }, 'Digest dedupe probe failed; assuming not sent');
    return false;
  }
}

/**
 * 为一个用户生成并投递摘要：写一条 Inbox 消息，并按解析出的收件人发一封带 PDF 附件的邮件。
 * 每次调用最多发 **一封** 邮件（收件人用逗号合并）；无邮件渠道/收件人时仍写 Inbox 并优雅返回。
 *
 * 尊重 v46 偏好：排除的区块不出现在正文/PDF/Inbox 里；收件人覆盖优先于
 * `resolveRecipientEmails`；`digest_channel_account_id` 指定投递渠道。
 */
export async function sendDigestForUser(
  userId: number,
  period: DigestPeriod,
  now: Date = new Date(),
  options: DigestSendOptions = {},
): Promise<DigestSendResult> {
  const userConfig = await getUserConfig(userId);
  const prefs = readDigestPreferences(userConfig);

  if (options.respectEnabled && !prefs.enabled) {
    return { userId, period, from: '', to: '', emailed: false, recipients: [], inbox: false, skipped: true };
  }

  // v2.30 方向 A：daily/weekly 有独立的开关与投递时刻；monthly/yearly 沿用原开关。
  if (options.respectEnabled && (period === 'daily' || period === 'weekly')) {
    if (!isDigestDue(prefs, period, now, userConfig?.timezone)) {
      return { userId, period, from: '', to: '', emailed: false, recipients: [], inbox: false, skipped: true };
    }
  }

  // v2.30 方向 A：定时路径查重——同一天/同一周不重复发送（digest_archive 查重）。
  if (options.skipDuplicates) {
    const bounds = digestPeriodBounds(period, now);
    if (await hasDigestArchiveForPeriod(userId, period, bounds.from)) {
      return {
        userId, period, from: bounds.from, to: bounds.to,
        emailed: false, recipients: [], inbox: false, skipped: true, reason: 'already_sent',
      };
    }
  }

  const fullData = await buildDigestData(userId, period, now);
  const data = selectDigestSections(fullData, prefs.sections);
  const narrative = await resolveDigestNarrativeGated(userId, period, data, userConfig?.timezone, now);
  const dataWithNarrative: DigestData = narrative ? { ...data, narrative } : data;
  const html = renderDigestHtml(dataWithNarrative);
  const pdf = await renderDigestPdf(dataWithNarrative);

  // v2.26: AI 月报归档——"AI 把重要的留下来，不重要的清掉"。摘要（AI 叙述 +
  // 确定性统计）写 digest_archive 永久保存，此后 90 天保留期的原始触发日志
  // 到期删除也不丢历史；narrative 关闭时存纯文本摘要（plainSummary）。
  try {
    await query(
      `INSERT INTO digest_archive (user_id, period, period_start, period_end, narrative_md, stats_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        period,
        data.from,
        data.to,
        narrative ?? plainSummary(data),
        JSON.stringify({
          upcoming: data.upcoming.length,
          overdue: data.overdue.length,
          habits: data.habits.length,
          medications: data.medications.total,
          maintenance: data.maintenance.length,
          goals: data.goals.length,
          narrativeSource: narrative ? 'ai' : 'deterministic',
          ...(data.daily ? { daily: data.daily } : {}),
          ...(data.comparison ? { comparison: data.comparison } : {}),
        }),
      ],
    );
  } catch (error) {
    // 归档失败不阻断摘要发送（表未建/旧库）——下月再试
    log.warn({ event: 'digest.archive_failed', userId, err: error }, 'Digest archive write failed');
  }

  const base: DigestSendResult = { userId, period, from: data.from, to: data.to, emailed: false, recipients: [], inbox: false };

  let inbox = false;
  try {
    const message = await createInboxMessage({
      userId,
      title: `TimeMark ${PERIOD_LABEL[period]}摘要 · ${data.to}`,
      body: narrative ? `${narrative}\n\n${plainSummary(data)}` : plainSummary(data),
      source: 'inbound',
      senderLabel: '定期摘要',
    });
    inbox = message !== null;
  } catch (error) {
    log.warn({ event: 'digest.inbox_failed', userId, err: error }, 'Digest inbox message failed');
  }

  const accounts = await getNotificationAccounts(userId);
  const emailAccounts = accounts.filter((account) => account.is_active !== false && EMAIL_CHANNEL_TYPES.has(account.type));
  const chConfig = {
    emails: emailAccounts
      .map((account) => account.chat_id)
      .filter((email): email is string => typeof email === 'string' && email.includes('@')),
  };
  const resolved = resolveRecipientEmails({}, chConfig, userConfig);
  const recipients = prefs.recipients.length > 0 ? prefs.recipients : resolved;
  if (recipients.length === 0) {
    return { ...base, inbox, reason: 'no_email_recipient' };
  }

  const creds = await resolveEmailAccount(userId, prefs.channelAccountId ?? undefined).catch(() => null);
  if (!creds) {
    return { ...base, recipients, inbox, reason: 'no_email_channel' };
  }

  await sendRawEmail(
    creds,
    recipients,
    `TimeMark ${PERIOD_LABEL[period]}摘要 · ${data.to}`,
    html,
    [{ filename: `timemark-digest-${period}-${data.to}.pdf`, content: pdf, contentType: 'application/pdf' }],
  );

  return { ...base, emailed: true, recipients, inbox };
}

export interface DigestBatchResult {
  period: DigestPeriod;
  users: number;
  sent: number;
  skipped: number;
  results: DigestSendResult[];
}

/**
 * cron 用：为每个用户生成并投递一份摘要（逐用户隔离失败）。
 * 关闭摘要的用户被计为 skipped 且不投递 —— 这就是「设置行被 cron 尊重」的落点。
 */
export async function sendDigestsForAllUsers(
  period: DigestPeriod,
  now: Date = new Date(),
): Promise<DigestBatchResult> {
  const usersResult = await query(`SELECT id FROM users ORDER BY id ASC`);
  let sent = 0;
  let skipped = 0;
  const results: DigestSendResult[] = [];

  for (const row of usersResult.rows) {
    const userId = asNumber(row.id);
    try {
      // v2.30 方向 A：定时路径一律查重——同 period 同期号只发一次
      const result = await sendDigestForUser(userId, period, now, { respectEnabled: true, skipDuplicates: true });
      results.push(result);
      if (result.emailed) sent += 1;
      else skipped += 1;
    } catch (error) {
      skipped += 1;
      log.error({ event: 'digest.user_failed', userId, period, err: error }, 'Digest failed for user');
    }
  }

  log.info({ period, users: usersResult.rows.length, sent, skipped }, 'Digest run finished');
  return { period, users: usersResult.rows.length, sent, skipped, results };
}

/* ------------------------------------------------------------------ */
/* 预览（checkbox 80）：只渲染、不发送                                */
/* ------------------------------------------------------------------ */

export interface DigestChannelStatus {
  id: number | null;
  name: string | null;
  type: string | null;
  configured: boolean;
}

export interface DigestPreview {
  userId: number;
  period: DigestPeriod;
  from: string;
  to: string;
  today: string;
  enabled: boolean;
  /** 生效的区块 key（空选择 → 全部）。 */
  sections: DigestSectionKey[];
  isEmpty: boolean;
  recipients: string[];
  recipientSource: 'override' | 'resolved' | 'none';
  channel: DigestChannelStatus;
  reason?: 'no_email_recipient' | 'no_email_channel';
  data: DigestData;
}

export interface DigestPreviewOverrides {
  sections?: DigestSectionKey[] | null;
  recipients?: unknown;
}

/**
 * 渲染一份摘要预览（真实数据，绝不发送/写 Inbox）。
 * 传入 overrides 时用「当前表单」而非已保存值，便于用户边改边看。
 * 无邮件渠道也照常返回 `data`（modal 仍能渲染），并用 `reason` 说明缺哪一环。
 */
export async function buildDigestPreview(
  userId: number,
  period: DigestPeriod,
  now: Date = new Date(),
  overrides: DigestPreviewOverrides = {},
): Promise<DigestPreview> {
  const userConfig = await getUserConfig(userId);
  const prefs = readDigestPreferences(userConfig);

  const sections = overrides.sections === undefined ? prefs.sections : normalizeDigestSections(overrides.sections);
  const recipientOverride =
    overrides.recipients === undefined ? prefs.recipients : sanitizeDigestRecipients(overrides.recipients);

  const fullData = await buildDigestData(userId, period, now);
  const data = selectDigestSections(fullData, sections);

  const accounts = await getNotificationAccounts(userId);
  const emailAccounts = accounts.filter((account) => account.is_active !== false && EMAIL_CHANNEL_TYPES.has(account.type));
  const chConfig = {
    emails: emailAccounts
      .map((account) => account.chat_id)
      .filter((email): email is string => typeof email === 'string' && email.includes('@')),
  };
  const resolved = resolveRecipientEmails({}, chConfig, userConfig);
  const recipients = recipientOverride.length > 0 ? recipientOverride : resolved;
  const recipientSource: DigestPreview['recipientSource'] =
    recipientOverride.length > 0 ? 'override' : resolved.length > 0 ? 'resolved' : 'none';

  const creds = await resolveEmailAccount(userId, prefs.channelAccountId ?? undefined).catch(() => null);
  const channel: DigestChannelStatus = creds
    ? { id: creds.id, name: creds.name, type: creds.type, configured: true }
    : { id: prefs.channelAccountId ?? null, name: null, type: null, configured: false };

  const reason: DigestPreview['reason'] =
    recipients.length === 0 ? 'no_email_recipient' : channel.configured ? undefined : 'no_email_channel';

  return {
    userId,
    period,
    from: data.from,
    to: data.to,
    today: data.today,
    enabled: prefs.enabled,
    sections: sections && sections.length > 0 ? [...sections] : [...DIGEST_SECTION_KEYS],
    isEmpty: data.isEmpty,
    recipients,
    recipientSource,
    channel,
    ...(reason ? { reason } : {}),
    data,
  };
}

/** 供校验/测试：把 digest 的纯文本正文（邮件 text/plain 版本）。 */
export function digestPlainText(html: string): string {
  return htmlToPlainText(html);
}
