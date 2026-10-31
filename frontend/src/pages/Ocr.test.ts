import { describe, it, expect } from 'vitest'
import { inferDocKind } from './Ocr'

/**
 * v2.41 R22：OCR 文本 → 文档类型推断。
 */

describe('inferDocKind', () => {
  it('maps 身份证 to id_card', () => {
    expect(inferDocKind('中华人民共和国\n居民身份证\n签发机关：某某公安局')).toBe('id_card')
  })

  it('maps 护照/驾照/签证/保单/合同/证书', () => {
    expect(inferDocKind('Passport 中华人民共和国护照')).toBe('passport')
    expect(inferDocKind('机动车驾驶证')).toBe('driver_license')
    expect(inferDocKind('中华人民共和国签证 Visa')).toBe('visa')
    expect(inferDocKind('人寿保险单')).toBe('policy')
    expect(inferDocKind('房屋租赁合同')).toBe('contract')
    expect(inferDocKind('毕业证书')).toBe('certificate')
  })

  it('falls back to other for receipts or unknown text', () => {
    expect(inferDocKind('合计：￥128.00\n谢谢惠顾')).toBe('other')
    expect(inferDocKind('')).toBe('other')
    expect(inferDocKind(null as unknown as string)).toBe('other')
  })
})
