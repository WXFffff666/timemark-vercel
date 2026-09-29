import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAlmanac,
  getBazi,
  getConstellationCompatibility,
  getRitualExtras,
  getZodiacCompatibility,
  searchAuspiciousDays,
} from './almanac';
import { stubThrowingGetDayYi } from '../test/throwing-lunar';

/**
 * Pinned golden values (plan todo 77) for three fixed dates:
 *   1. 2025-10-08 — 寒露, a 节气 day
 *   2. 2023-03-22 — 闰二月初一 (leap-month boundary)
 *   3. 2025-01-29 — 春节 (正月初一)
 * Values are computed by the pinned lunar-javascript (^1.7.7) and cross-checked
 * against the well-known facts (寒露 date, 2023 闰二月 starting 3/22, 蛇年春节).
 */

const YI_2025_10_08 = ['祭祀', '出行', '裁衣', '冠笄', '会亲友', '造畜稠', '嫁娶', '竖柱', '上梁', '移徙', '纳财', '纳畜'];
const JI_2025_10_08 = ['动土', '伐木', '作梁', '行丧', '安葬', '开生坟'];
const YI_2023_03_22 = ['祭祀', '出行', '嫁娶', '冠笄', '安床', '入殓', '移柩', '安葬'];
const JI_2023_03_22 = ['掘井', '动土', '作灶', '栽种'];
const YI_2025_01_29 = ['祭祀', '斋醮', '纳财', '捕捉', '畋猎'];
const JI_2025_01_29 = ['嫁娶', '开市', '入宅', '安床', '破土', '安葬'];

describe('almanac: pinned dates (plan todo 77)', () => {
  it('pins the 节气 day 2025-10-08 (寒露)', () => {
    const almanac = getAlmanac('2025-10-08');
    expect(almanac).toMatchObject({
      date: '2025-10-08',
      lunarText: '二〇二五年八月十七',
      ganZhi: { year: '乙巳', month: '丙戌', day: '庚戌' },
      zodiac: '蛇',
      constellation: '天秤',
      jieQi: '寒露',
      isJieQi: true,
      nextJieQi: { name: '霜降', date: '2025-10-23' },
      zhiXing: '建',
      chong: '(甲辰)龙',
      sha: '北',
      incompleteFields: [],
    });
    expect(almanac.lunar).toEqual({ year: 2025, month: 8, day: 17, isLeapMonth: false });
    expect(almanac.yi).toEqual(YI_2025_10_08);
    expect(almanac.ji).toEqual(JI_2025_10_08);
    expect(almanac.positions).toEqual([
      { name: '喜神', direction: '西北' },
      { name: '财神', direction: '正东' },
      { name: '福神', direction: '西南' },
    ]);
  });

  it('pins the 闰月 boundary 2023-03-22 (闰二月初一)', () => {
    const almanac = getAlmanac(new Date(2023, 2, 22));
    expect(almanac).toMatchObject({
      lunarText: '二〇二三年闰二月初一',
      lunar: { year: 2023, month: 2, day: 1, isLeapMonth: true },
      ganZhi: { year: '癸卯', month: '乙卯', day: '己卯' },
      zodiac: '兔',
      constellation: '白羊',
      jieQi: null,
      isJieQi: false,
      nextJieQi: { name: '清明', date: '2023-04-05' },
      zhiXing: '建',
      incompleteFields: [],
    });
    expect(almanac.yi).toEqual(YI_2023_03_22);
    expect(almanac.ji).toEqual(JI_2023_03_22);
  });

  it('pins the Spring Festival 2025-01-29 (正月初一)', () => {
    const almanac = getAlmanac('2025-01-29');
    expect(almanac).toMatchObject({
      lunarText: '二〇二五年正月初一',
      lunar: { year: 2025, month: 1, day: 1, isLeapMonth: false },
      ganZhi: { year: '乙巳', month: '丁丑', day: '戊戌' },
      zodiac: '蛇',
      constellation: '水瓶',
      jieQi: null,
      isJieQi: false,
      nextJieQi: { name: '立春', date: '2025-02-03' },
      zhiXing: '收',
      incompleteFields: [],
    });
    expect(almanac.yi).toEqual(YI_2025_01_29);
    expect(almanac.ji).toEqual(JI_2025_01_29);
  });
});

describe('almanac: degradation (todo 77 failure scenario)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a library field that throws yields a PARTIAL result with the field listed', () => {
    stubThrowingGetDayYi();

    const almanac = getAlmanac('2025-10-08');
    expect(almanac.yi).toEqual([]);
    expect(almanac.incompleteFields).toContain('yi');
    // Every other field still resolves.
    expect(almanac.lunarText).toBe('二〇二五年八月十七');
    expect(almanac.ganZhi.day).toBe('庚戌');
    expect(almanac.ji).toEqual(JI_2025_10_08);
    expect(almanac.jieQi).toBe('寒露');
  });

  it('an unparseable date key degrades without throwing', () => {
    const almanac = getAlmanac('not-a-date');
    expect(almanac.date).toBe('not-a-date');
    expect(almanac.lunarText).toBeNull();
    expect(almanac.yi).toEqual([]);
    expect(almanac.incompleteFields).toContain('solar');
  });

  it('an impossible calendar date (2025-02-29) degrades instead of rolling over to March', () => {
    const almanac = getAlmanac('2025-02-29');
    expect(almanac.date).toBe('2025-02-29');
    expect(almanac.lunarText).toBeNull();
    expect(almanac.incompleteFields).toContain('solar');
  });
});

describe('almanac: 八字/五行 pinned pillars (plan todo 150)', () => {
  /**
   * Independently verifiable pin for 2000-01-15 08:30:
   *   - 年柱 己卯: the birth is BEFORE 立春 (2000-02-04), so the 干支 year is the
   *     previous one — 1999 is 己卯. (己 = 土, 卯 = 木)
   *   - 月柱 丁丑: 小寒 (Jan 6) ≤ Jan 15 < 立春, so the solar month branch is 丑;
   *     己卯年的丑月干 is 丁. (丁 = 火, 丑 = 土)
   *   - 日柱 壬申: the 60-day 干支 cycle for Gregorian 2000-01-15 is 壬申. (壬 = 水, 申 = 金)
   *   - 时柱 甲辰: 08:30 falls in 辰时 (07:00–09:00); 五鼠遁 from a 壬 day:
   *     子=庚, 丑=辛, 寅=壬, 卯=癸, 辰=甲 → 甲辰. (甲 = 木, 辰 = 土)
   *
   * Expected values are hard-coded here so the test does not read them back from
   * the library at runtime.
   */
  it('pins 2000-01-15 08:30 to 己卯 丁丑 壬申 甲辰', () => {
    const { bazi, error } = getBazi('2000-01-15 08:30');
    expect(error).toBeNull();
    expect(bazi).not.toBeNull();
    expect(bazi).toMatchObject({
      dayMaster: '壬',
      year: { ganZhi: '己卯', gan: '己', zhi: '卯', wuXing: '土木' },
      month: { ganZhi: '丁丑', gan: '丁', zhi: '丑', wuXing: '火土' },
      day: { ganZhi: '壬申', gan: '壬', zhi: '申', wuXing: '水金' },
      hour: { ganZhi: '甲辰', gan: '甲', zhi: '辰', wuXing: '木土' },
    });
    expect(bazi?.wuXingCounts).toEqual({ 金: 1, 木: 2, 水: 1, 火: 1, 土: 3 });
  });

  it('accepts the ISO-T form and rejects a malformed birth input with a message (no NaN)', () => {
    expect(getBazi('2000-01-15T08:30').bazi?.hour.ganZhi).toBe('甲辰');

    const bad = getBazi('2000-13-40 99:99');
    expect(bad.bazi).toBeNull();
    expect(bad.error).toBeTruthy();
    expect(bad.error).not.toContain('NaN');

    const garbage = getBazi('not-a-date');
    expect(garbage.bazi).toBeNull();
    expect(garbage.error).toBe('出生时间格式无效，请使用 YYYY-MM-DD HH:mm');

    const impossible = getBazi('2025-02-29 12:00');
    expect(impossible.bazi).toBeNull();
    expect(impossible.error).toBe('出生日期不存在');
  });
});

describe('almanac: 黄道吉日 search (plan todo 150)', () => {
  /**
   * 2025-10-01 .. 2025-10-10 的 宜 含「嫁娶」的日子（pinned lunar-javascript 1.7.7，
   * cross-checked against todo-77's YI table for 2025-10-08 which lists 嫁娶）。
   */
  it('returns the pinned 嫁娶 dates for 2025-10-01..2025-10-10', () => {
    const result = searchAuspiciousDays('2025-10-01', '2025-10-10', '嫁娶');
    expect(result.error).toBeNull();
    expect(result.scanned).toBe(10);
    expect(result.results.map((day) => day.date)).toEqual(['2025-10-02', '2025-10-03', '2025-10-08']);
    expect(result.results[2]).toMatchObject({ ganZhiDay: '庚戌', lunarText: '二〇二五年八月十七' });
    expect(result.results[2].yi).toContain('嫁娶');
  });

  it('returns the pinned 开市 dates for 2025-01-01..2025-01-15', () => {
    const result = searchAuspiciousDays('2025-01-01', '2025-01-15', '开市');
    expect(result.error).toBeNull();
    expect(result.results.map((day) => day.date)).toEqual(['2025-01-06', '2025-01-09', '2025-01-10', '2025-01-15']);
  });

  it('rejects an unsupported purpose, a reversed range, an invalid key and an over-long span', () => {
    expect(searchAuspiciousDays('2025-10-01', '2025-10-10', '祈福').error).toContain('不支持的用途');
    expect(searchAuspiciousDays('2025-10-10', '2025-10-01', '嫁娶').error).toBe('开始日期不能晚于结束日期');
    expect(searchAuspiciousDays('nope', '2025-10-10', '嫁娶').error).toContain('日期范围无效');
    expect(searchAuspiciousDays('2025-01-01', '2026-01-05', '嫁娶').error).toContain('不能超过');
  });
});

describe('almanac: 生肖 / 星座 pairing summaries (plan todo 150)', () => {
  it('pins the 蛇 pairing summary', () => {
    expect(getZodiacCompatibility('蛇')).toEqual({
      kind: '生肖',
      subject: '蛇',
      element: null,
      allies: ['猴', '牛', '鸡'],
      clashes: ['猪'],
      note: '六合 猴 · 三合 牛、鸡',
    });
  });

  it('pins the 天秤 pairing summary and returns null for an unknown sign', () => {
    expect(getConstellationCompatibility('天秤')).toMatchObject({
      kind: '星座',
      subject: '天秤',
      element: '风象',
      clashes: [],
      allies: ['白羊', '狮子', '射手', '双子', '水瓶'],
    });
    expect(getConstellationCompatibility('蛇夫')).toBeNull();
    expect(getZodiacCompatibility('猫')).toBeNull();
  });
});

describe('almanac: 彭祖百忌 / 吉神宜趋 pinned + degradation (plan todo 150)', () => {
  it('pins the 2025-10-08 彭祖百忌 and 吉神/凶煞 lists', () => {
    const extras = getRitualExtras('2025-10-08');
    expect(extras.error).toBeNull();
    expect(extras).toMatchObject({
      pengZuGan: '庚不经络织机虚张',
      pengZuZhi: '戌不吃犬作怪上床',
      jiShen: ['天恩', '母仓', '月德', '守日', '天马'],
      xiongSha: ['月建', '小时', '土府', '白虎', '阳错'],
      incompleteFields: [],
    });
  });

  it('degrades an out-of-range year and an invalid key to 数据不可用 instead of throwing', () => {
    const old = getRitualExtras('1800-01-01');
    expect(old.error).toBe('数据不可用（仅支持 1900–2100 年）');
    expect(old.pengZuGan).toBeNull();
    expect(old.jiShen).toEqual([]);

    const invalid = getRitualExtras('2025-02-29');
    expect(invalid.error).toContain('日期无效');

    const search = searchAuspiciousDays('1800-01-01', '1800-01-31', '嫁娶');
    expect(search.error).toBe('数据不可用（仅支持 1900–2100 年）');
    expect(search.results).toEqual([]);
  });

  it('degrades an out-of-range birth year to a message, not a throw', () => {
    const result = getBazi('1800-01-15 08:30');
    expect(result.bazi).toBeNull();
    expect(result.error).toBe('数据不可用（仅支持 1900–2100 年）');
  });
});
