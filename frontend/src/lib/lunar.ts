import { Lunar, Solar } from 'lunar-javascript';
import type { Event } from '@timemark/shared';
import { parseLunarDateParts } from '@timemark/shared/templates';
import { getHolidayCoverage } from './chinese-holidays';

export interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
}

const LUNAR_MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
const LUNAR_DAYS = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];

function monthDayText(month: number, day: number, isLeap: boolean): string {
  const monthName = LUNAR_MONTHS[month - 1];
  const dayName = LUNAR_DAYS[day - 1];
  if (!monthName || !dayName) return '';
  return `${isLeap ? '闰' : ''}${monthName}${dayName}`;
}

export function solarToLunar(date: Date): LunarDate {
  const solar = Solar.fromYmdHms(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    12, 0, 0
  );
  const lunar = solar.getLunar();
  const month = lunar.getMonth();
  return {
    year: lunar.getYear(),
    month: Math.abs(month),
    day: lunar.getDay(),
    isLeap: month < 0,
  };
}

export function lunarToSolar(lunar: LunarDate): Date {
  const month = lunar.isLeap ? -lunar.month : lunar.month;
  const lunarDate = Lunar.fromYmd(lunar.year, month, lunar.day);
  const solar = lunarDate.getSolar();
  return new Date(solar.getYear(), solar.getMonth() - 1, solar.getDay(), 12, 0, 0);
}

export function getNextLunarOccurrence(lunar: LunarDate): Date {
  const now = new Date();
  const currentYear = now.getFullYear();
  const month = lunar.isLeap ? -lunar.month : lunar.month;
  
  // 尝试今年的农历日期
  let lunarDate = Lunar.fromYmd(currentYear, month, lunar.day);
  let solar = lunarDate.getSolar();
  let targetDate = new Date(solar.getYear(), solar.getMonth() - 1, solar.getDay(), 12, 0, 0);
  
  // 如果今年的日期已过，使用明年的
  if (targetDate < now) {
    lunarDate = Lunar.fromYmd(currentYear + 1, month, lunar.day);
    solar = lunarDate.getSolar();
    targetDate = new Date(solar.getYear(), solar.getMonth() - 1, solar.getDay(), 12, 0, 0);
  }
  
  return targetDate;
}

/** 农历月日中文文本（`八月十五` / 闰月 `闰二月廿一`），不含「农历」前缀。 */
export function formatLunarMonthDay(lunar: LunarDate): string {
  return monthDayText(lunar.month, lunar.day, lunar.isLeap);
}

export function formatLunarDate(lunar: LunarDate): string {
  const monthDay = formatLunarMonthDay(lunar);
  return monthDay ? `${lunar.year}年${monthDay}` : String(lunar.year ?? '');
}

export interface EventLunarLabel {
  /** 展示用农历标签（`农历八月十五`）；无则为 ''。 */
  label: string;
  /** 明确的不可用原因（如年份越界）；正常为 null。 */
  error: string | null;
}

/**
 * 事件的农历展示标签（checkbox 169）。
 *
 * - 持久化的 `events.lunarDate` **原样读取**（闰月既支持 `isLeap`，也支持负数月份编码），
 *   绝不重算 —— 这是展示时唯一可信来源。
 * - 仅当 `lunarDate` 缺失且历法为农历/双历时，才用公历回推；回推受 vendored 日历的
 *   支持年份范围保护（`chinese-days` 仅覆盖 2004–2026，越界会抛
 *   `ChineseDaysError(OUT_OF_RANGE)`）。越界返回**明确错误文案**，绝不静默给出错误农历日期。
 * - 公历事件、或无效/缺失且无法回推时优雅降级为空标签。
 */
export function resolveEventLunarLabel(
  event: Pick<Event, 'lunarDate' | 'date' | 'calendarType'>,
): EventLunarLabel {
  if (event.calendarType !== 'lunar' && event.calendarType !== 'both') {
    return { label: '', error: null };
  }

  const persisted = parseLunarDateParts(event.lunarDate);
  if (persisted) {
    const monthDay = monthDayText(persisted.month, persisted.day, persisted.isLeap);
    if (monthDay) return { label: `农历${monthDay}`, error: null };
  }

  const ymd = String(event.date || '').slice(0, 10);
  const [year, month, day] = ymd.split('-').map(Number);
  if (
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
    month < 1 || month > 12 || day < 1 || day > 31
  ) {
    return { label: '', error: null };
  }

  const { minYear, maxYear } = getHolidayCoverage();
  if (year < minYear || year > maxYear) {
    return { label: '', error: `农历数据不可用（仅支持 ${minYear}–${maxYear} 年）` };
  }

  try {
    const lunar = solarToLunar(new Date(year, month - 1, day, 12, 0, 0));
    const monthDay = formatLunarMonthDay(lunar);
    return monthDay ? { label: `农历${monthDay}`, error: null } : { label: '', error: '农历数据不可用' };
  } catch {
    return { label: '', error: '农历数据不可用' };
  }
}
