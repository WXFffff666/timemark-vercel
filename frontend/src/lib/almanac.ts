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

/* ------------------------------------------------------------------------- *
 * Todo 150 — advanced almanac panels.
 *
 * Depth on top of the todo-77 helpers: 择日 (黄道吉日 search), 八字/五行, 生肖
 * and 星座 pairing summaries, and the 彭祖百忌 / 吉神宜趋 / 吉神方位 fields the
 * pinned `lunar-javascript` (^1.7.7) exposes. NO new dependency.
 *
 * Contract: every public function here is total — a bad input, an unsupported
 * purpose or an out-of-range year returns a `error` string (and empty data)
 * rather than throwing, so one broken field never takes down the panel.
 *
 * Date discipline (see `.omo/notepads/timemark-vercel-expansion/issues.md`):
 * a calendar day is ALWAYS taken from LOCAL date components via
 * `formatAlmanacDateKey` / `parseDateKey` — never sliced out of a UTC ISO
 * string. A `year` means the user's local year.
 *
 * 传统文化参考，非决策建议：these are informational lookups, not advice and not
 * a prediction.
 * ------------------------------------------------------------------------- */

/** Supported civic-year window for the panels. Outside it we degrade to 数据不可用. */
export const ALMANAC_MIN_YEAR = 1900;
export const ALMANAC_MAX_YEAR = 2100;

/** The four 择日 purposes the search understands. */
export const ALMANAC_PURPOSES = ['嫁娶', '出行', '开市', '动土'] as const;
export type AlmanacPurpose = (typeof ALMANAC_PURPOSES)[number];

const UNSUPPORTED_YEAR_MESSAGE = `数据不可用（仅支持 ${ALMANAC_MIN_YEAR}–${ALMANAC_MAX_YEAR} 年）`;

function yearInSupportedRange(year: number): boolean {
  return Number.isInteger(year) && year >= ALMANAC_MIN_YEAR && year <= ALMANAC_MAX_YEAR;
}

export interface AlmanacAuspiciousDay {
  date: string;
  lunarText: string | null;
  ganZhiDay: string | null;
  yi: string[];
}

export interface AlmanacAuspiciousResult {
  purpose: AlmanacPurpose | null;
  results: AlmanacAuspiciousDay[];
  scanned: number;
  error: string | null;
}

/** Upper bound on a 择日 scan so a typo cannot walk a century. */
export const ALMANAC_MAX_SEARCH_DAYS = 366;

/**
 * 黄道吉日 search: every day in [startKey, endKey] whose 宜 list contains the
 * requested purpose. `lunar.javascript` `getDayYi()` is the single source of the
 * per-day 宜 list — nothing is re-derived here.
 */
export function searchAuspiciousDays(startKey: string, endKey: string, purpose: string): AlmanacAuspiciousResult {
  if (!(ALMANAC_PURPOSES as readonly string[]).includes(purpose)) {
    return { purpose: null, results: [], scanned: 0, error: `不支持的用途「${purpose}」` };
  }
  const resolvedPurpose = purpose as AlmanacPurpose;
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  if (!start || !end) {
    return { purpose: resolvedPurpose, results: [], scanned: 0, error: '日期范围无效（格式 YYYY-MM-DD）' };
  }
  if (!yearInSupportedRange(start.getFullYear()) || !yearInSupportedRange(end.getFullYear())) {
    return { purpose: resolvedPurpose, results: [], scanned: 0, error: UNSUPPORTED_YEAR_MESSAGE };
  }
  if (start.getTime() > end.getTime()) {
    return { purpose: resolvedPurpose, results: [], scanned: 0, error: '开始日期不能晚于结束日期' };
  }
  const span = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (span + 1 > ALMANAC_MAX_SEARCH_DAYS) {
    return {
      purpose: resolvedPurpose,
      results: [],
      scanned: 0,
      error: `查询范围不能超过 ${ALMANAC_MAX_SEARCH_DAYS} 天`,
    };
  }

  const results: AlmanacAuspiciousDay[] = [];
  let scanned = 0;
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12, 0, 0);
  for (let offset = 0; offset <= span; offset += 1) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;
    const day = cursor.getDate();
    scanned += 1;
    try {
      const lunar = Solar.fromYmdHms(year, month, day, 12, 0, 0).getLunar();
      const yi = lunar.getDayYi();
      if (yi.includes(resolvedPurpose)) {
        results.push({
          date: formatAlmanacDateKey(cursor),
          lunarText: lunar.toString(),
          ganZhiDay: lunar.getDayInGanZhi(),
          yi,
        });
      }
    } catch {
      // A single unresolvable day is skipped; the rest of the range still returns.
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return { purpose: resolvedPurpose, results, scanned, error: null };
}

export interface AlmanacBaziPillar {
  ganZhi: string;
  gan: string;
  zhi: string;
  wuXing: string;
}

export type AlmanacWuXingElement = '金' | '木' | '水' | '火' | '土';

export const ALMANAC_WU_XING: readonly AlmanacWuXingElement[] = ['金', '木', '水', '火', '土'];

export interface AlmanacBazi {
  year: AlmanacBaziPillar;
  month: AlmanacBaziPillar;
  day: AlmanacBaziPillar;
  hour: AlmanacBaziPillar;
  /** 日主 (the day pillar's 天干). */
  dayMaster: string;
  /** Count of each 五行 across the 8 characters (2 per pillar). */
  wuXingCounts: Record<AlmanacWuXingElement, number>;
}

export interface AlmanacBaziResult {
  bazi: AlmanacBazi | null;
  error: string | null;
}

const BIRTH_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/;

function countWuXing(pillars: AlmanacBaziPillar[]): Record<AlmanacWuXingElement, number> {
  const counts: Record<AlmanacWuXingElement, number> = { 金: 0, 木: 0, 水: 0, 火: 0, 土: 0 };
  for (const pillar of pillars) {
    for (const char of pillar.wuXing) {
      if ((ALMANAC_WU_XING as readonly string[]).includes(char)) {
        counts[char as AlmanacWuXingElement] += 1;
      }
    }
  }
  return counts;
}

/**
 * 八字 / 五行 for a birth datetime. The input must be an explicit civil
 * `YYYY-MM-DD HH:mm` (or `YYYY-MM-DDTHH:mm`) — a malformed value is rejected
 * with a message, never coerced into NaN. The 时柱 uses the supplied local wall
 * clock hour, exactly as a 排盘 does.
 */
export function getBazi(birth: string): AlmanacBaziResult {
  const match = BIRTH_PATTERN.exec(birth.trim());
  if (!match) {
    return { bazi: null, error: '出生时间格式无效，请使用 YYYY-MM-DD HH:mm' };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!yearInSupportedRange(year)) {
    return { bazi: null, error: UNSUPPORTED_YEAR_MESSAGE };
  }
  if (month < 1 || month > 12 || hour > 23 || minute > 59) {
    return { bazi: null, error: '出生时间超出有效范围' };
  }
  const roundTrip = new Date(year, month - 1, day, 12, 0, 0);
  if (roundTrip.getFullYear() !== year || roundTrip.getMonth() !== month - 1 || roundTrip.getDate() !== day) {
    return { bazi: null, error: '出生日期不存在' };
  }
  try {
    const eight = Solar.fromYmdHms(year, month, day, hour, minute, 0).getLunar().getEightChar();
    const yearPillar: AlmanacBaziPillar = {
      ganZhi: eight.getYear(),
      gan: eight.getYearGan(),
      zhi: eight.getYearZhi(),
      wuXing: eight.getYearWuXing(),
    };
    const monthPillar: AlmanacBaziPillar = {
      ganZhi: eight.getMonth(),
      gan: eight.getMonthGan(),
      zhi: eight.getMonthZhi(),
      wuXing: eight.getMonthWuXing(),
    };
    const dayPillar: AlmanacBaziPillar = {
      ganZhi: eight.getDay(),
      gan: eight.getDayGan(),
      zhi: eight.getDayZhi(),
      wuXing: eight.getDayWuXing(),
    };
    const hourPillar: AlmanacBaziPillar = {
      ganZhi: eight.getTime(),
      gan: eight.getTimeGan(),
      zhi: eight.getTimeZhi(),
      wuXing: eight.getTimeWuXing(),
    };
    return {
      bazi: {
        year: yearPillar,
        month: monthPillar,
        day: dayPillar,
        hour: hourPillar,
        dayMaster: eight.getDayGan(),
        wuXingCounts: countWuXing([yearPillar, monthPillar, dayPillar, hourPillar]),
      },
      error: null,
    };
  } catch {
    return { bazi: null, error: '数据不可用' };
  }
}

export interface AlmanacCompatibility {
  kind: '生肖' | '星座';
  subject: string;
  element: string | null;
  allies: string[];
  clashes: string[];
  note: string;
}

/** 生肖六合 (secret friend). */
const ZODIAC_LIU_HE: Record<string, string> = {
  鼠: '牛',
  牛: '鼠',
  虎: '猪',
  猪: '虎',
  兔: '狗',
  狗: '兔',
  龙: '鸡',
  鸡: '龙',
  蛇: '猴',
  猴: '蛇',
  马: '羊',
  羊: '马',
};

/** 生肖三合 (trine group members, excluding the subject). */
const ZODIAC_SAN_HE: Record<string, string[]> = {
  鼠: ['龙', '猴'],
  龙: ['鼠', '猴'],
  猴: ['鼠', '龙'],
  牛: ['蛇', '鸡'],
  蛇: ['牛', '鸡'],
  鸡: ['牛', '蛇'],
  虎: ['马', '狗'],
  马: ['虎', '狗'],
  狗: ['虎', '马'],
  兔: ['猪', '羊'],
  猪: ['兔', '羊'],
  羊: ['兔', '猪'],
};

/** 生肖相冲 (clash). */
const ZODIAC_CHONG: Record<string, string> = {
  鼠: '马',
  马: '鼠',
  牛: '羊',
  羊: '牛',
  虎: '猴',
  猴: '虎',
  兔: '鸡',
  鸡: '兔',
  龙: '狗',
  狗: '龙',
  蛇: '猪',
  猪: '蛇',
};

/**
 * 生肖 pairing summary. Returns null for an unknown animal so the caller can
 * render a graceful "—" instead of inventing an answer.
 */
export function getZodiacCompatibility(zodiac: string): AlmanacCompatibility | null {
  const liuHe = ZODIAC_LIU_HE[zodiac];
  if (!liuHe) return null;
  const sanHe = ZODIAC_SAN_HE[zodiac] ?? [];
  const chong = ZODIAC_CHONG[zodiac];
  return {
    kind: '生肖',
    subject: zodiac,
    element: null,
    allies: [liuHe, ...sanHe],
    clashes: chong ? [chong] : [],
    note: `六合 ${liuHe} · 三合 ${sanHe.join('、') || '—'}`,
  };
}

interface ConstellationGroup {
  element: string;
  signs: string[];
}

const CONSTELLATION_ELEMENTS: Record<string, ConstellationGroup> = {
  火象: { element: '火象', signs: ['白羊', '狮子', '射手'] },
  土象: { element: '土象', signs: ['金牛', '处女', '摩羯'] },
  风象: { element: '风象', signs: ['双子', '天秤', '水瓶'] },
  水象: { element: '水象', signs: ['巨蟹', '天蝎', '双鱼'] },
};

/** Complementary (相生相扶) 星象元素: 火↔风, 土↔水. */
const CONSTELLATION_COMPLEMENT: Record<string, string> = {
  火象: '风象',
  风象: '火象',
  土象: '水象',
  水象: '土象',
};

/**
 * 星座 pairing summary: same-element and complementary-element signs are the
 * traditional "聊得来" set. Returns null for an unknown sign name.
 */
export function getConstellationCompatibility(constellation: string): AlmanacCompatibility | null {
  const group = Object.values(CONSTELLATION_ELEMENTS).find((candidate) => candidate.signs.includes(constellation));
  if (!group) return null;
  const sameElement = group.signs.filter((sign) => sign !== constellation);
  const complementarySigns = CONSTELLATION_ELEMENTS[CONSTELLATION_COMPLEMENT[group.element]]?.signs ?? [];
  return {
    kind: '星座',
    subject: constellation,
    element: group.element,
    allies: [...complementarySigns, ...sameElement],
    clashes: [],
    note: `${group.element}星座；同元素与互补元素相处更融洽`,
  };
}

export interface AlmanacRitualExtras {
  pengZuGan: string | null;
  pengZuZhi: string | null;
  jiShen: string[];
  xiongSha: string[];
  incompleteFields: string[];
  error: string | null;
}

/**
 * 彭祖百忌 (gan/zhi) + 吉神宜趋 / 凶煞宜忌 for a date. 吉神方位 (喜神/财神/福神)
 * is already part of `getAlmanac().positions` and is intentionally not duplicated
 * here. Out-of-range years and unparseable keys degrade to an `error` string.
 */
export function getRitualExtras(date: Date | string): AlmanacRitualExtras {
  const empty: AlmanacRitualExtras = {
    pengZuGan: null,
    pengZuZhi: null,
    jiShen: [],
    xiongSha: [],
    incompleteFields: [],
    error: null,
  };
  const resolved = typeof date === 'string' ? parseDateKey(date) : date;
  if (!resolved) {
    return { ...empty, incompleteFields: ['date'], error: '日期无效（格式 YYYY-MM-DD）' };
  }
  const year = resolved.getFullYear();
  if (!yearInSupportedRange(year)) {
    return { ...empty, error: UNSUPPORTED_YEAR_MESSAGE };
  }
  let lunar: Lunar | null = null;
  try {
    lunar = Solar.fromYmdHms(year, resolved.getMonth() + 1, resolved.getDate(), 12, 0, 0).getLunar();
  } catch {
    return { ...empty, error: '数据不可用' };
  }

  const incomplete = new Set<string>();
  const read = <T>(field: string, fallback: T, fn: (value: Lunar) => T): T => {
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

  return {
    pengZuGan: read<string | null>('pengZuGan', null, (l) => l.getPengZuGan() || null),
    pengZuZhi: read<string | null>('pengZuZhi', null, (l) => l.getPengZuZhi() || null),
    jiShen: read<string[]>('jiShen', [], (l) => l.getDayJiShen()),
    xiongSha: read<string[]>('xiongSha', [], (l) => l.getDayXiongSha()),
    incompleteFields: [...incomplete].sort(),
    error: null,
  };
}
