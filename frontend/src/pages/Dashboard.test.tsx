import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Dashboard } from './Dashboard'
import { BrowserRouter } from 'react-router-dom'

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: () => ({
    user: { username: 'testuser' },
    logout: vi.fn()
  })
}))

vi.mock('@/stores/event.store', () => ({
  useEventStore: () => ({
    events: [],
    loading: false,
    fetchEvents: vi.fn(),
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn()
  })
}))

describe('Dashboard', () => {
  it('renders dashboard header', () => {
    render(<BrowserRouter><Dashboard /></BrowserRouter>)
    expect(screen.getByText('倒计时提醒系统')).toBeInTheDocument()
  })

  it('shows empty state when no events', () => {
    render(<BrowserRouter><Dashboard /></BrowserRouter>)
    expect(screen.getByText(/暂无事件/)).toBeInTheDocument()
  })
})
