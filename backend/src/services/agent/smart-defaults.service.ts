/**
 * 智能默认值（task 141）：从真实历史里用纯 SQL/统计（众数/中位数）推导每用户默认值，
 * 不经过任何模型调用。
 *
 * 学习信号（全部来自用户自己的行）：
 *   - 提醒提前天数   events.reminder_config.daysBeforeList（缺省回退 reminder_days_before）
 *                    按事件类型分组的众数——取常用值；中位数一并导出。
 *   - 常用时刻       events.reminder_config.reminderTimes（没有任何配置时回退 reminder_time 列）
 *                    的众数。
 *   - 常用渠道       events.notification_channels 的众数。
 *   - 常用时长       events(date - created_at) 的中位数——即「提前多久创建」的计划时长；
 *                    本应用没有会议时长列（schema.pg.sql 的 events 无 duration），
 *                    因此这里学习可证明存在的时长信号（计划周期），而不是编造数据。
 *   - 标题关键词标签 标题包含 keyword 的事件所关联 tag_links 里使用最多的标签（众数）。
 *
 * 每个默认值都带来源（history/default）、统计量（mode/median）、置信度与样本量；
 * 样本 < SMART_DEFAULTS_MIN_SAMPLES(3) 时一律回落到既有静态默认
 *（提前天数 [1,3,7] 与 createEvent 默认一致；时刻回落 user_configs.daily_check_time（默认 08:00）；
 * 渠道回落到空数组 = 交给渠道解析器；时长无静态默认，回落 null）。
 */
import { query } from '../../db/index.js';
import { confidenceForEvidence } from '../patterns.service.js';

export const SMART_DEFAULTS_MIN_SAMPLES = 3;
/** 与 event.service.ts createEvent 的静态默认一致。 */
export const STATIC_DEFAULT_LEAD_DAYS = [1, 3, 7];
export const STATIC_DEFAULT_TIME_OF_DAY = '08:00';

export interface LearnedDefault<T> {
  value: T;
  source: 'history' | 'default';
  statistic: 'mode' | 'median' | null;
  /** 0..1：众数 = 胜出计数/样本量；中位数等 = confidenceForEvidence(样本量)；回落 = 0 */
  confidence: number;
  sampleSize: number;
  /** 数据出处 / 回落理由（人可读） */
  provenance: string;
}

export interface SmartDefaultsBundle {
  kind: string | null;
  keyword: string | null;
  samples: Record<string, number>;
  defaults: {
    reminderLeadDays: LearnedDefault<number[]>;
    timeOfDay: LearnedDefault<string[]>;
    channel: LearnedDefault<string[]>;
    durationDays: LearnedDefault<number | null>;
    tagHint: LearnedDefault<string | null>;
  };
}

export interface SmartDefaultsQuery {
  /** 事件类型过滤（如 'meeting'）；省略 = 全部事件 */
  kind?: string | null;
  /** 标题关键词（用于标签提示） */
  keyword?: string | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  const parsed = parseJson(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function stringArray(raw: unknown): string[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? parsed.map((v) => String(v)).filter((v) => v.trim() !== '') : [];
}

function numberArray(raw: unknown): number[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((v) => Number(v))
    .filter((n) => Number.isSafeInteger(n) && n >= 0 && n <= 3650);
}

/** 众数（并列时取较小值，保证确定性）。空样本 → null。 */
function mode<T extends string | number>(values: T[]): { value: T; count: number } | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestCount = 0;
  for (const value of values) {
    const next = (counts.get(value) ?? 0) + 1;
    counts.set(value, next);
    const wins = next > bestCount || (next === bestCount && best !== null && value < best);
    if (wins) {
      best = value;
      bestCount = next;
    }
  }
  return best === null ? null : { value: best, count: bestCount };
}

/** 中位数（偶数样本取中间两数均值，保留 1 位小数）。 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(raw * 10) / 10;
}

function fromHistory<T>(
  value: T,
  statistic: 'mode' | 'median',
  confidence: number,
  sampleSize: number,
  provenance: string,
): LearnedDefault<T> {
  return { value, source: 'history', statistic, confidence: round2(confidence), sampleSize, provenance };
}

function fromDefault<T>(value: T, sampleSize: number, provenance: string): LearnedDefault<T> {
  return { value, source: 'default', statistic: null, confidence: 0, sampleSize, provenance };
}

function normalizeTime(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

interface EventHistoryRow {
  id: number;
  name: string;
  type: string;
  reminder_config: unknown;
  reminder_days_before: unknown;
  reminder_time: string | null;
  notification_channels: unknown;
  horizon_days: number | null;
}

function leadDaysOf(row: EventHistoryRow): number[] {
  const config = parseJsonObject(row.reminder_config);
  const fromConfig = numberArray(config.daysBeforeList);
  return fromConfig.length > 0 ? fromConfig : numberArray(row.reminder_days_before);
}

function reminderTimesOf(row: EventHistoryRow): string[] {
  const config = parseJsonObject(row.reminder_config);
  return stringArray(config.reminderTimes)
    .map(normalizeTime)
    .filter((v): v is string => v !== null);
}

function channelsOf(row: EventHistoryRow): string[] {
  const fromColumn = stringArray(row.notification_channels);
  if (fromColumn.length > 0) return fromColumn;
  return stringArray(parseJsonObject(row.reminder_config).channels);
}

/** `events.date - created_at::date` 为整数天；负值（导入的历史数据）不参与学习。 */
function horizonOf(row: EventHistoryRow): number | null {
  const n = Number(row.horizon_days);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function loadEvents(userId: number, kind: string | null): Promise<EventHistoryRow[]> {
  const params: unknown[] = [userId];
  let typeClause = '';
  if (kind) {
    params.push(kind);
    typeClause = ` AND type = $${params.length}`;
  }
  const result = await query(
    `SELECT id, name, type, reminder_config, reminder_days_before,
            reminder_time::text AS reminder_time, notification_channels,
            (date - created_at::date) AS horizon_days
       FROM events
      WHERE user_id = $1${typeClause}`,
    params,
  );
  return result.rows as EventHistoryRow[];
}

function learnLeadDays(rows: EventHistoryRow[]): LearnedDefault<number[]> {
  const leads = rows.flatMap(leadDaysOf);
  const winner = mode(leads);
  if (winner === null || leads.length < SMART_DEFAULTS_MIN_SAMPLES) {
    return fromDefault(
      STATIC_DEFAULT_LEAD_DAYS,
      leads.length,
      `样本不足（${leads.length} < ${SMART_DEFAULTS_MIN_SAMPLES}），回落到 createEvent 静态默认 [1,3,7]`,
    );
  }
  return fromHistory(
    [winner.value],
    'mode',
    winner.count / leads.length,
    leads.length,
    `events.reminder_config.daysBeforeList 众数（${winner.count}/${leads.length}；中位数 ${median(leads)} 天）`,
  );
}

function learnTimeOfDay(rows: EventHistoryRow[]): LearnedDefault<string[]> {
  const configTimes = rows.flatMap(reminderTimesOf);
  // reminder_time 列对所有行都有默认值（'09:00'），只有毫无配置时刻时才用它兜底，
  // 避免列默认值淹没真实的用户选择。
  const times = configTimes.length > 0
    ? configTimes
    : rows.map((row) => normalizeTime(row.reminder_time)).filter((v): v is string => v !== null);
  const winner = mode(times);
  if (winner === null || times.length < SMART_DEFAULTS_MIN_SAMPLES) {
    return fromDefault(
      [STATIC_DEFAULT_TIME_OF_DAY],
      times.length,
      `样本不足（${times.length} < ${SMART_DEFAULTS_MIN_SAMPLES}），回落 user_configs.daily_check_time / 静态默认 08:00`,
    );
  }
  return fromHistory(
    [winner.value],
    'mode',
    winner.count / times.length,
    times.length,
    `events.reminder_config.reminderTimes 众数（${winner.count}/${times.length}）`,
  );
}

function learnChannel(rows: EventHistoryRow[]): LearnedDefault<string[]> {
  const channels = rows.flatMap(channelsOf);
  const winner = mode(channels);
  if (winner === null || channels.length < SMART_DEFAULTS_MIN_SAMPLES) {
    return fromDefault(
      [],
      channels.length,
      `样本不足（${channels.length} < ${SMART_DEFAULTS_MIN_SAMPLES}），回落空数组 = 交渠道解析器`,
    );
  }
  return fromHistory(
    [winner.value],
    'mode',
    winner.count / channels.length,
    channels.length,
    `events.notification_channels 众数（${winner.count}/${channels.length}）`,
  );
}

function learnDuration(rows: EventHistoryRow[]): LearnedDefault<number | null> {
  const horizons = rows.map(horizonOf).filter((v): v is number => v !== null);
  const value = median(horizons);
  if (value === null || horizons.length < SMART_DEFAULTS_MIN_SAMPLES) {
    return fromDefault(
      null,
      horizons.length,
      `样本不足（${horizons.length} < ${SMART_DEFAULTS_MIN_SAMPLES}）且无静态时长默认，返回 null`,
    );
  }
  return fromHistory(
    value,
    'median',
    confidenceForEvidence(horizons.length),
    horizons.length,
    'events(date - created_at) 中位数：通常提前多少天创建（本应用无会议时长列）',
  );
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

async function learnTagHint(
  userId: number,
  kind: string | null,
  keyword: string | null,
): Promise<{ learned: LearnedDefault<string | null>; samples: number }> {
  if (!keyword) {
    return {
      learned: fromDefault(null, 0, '未提供 keyword，跳过标题关键词标签学习'),
      samples: 0,
    };
  }
  const params: unknown[] = [userId, `%${escapeLike(keyword)}%`];
  let typeClause = '';
  if (kind) {
    params.push(kind);
    typeClause = ` AND e.type = $${params.length}`;
  }
  const result = await query(
    `SELECT t.name AS tag, COUNT(*)::int AS n
       FROM tag_links tl
       JOIN tags t ON t.id = tl.tag_id
       JOIN events e ON e.id = tl.entity_id AND tl.entity_type = 'event'
      WHERE tl.user_id = $1 AND e.user_id = $1 AND e.name ILIKE $2${typeClause}
      GROUP BY t.name
      ORDER BY n DESC, t.name ASC`,
    params,
  );
  const rows = result.rows as Array<{ tag: unknown; n: unknown }>;
  const total = rows.reduce((sum, row) => sum + Number(row.n ?? 0), 0);
  const top = rows[0];
  if (!top || total < SMART_DEFAULTS_MIN_SAMPLES) {
    return {
      learned: fromDefault(
        null,
        total,
        `样本不足（${total} < ${SMART_DEFAULTS_MIN_SAMPLES}），不做标签提示`,
      ),
      samples: total,
    };
  }
  const tag = String(top.tag);
  const count = Number(top.n);
  return {
    learned: fromHistory(
      tag,
      'mode',
      count / total,
      total,
      `标题包含「${keyword}」的事件在 tag_links 中最常用的标签（${count}/${total}）`,
    ),
    samples: total,
  };
}

/**
 * 推导某用户的智能默认值。kind 省略 = 对全部事件学习；keyword 省略 = 不做标签提示。
 */
export async function deriveSmartDefaults(
  userId: number,
  options: SmartDefaultsQuery = {},
): Promise<SmartDefaultsBundle> {
  const kind = options.kind?.trim() || null;
  const keyword = options.keyword?.trim() || null;

  const events = await loadEvents(userId, kind);
  const tag = await learnTagHint(userId, kind, keyword);

  const leadValues = events.flatMap(leadDaysOf).length;
  const configTimeValues = events.flatMap(reminderTimesOf).length;
  // 与 learnTimeOfDay 的取数一致：优先配置时刻，完全缺失时才回退 reminder_time 列。
  const timeValues = configTimeValues > 0
    ? configTimeValues
    : events.map((row) => normalizeTime(row.reminder_time)).filter((v): v is string => v !== null).length;
  const channelValues = events.flatMap(channelsOf).length;
  const horizonValues = events.map(horizonOf).filter((v): v is number => v !== null).length;

  return {
    kind,
    keyword,
    samples: {
      events: events.length,
      leadValues,
      timeValues,
      channelValues,
      horizonValues,
      tagLinks: tag.samples,
    },
    defaults: {
      reminderLeadDays: learnLeadDays(events),
      timeOfDay: learnTimeOfDay(events),
      channel: learnChannel(events),
      durationDays: learnDuration(events),
      tagHint: tag.learned,
    },
  };
}
