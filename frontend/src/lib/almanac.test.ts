import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAlmanac } from './almanac';
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
