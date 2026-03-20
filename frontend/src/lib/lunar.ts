import { Lunar, Solar } from 'lunar-javascript';

export interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
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

export function formatLunarDate(lunar: LunarDate): string {
  const months = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
  const days = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
    '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
    '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
  
  const monthStr = lunar.isLeap ? `闰${months[lunar.month - 1]}` : months[lunar.month - 1];
  const dayStr = days[lunar.day - 1];
  
  return `${lunar.year}年${monthStr}${dayStr}`;
}
