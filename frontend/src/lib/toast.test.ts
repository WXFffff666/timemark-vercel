import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toast, subscribeToasts, __resetToastsForTests } from './toast'

/**
 * v2.41 R20：toast store 单测——push/dispatch/auto-dismiss/上限挤旧。
 * v2.42 R23：action 按钮携带与 8s 停留。
 */

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetToastsForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('carries an action and keeps the toast alive for 8s', () => {
    const onClick = vi.fn()
    let items: Array<{ id: number; action?: { label: string; onClick: () => void } }> = []
    const unsub = subscribeToasts((list) => { items = [...list] })
    toast.success('事件已删除', { label: '撤销', onClick })
    expect(items.length).toBe(1)
    expect(items[0].action?.label).toBe('撤销')
    // 3.5s 时还在（action toast 停留 8s）
    vi.advanceTimersByTime(3600)
    let still = -1
    const unsub2 = subscribeToasts((list) => { still = list.length })
    expect(still).toBe(1)
    // 8s 后消失
    vi.advanceTimersByTime(4600)
    let after = -1
    const unsub3 = subscribeToasts((list) => { after = list.length })
    expect(after).toBe(0)
    unsub3(); unsub2(); unsub()
  })

  it('pushes success/error/info with kind tags', () => {
    const seen: Array<{ kind: string; text: string }> = []
    const unsub = subscribeToasts((items) => {
      seen.length = 0
      seen.push(...items.map((i) => ({ kind: i.kind, text: i.text })))
    })
    toast.success('保存成功')
    toast.error('保存失败')
    toast.info('提示')
    expect(seen.map((s) => s.kind)).toEqual(['success', 'error', 'info'])
    expect(seen[1].text).toBe('保存失败')
    unsub()
  })

  it('ignores empty text', () => {
    let count = -1
    const unsub = subscribeToasts((items) => { count = items.length })
    toast.success('   ')
    expect(count).toBe(0)
    unsub()
  })

  it('auto-dismisses after duration', () => {
    const unsub = subscribeToasts(() => {})
    toast.error('会消失的')
    vi.advanceTimersByTime(5100)
    let count = -1
    const unsub2 = subscribeToasts((items) => { count = items.length })
    expect(count).toBe(0)
    unsub2()
    unsub()
  })

  it('caps visible items and drops oldest', () => {
    let items: Array<{ id: number; text: string }> = []
    const unsub = subscribeToasts((list) => { items = [...list] })
    for (let i = 1; i <= 6; i++) toast.info(`消息${i}`)
    expect(items.length).toBe(4)
    expect(items[0].text).toBe('消息3')
    expect(items[3].text).toBe('消息6')
    unsub()
  })

  it('manual dismiss removes item', () => {
    let items: Array<{ id: number }> = []
    const unsub = subscribeToasts((list) => { items = [...list] })
    toast.info('手动关')
    expect(items.length).toBe(1)
    toast.dismiss(items[0].id)
    expect(items.length).toBe(0)
    unsub()
  })
})
