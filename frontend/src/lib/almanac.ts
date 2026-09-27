import { Solar, type Lunar } from 'lunar-javascript';

/**
 * 黄历 / 节气 / 生肖 / 星座 computed locally with the already-installed
 * `lunar-javascript` (plan todo 77). No network calls, no new dependency.
 *
 * Degradation contract: EVERY library call is individually wrapped, so a gap in
 * the library (or a corrupted input) yields a PARTIAL card — the failed field is
 * null/[] and its name is listed in `incompleteFields`, while every other field
 * still renders. `数据不完整` is surfaced by the UI from that list.
 */

export interface AlmanacLunarDate {
  year: number;
  month: number;
  day: number;
  isLeapMonth: boolean;
}

export interface AlmanacJieQi {
  name: string;
  date: string;
}

export interface AlmanacPosition {
  name: string;
  direction: string | null;
}

export interface AlmanacData {
  date: string;
  lunarText: string | null;
  lunar: AlmanacLunarDate | null;
  ganZhi: { year: string | null; month: string | null; day: string | null };
  zodiac: string | null;
  constellation: string | null;
  jieQi: string | null;
  isJieQi: boolean;
  nextJieQi: AlmanacJieQi | null;
  yi: string[];
  ji: string[];
  zhiXing: string | null;
  chong: string | null;
  sha: string | null;
  positions: AlmanacPosition[];
  incompleteFields: string[];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatAlmanacDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDateKey(dateKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day, 12, 0, 0);
  // Reject impossible dates (e.g. 2025-02-29) instead of silently rolling over.
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  return parsed;
}

/**
 * @param date Date instance or `YYYY-MM-DD` key (local calendar components).
 */
export function getAlmanac(date: Date | string): AlmanacData {
  const incomplete = new Set<string>();
  const resolved = typeof date === 'string' ? parseDateKey(date) : date;
  const dateKey = resolved ? formatAlmanacDateKey(resolved) : String(date);

  let lunar: Lunar | null = null;
  const solar = (() => {
    if (!resolved) {
      incomplete.add('solar');
      return null;
    }
    try {
      return Solar.fromYmdHms(resolved.getFullYear(), resolved.getMonth() + 1, resolved.getDate(), 12, 0, 0);
    } catch {
      incomplete.add('solar');
      return null;
    }
  })();
  if (solar) {
    try {
      lunar = solar.getLunar();
    } catch {
      incomplete.add('lunar');
    }
  } else {
    incomplete.add('lunar');
  }

  const fromLunar = <T>(field: string, fallback: T, fn: (lunarDate: Lunar) => T): T => {
    if (!lunar) {
      incomplete.add(field);
      return fallback;
    }
    try {
      return fn(lunar);
    } catch {
      incomplete.add(field);
      return fallback;
    }
  };

  const fromSolar = <T>(field: string, fallback: T, fn: (solarDate: Solar) => T): T => {
    if (!solar) {
      incomplete.add(field);
      return fallback;
    }
    try {
      return fn(solar);
    } catch {
      incomplete.add(field);
      return fallback;
    }
  };

  const month = fromLunar<number | null>('month', null, (l) => l.getMonth());
  const year = fromLunar<number | null>('year', null, (l) => l.getYear());
  const day = fromLunar<number | null>('day', null, (l) => l.getDay());
  const lunarDate: AlmanacLunarDate | null =
    month !== null && year !== null && day !== null
      ? { year, month: Math.abs(month), day, isLeapMonth: month < 0 }
      : null;

  const nextJieQi = fromLunar<AlmanacJieQi | null>('nextJieQi', null, (l) => {
    const next = l.getNextJieQi();
    return { name: next.getName(), date: next.getSolar().toYmd() };
  });

  const jieQiRaw = fromLunar<string | null>('jieQi', null, (l) => l.getJieQi() || null);

  return {
    date: dateKey,
    lunarText: fromLunar<string | null>('lunarText', null, (l) => l.toString()),
    lunar: lunarDate,
    ganZhi: {
      year: fromLunar<string | null>('ganZhiYear', null, (l) => l.getYearInGanZhi()),
      month: fromLunar<string | null>('ganZhiMonth', null, (l) => l.getMonthInGanZhi()),
      day: fromLunar<string | null>('ganZhiDay', null, (l) => l.getDayInGanZhi()),
    },
    zodiac: fromLunar<string | null>('zodiac', null, (l) => l.getYearShengXiao()),
    constellation: fromSolar<string | null>('constellation', null, (s) => s.getXingZuo()),
    jieQi: jieQiRaw,
    isJieQi: Boolean(jieQiRaw),
    nextJieQi,
    yi: fromLunar<string[]>('yi', [], (l) => l.getDayYi()),
    ji: fromLunar<string[]>('ji', [], (l) => l.getDayJi()),
    zhiXing: fromLunar<string | null>('zhiXing', null, (l) => l.getZhiXing()),
    chong: fromLunar<string | null>('chong', null, (l) => l.getDayChongDesc()),
    sha: fromLunar<string | null>('sha', null, (l) => l.getDaySha()),
    positions: [
      {
        name: '喜神',
        direction: fromLunar<string | null>('positionXi', null, (l) => l.getDayPositionXiDesc()),
      },
      {
        name: '财神',
        direction: fromLunar<string | null>('positionCai', null, (l) => l.getDayPositionCaiDesc()),
      },
      {
        name: '福神',
        direction: fromLunar<string | null>('positionFu', null, (l) => l.getDayPositionFuDesc()),
      },
    ],
    incompleteFields: [...incomplete].sort(),
  };
}
