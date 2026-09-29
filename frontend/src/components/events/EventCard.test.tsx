import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EventCard } from './EventCard'
import type { Event } from '@timemark/shared'

const mockEvent: Event = {
  id: '1',
  userId: 'user1',
  name: 'Test Event',
  date: '2026-12-25',
  type: 'birthday',
  calendarType: 'gregorian',
  reminderConfig: {
    enabled: true,
    daysBeforeList: [1, 3],
    emailRecipients: [],
    reminderTimes: ['09:00'],
    channels: [],
  },
  createdAt: '2026-01-01'
}

describe('EventCard', () => {
  it('renders event name', () => {
    render(<EventCard event={mockEvent} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('Test Event')).toBeInTheDocument()
  })

  it('renders calendar type badge', () => {
    render(<EventCard event={mockEvent} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('公历')).toBeInTheDocument()
  })

  it('calls onEdit when edit button clicked', async () => {
    const onEdit = vi.fn()
    render(<EventCard event={mockEvent} onEdit={onEdit} onDelete={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /编辑/ }))
    expect(onEdit).toHaveBeenCalledWith(mockEvent)
  })

  it('calls onDelete when delete button clicked', async () => {
    const onDelete = vi.fn()
    render(<EventCard event={mockEvent} onEdit={vi.fn()} onDelete={onDelete} />)
    await userEvent.click(screen.getByRole('button', { name: /删除/ }))
    expect(onDelete).toHaveBeenCalledWith('1')
  })

  it('calls onTestSend when test button clicked', async () => {
    const onTestSend = vi.fn()
    render(<EventCard event={mockEvent} onEdit={vi.fn()} onDelete={vi.fn()} onTestSend={onTestSend} />)
    await userEvent.click(screen.getByRole('button', { name: /测试/ }))
    expect(onTestSend).toHaveBeenCalledWith('1')
  })

  it('renders the actual lunar date text for a dual-calendar event and keeps the badge', () => {
    const dual: Event = {
      ...mockEvent,
      calendarType: 'both',
      date: '2026-10-05',
      lunarDate: { year: 2026, month: 8, day: 15, isLeap: false },
    }
    render(<EventCard event={dual} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('event-lunar-date')).toHaveTextContent('农历八月十五')
    expect(screen.getByText('双历')).toBeInTheDocument()
  })

  it('shows no lunar text for a Gregorian-only event', () => {
    render(<EventCard event={mockEvent} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.queryByTestId('event-lunar-date')).toBeNull()
  })

  it('surfaces a clear error for an out-of-range lunar event without a lunar date', () => {
    const outOfRange: Event = {
      ...mockEvent,
      calendarType: 'lunar',
      date: '2027-01-01',
      lunarDate: undefined,
    }
    render(<EventCard event={outOfRange} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('event-lunar-error')).toHaveTextContent('农历数据不可用')
  })
})
