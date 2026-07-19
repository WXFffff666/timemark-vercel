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
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01'
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
})
