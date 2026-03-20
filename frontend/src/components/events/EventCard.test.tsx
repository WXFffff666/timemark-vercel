import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

  it('renders event type badge', () => {
    render(<EventCard event={mockEvent} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('birthday')).toBeInTheDocument()
  })

  it('calls onEdit when edit button clicked', () => {
    const onEdit = vi.fn()
    const { container } = render(<EventCard event={mockEvent} onEdit={onEdit} onDelete={vi.fn()} />)
    const buttons = container.querySelectorAll('button')
    buttons[0].click()
    expect(onEdit).toHaveBeenCalledWith(mockEvent)
  })

  it('calls onDelete when delete button clicked', () => {
    const onDelete = vi.fn()
    const { container } = render(<EventCard event={mockEvent} onEdit={vi.fn()} onDelete={onDelete} />)
    const buttons = container.querySelectorAll('button')
    buttons[1].click()
    expect(onDelete).toHaveBeenCalledWith('1')
  })
})
