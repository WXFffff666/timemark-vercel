import { describe, it, expect } from 'vitest'
import { stripMarkdownLight } from './text-clean'

/**
 * v2.35 R27（用户报告）：Dock 助手回答仍以 mdx/md 格式显示——
 * 轻量清洗器漏了水平线、行中残留 **、孤立 #、HTML 标签残留。
 * 目标是自然语言显示：保留内容与换行，剥掉所有结构性标记。
 */
describe('stripMarkdownLight — mdx 残留（R27）', () => {
  it('removes horizontal rules (--- and ***)', () => {
    const out = stripMarkdownLight('第一段\n\n---\n\n第二段\n\n***\n\n第三段')
    expect(out).not.toContain('---')
    expect(out).not.toContain('***')
    expect(out).toContain('第一段')
    expect(out).toContain('第三段')
  })

  it('strips residual paired ** even across prior edits', () => {
    expect(stripMarkdownLight('这是 **重点内容** 请注意')).toBe('这是 重点内容 请注意')
  })

  it('strips standalone empty heading lines', () => {
    const out = stripMarkdownLight('前文\n##\n后文')
    expect(out).not.toMatch(/^##$/m)
    expect(out).toContain('前文')
    expect(out).toContain('后文')
  })

  it('strips html tags the model leaks (br/b)', () => {
    expect(stripMarkdownLight('第一行<br>第二行<b>加粗</b>')).toBe('第一行第二行加粗')
  })

  it('strikes through ~~text~~', () => {
    expect(stripMarkdownLight('~~作废~~')).toBe('作废')
  })

  it('keeps 来源 citations and newlines intact', () => {
    const out = stripMarkdownLight('答案正文 [1]\n第二行 [2]')
    expect(out).toContain('[1]')
    expect(out).toContain('\n')
  })

  it('table rows still flatten to readable text', () => {
    const out = stripMarkdownLight('| 事件 | 日期 |\n|---|---|\n| 妈妈生日 | 12-25 |')
    expect(out).not.toContain('|')
    expect(out).toContain('妈妈生日')
    expect(out).toContain('12-25')
  })
})
