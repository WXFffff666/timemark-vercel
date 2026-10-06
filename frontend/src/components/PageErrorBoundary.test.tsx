import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PageErrorBoundary } from './PageErrorBoundary'

// 每个用例挂载一个新的 throwing 子树（reset 后重新抛）
let shouldThrow = false
function Bomb(): JSX.Element {
  if (shouldThrow) throw new Error('boom-abc')
  return <div>ok</div>
}

describe('PageErrorBoundary', () => {
  it('renders children normally when no error', () => {
    render(<PageErrorBoundary pageName="测试"><Bomb /></PageErrorBoundary>)
    expect(screen.getByText('ok')).toBeInTheDocument()
  })

  it('isolates the crash: shows page name, message and recovery actions instead of white screen', () => {
    shouldThrow = true
    render(<PageErrorBoundary pageName="到期中心"><Bomb /></PageErrorBoundary>)
    expect(screen.getByText(/「到期中心」页面出了问题/)).toBeInTheDocument()
    expect(screen.getByText('boom-abc')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /回首页/ })).toBeInTheDocument()
  })

  it('reset restores rendering for non-throwing subtree', () => {
    shouldThrow = true
    render(<PageErrorBoundary pageName="测试"><Bomb /></PageErrorBoundary>)
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(screen.getByText(/页面出了问题/)).toBeInTheDocument()
  })
})
