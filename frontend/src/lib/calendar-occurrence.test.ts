import { describe, expect, it } from 'vitest'
import { getEventOccurrenceDatesInYear, groupEventsByOccurrence } from './calendar-utils'
import type { Event } from '@timemark/shared'

/**
 * v2.31 R4（审计 D2）：日历落位口径修复——重复/农历事件在发生年份的网格必须可见。
 * 此前按原始 date 落位，生日 1990-07-28 在 2026 年 7 月永远查不到。
 */

function makeEvent(overrides: Partial<Event> & { date: string }): Event {
  return {
    id: '1',
    name: '测试',
    type: 'other',
    calendarType: 'gregorian',
    reminderConfig: { enabled: false, daysBeforeList: [], emailRecipients: [] },
    ...overrides,
  } as Event
}

describe('getEventOccurrenceDatesInYear（落位口径）', () => {
  it('一次性公历事件：任何年份都按原始日期落位（历史保留）', () => {
    const e = makeEvent({ date: '2024-10-01' })
    expect(getEventOccurrenceDatesInYear(e, 2026)).toEqual(['2024-10-01'])
    expect(getEventOccurrenceDatesInYear(e, 2024)).toEqual(['2024-10-01'])
  })

  it('yearly 重复：月-日滚动到目标年（审计主案例：1990-07-28 → 2026-07-28）', () => {
    const e = makeEvent({
      date: '1990-07-28',
      type: 'birthday',
      recurringConfig: { enabled: true, frequency: 'yearly', interval: 1, endType: 'never' },
    })
    expect(getEventOccurrenceDatesInYear(e, 2026)).toEqual(['2026-07-28'])
    expect(getEventOccurrenceDatesInYear(e, 1990)).toEqual(['1990-07-28'])
  })

  it('02-29 生日在平年无落位、闰年落位（不虚构 03-01，也不回退 2000 年原始日期）', () => {
    const e = makeEvent({
      date: '2000-02-29',
      type: 'birthday',
      recurringConfig: { enabled: true, frequency: 'yearly', interval: 1, endType: 'never' },
    })
    expect(getEventOccurrenceDatesInYear(e, 2026)).toEqual([])
    expect(getEventOccurrenceDatesInYear(e, 2028)).toEqual(['2028-02-29'])
  })

  it('monthly 重复：逐月落位且 clamp 到月末（31 号在 4 月落 04-30）', () => {
    const e = makeEvent({
      date: '2025-01-31',
      type: 'meeting',
      recurringConfig: { enabled: true, frequency: 'monthly', interval: 1, endType: 'never' },
    })
    const dates = getEventOccurrenceDatesInYear(e, 2026)
    expect(dates).toContain('2026-04-30')
    expect(dates).toContain('2026-01-31')
    expect(dates).toHaveLength(12)
  })

  it('未启用重复的生日不滚动（数据语义：recurring 关闭 = 一次性）', () => {
    const e = makeEvent({ date: '1990-07-28', type: 'birthday' })
    expect(getEventOccurrenceDatesInYear(e, 2026)).toEqual(['1990-07-28'])
  })

  it('weekly 重复：按锚点星期与 interval 在年内展开（每 2 周一次）', () => {
    // 2026-01-05 是周一；每周重复 → 全年每个周一
    const weekly = makeEvent({
      date: '2026-01-05',
      type: 'meeting',
      recurringConfig: { enabled: true, frequency: 'weekly', interval: 1, endType: 'never' },
    })
    const dates = getEventOccurrenceDatesInYear(weekly, 2026)
    expect(dates.length).toBeGreaterThanOrEqual(52)
    // 全部都是周一
    for (const d of dates) {
      expect(new Date(`${d}T00:00:00Z`).getUTCDay()).toBe(1)
    }
    // 每 2 周一次：约 26 个
    const biweekly = makeEvent({
      date: '2026-01-05',
      type: 'meeting',
      recurringConfig: { enabled: true, frequency: 'weekly', interval: 2, endType: 'never' },
    })
    expect(getEventOccurrenceDatesInYear(biweekly, 2026).length).toBeGreaterThanOrEqual(26)
  })

  it('daily 重复：全年逐日落位（interval 3 → 每 3 天）', () => {
    const daily = makeEvent({
      date: '2026-01-01',
      type: 'other',
      recurringConfig: { enabled: true, frequency: 'daily', interval: 3, endType: 'never' },
    })
    const dates = getEventOccurrenceDatesInYear(daily, 2026)
    expect(dates.length).toBe(122) // 365/3 = 121.67 → 122 个锚点对齐落位
    // 相邻落位间隔 3 天
    expect(new Date(dates[1]).getTime() - new Date(dates[0]).getTime()).toBe(3 * 86_400_000)
  })

  it('农历事件：按目标年转换（农历六月在当年公历年内落位）', () => {
    const e = makeEvent({
      date: '2000-01-01',
      calendarType: 'lunar',
      lunarDate: { year: 1999, month: 6, day: 25, isLeap: false },
    })
    // 农历 2026 年六月廿五 = 公历 2026-08-07（lunar-javascript 实测值 pin）
    expect(getEventOccurrenceDatesInYear(e, 2026)).toEqual(['2026-08-07'])
  })
})

describe('groupEventsByOccurrence', () => {
  it('同一年多事件聚合到同一 key；同一事件多落位各自出现', () => {
    const yearly = makeEvent({
      id: 'a',
      date: '1990-07-28',
      type: 'birthday',
      recurringConfig: { enabled: true, frequency: 'yearly', interval: 1, endType: 'never' },
    })
    const once = makeEvent({ id: 'b', date: '2026-07-28' })
    const map = groupEventsByOccurrence([yearly, once], 2026)
    expect(map.get('2026-07-28')).toHaveLength(2)
  })
})
