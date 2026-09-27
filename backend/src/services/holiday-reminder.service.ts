import { Solar } from 'lunar-javascript';
import { holidayName, isHoliday, isWorkday } from '@timemark/shared/chinese-days';

/**
 * 节假日感知提醒 + 节气提醒（checkbox 78）。
 *
 * 设计约定：
 * - **FAIL-OPEN**：`@timemark/shared/chinese-days` 对未收录年份（例如 2031）会抛
 *   `ChineseDaysError(OUT_OF_RANGE)`。这里是唯一调用点，并且每个调用都单独
 *   try/catch：日历缺口绝不会吞掉提醒 —— 出错时按「不是节假日 / 未知」处理，
 *   提醒仍然按原始排程发送（`keep` 语义）。
 * - **纯函数、无网络、无数据库**：只做日期换算与名称映射，便于被 tasks.ts 与单测复用。
 * - 非关键提醒才使用：medication / document 提醒明确不接入（见 tasks.ts 注释）。
 */

export type HolidayReminderMode = 'keep' | 'shift' | 'suppress';

export const HOLIDAY_REMINDER_MODES: readonly HolidayReminderMode[] = ['keep', 'shift', 'suppress'];

/** 24 节气（与 lunar-javascript `getJieQi()` 返回的中文名一一对应）。 */
export const JIEQI_NAMES = [
  '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑',
  '立秋', '处暑', '白露', '秋分', '寒露', '霜降',
  '立冬', '小雪', '大雪', '冬至', '小寒', '大寒',
] as const;

const YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 顺延从节假日向后最多找这些天；超过即视为无法求出（fail-open）。 */
const MAX_WORKDAY_LOOKAHEAD = 30;
/** 回看多少个日历日，找出「顺延到今天」的节假日源日。 */
const MAX_SOURCE_LOOKBACK = 14;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function isYmd(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = YMD_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const roundTrip = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    roundTrip.getUTCFullYear() === Number(y) &&
    roundTrip.getUTCMonth() === Number(m) - 1 &&
    roundTrip.getUTCDate() === Number(d)
  );
}

/** UTC 日历日加减，永远产出真实存在的 YYYY-MM-DD（不会出现 2 月 30 日）。 */
export function addDaysYmd(ymd: string, delta: number): string | null {
  if (!isYmd(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + delta));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/* ------------------------------------------------------------------ */
/* FAIL-OPEN 包装：日历数据缺失/未收录时返回 null，绝不抛出            */
/* ------------------------------------------------------------------ */

export function safeIsHoliday(ymd: string): boolean | null {
  try {
    return isHoliday(ymd);
  } catch {
    return null;
  }
}

export function safeIsWorkday(ymd: string): boolean | null {
  try {
    return isWorkday(ymd);
  } catch {
    return null;
  }
}

export function safeHolidayName(ymd: string): string | null {
  try {
    return holidayName(ymd);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 配置解析                                                            */
/* ------------------------------------------------------------------ */

/** `holiday_reminder_mode` → 三态；缺省/非法一律回落 `keep`（保持原时间）。 */
export function resolveHolidayMode(raw: unknown): HolidayReminderMode {
  if (typeof raw === 'string' && (HOLIDAY_REMINDER_MODES as readonly string[]).includes(raw)) {
    return raw as HolidayReminderMode;
  }
  return 'keep';
}

/** 解析 jieqi_reminder_list（JSONB 数组 / JSON 字符串），丢弃非 24 节气项并去重。 */
export function normalizeJieqiList(raw: unknown): string[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const selected = new Set(
    parsed
      .filter((item): item is string => typeof item === 'string')
      .filter((item) => (JIEQI_NAMES as readonly string[]).includes(item)),
  );
  // 按 24 节气的固定顺序返回，保证确定性
  return JIEQI_NAMES.filter((name) => selected.has(name));
}

/* ------------------------------------------------------------------ */
/* 节气                                                                */
/* ------------------------------------------------------------------ */

/** 该公历日是节气时返回节气名（24 之一），否则 null；库异常时 fail-open 返回 null。 */
export function jieqiOn(ymd: string): string | null {
  if (!isYmd(ymd)) return null;
  try {
    const [y, m, d] = ymd.split('-').map(Number);
    const name = Solar.fromYmd(y, m, d).getLunar().getJieQi();
    if (typeof name === 'string' && (JIEQI_NAMES as readonly string[]).includes(name)) {
      return name;
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 顺延：节假日的下一个工作日                                          */
/* ------------------------------------------------------------------ */

/**
 * `ymd` 之后第一个工作日（跳过周末，但把 调休 班 计入工作日）；无解/越界返回 null。
 * 仍使用工作日判定而非「跳过整个节假日块」，因为数据集同时提供 调休 班。
 */
export function nextWorkday(ymd: string): string | null {
  let cursor: string | null = ymd;
  for (let i = 0; i < MAX_WORKDAY_LOOKAHEAD; i++) {
    cursor = addDaysYmd(cursor as string, 1);
    if (!cursor) return null;
    const workday = safeIsWorkday(cursor);
    if (workday === null) return null; // 越界：无法可靠顺延 → fail-open
    if (workday) return cursor;
  }
  return null;
}

/**
 * 今天（工作日）应补发的节假日源日：过去 MAX_SOURCE_LOOKBACK 天内，其
 * `nextWorkday` 恰好等于今天的法定节假日。按日期降序（最近的在前）。
 * 用于「节假日期间的提醒顺延到节后第一个工作日」。
 */
export function shiftedHolidaySources(today: string): string[] {
  if (!isYmd(today)) return [];
  const sources: string[] = [];
  for (let i = 1; i <= MAX_SOURCE_LOOKBACK; i++) {
    const day = addDaysYmd(today, -i);
    if (!day) break;
    if (safeIsHoliday(day) !== true) continue;
    if (nextWorkday(day) === today) sources.push(day);
  }
  return sources; // 已按日期降序
}

/**
 * 本次派发应评估的日期序列（每个提醒取第一个命中，最多发一条）。
 * - `keep`：仅今天（默认：保留原时间，正文附节假日名）。
 * - `suppress`：今天是法定节假日 → 不发；否则今天。
 * - `shift`：今天是法定节假日 → 不发；今天是工作日 → 今天 +「顺延到今天」的节假日源日；
 *   其余（周末非节假日 / 日历未覆盖）→ 仅今天。
 */
export function resolveHolidayEvalDays(today: string, mode: HolidayReminderMode): string[] {
  if (!isYmd(today)) return [today];
  if (mode === 'keep') return [today];

  const holiday = safeIsHoliday(today);
  if (holiday === null) return [today]; // fail-open：日历不可用 → 原行为

  if (mode === 'suppress') return holiday ? [] : [today];

  // shift
  if (holiday) return [];
  const workday = safeIsWorkday(today);
  if (workday !== true) return [today];
  return [today, ...shiftedHolidaySources(today)];
}

/**
 * 附在通知正文里的节假日文案。
 * - 提醒按原定日发送且当天是节假日：`今日国庆节（法定假日）`
 * - 从节假日顺延到工作日发送：`法定假日「国庆节」顺延提醒`
 * - 非节假日：undefined
 */
export function holidayContextLabel(evalDay: string, today: string): string | undefined {
  if (evalDay === today) {
    const name = safeHolidayName(today);
    return name ? `今日${name}（法定假日）` : undefined;
  }
  const name = safeHolidayName(evalDay);
  return name ? `法定假日「${name}」顺延提醒` : '法定假日顺延提醒';
}
