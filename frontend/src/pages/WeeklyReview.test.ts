import { describe, it, expect } from 'vitest'
import { buildWeeklySuggestions } from './WeeklyReview'

/**
 * v2.42 R24：周回顾建议规则（确定性，不假 AI）。
 */

describe('buildWeeklySuggestions', () => {
  it('warns about failed triggers with a link', () => {
    const out = buildWeeklySuggestions({ eventsThisWeek: 3, triggersFailed: 2, topHabit: null, topStreak: 0, expiringSoon: 0, activeGoals: 0 })
    expect(out.some((s) => s.tone === 'warn' && s.text.includes('2 条提醒发送失败'))).toBe(true)
    expect(out.find((s) => s.href === '/trigger-logs')).toBeTruthy()
  })

  it('promotes upcoming expiries and habit streaks', () => {
    const out = buildWeeklySuggestions({ eventsThisWeek: 1, triggersFailed: 0, topHabit: '晨跑', topStreak: 12, expiringSoon: 3, activeGoals: 0 })
    expect(out.some((s) => s.text.includes('晨跑') && s.text.includes('12 天'))).toBe(true)
    expect(out.some((s) => s.tone === 'info' && s.text.includes('3 项即将到期'))).toBe(true)
  })

  it('nudges when the week is empty but goals are active', () => {
    const out = buildWeeklySuggestions({ eventsThisWeek: 0, triggersFailed: 0, topHabit: null, topStreak: 0, expiringSoon: 0, activeGoals: 2 })
    expect(out.some((s) => s.text.includes('本周还没有新增事件'))).toBe(true)
  })

  it('falls back to all-clear', () => {
    const out = buildWeeklySuggestions({ eventsThisWeek: 5, triggersFailed: 0, topHabit: null, topStreak: 0, expiringSoon: 0, activeGoals: 0 })
    expect(out[0].tone).toBe('good')
    expect(out[0].text).toContain('平稳')
  })
})
