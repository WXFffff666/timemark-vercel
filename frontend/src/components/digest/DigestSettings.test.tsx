import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { DigestSettings } from './DigestSettings'

const { mockApi } = vi.hoisted(() => ({ mockApi: { get: vi.fn(), post: vi.fn() } }))

vi.mock('@/lib/api', () => ({ api: mockApi }))

function mockConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    period: 'monthly',
    recipients: [],
    sections: null,
    channelAccountId: null,
    dailyEnabled: false,
    dailyTime: '21:00',
    weeklyEnabled: false,
    weeklyDay: 1,
    weeklyTime: '09:00',
    ...overrides,
  }
}

beforeEach(() => {
  mockApi.get.mockReset()
  mockApi.post.mockReset()
  mockApi.get.mockImplementation((path: string) => {
    if (path === '/config/digest') return Promise.resolve(mockConfig())
    if (path === '/config/accounts') return Promise.resolve([{ id: 3, type: 'resend', name: '主邮箱', is_active: true }])
    return Promise.resolve([])
  })
  mockApi.post.mockResolvedValue({})
})

describe('DigestSettings 日报/周报排程（v2.30 方向 A）', () => {
  it('renders daily/weekly schedule switches, off by default', async () => {
    render(<DigestSettings />)
    await waitFor(() => expect(screen.getByLabelText('启用 AI 日报')).not.toBeChecked())
    expect(screen.getByLabelText('启用 AI 周报')).not.toBeChecked()
  })

  it('loads saved schedule from /config/digest', async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path === '/config/digest') {
        return Promise.resolve(mockConfig({ dailyEnabled: true, dailyTime: '20:30', weeklyEnabled: true, weeklyDay: 5, weeklyTime: '08:15' }))
      }
      if (path === '/config/accounts') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<DigestSettings />)
    await waitFor(() => expect(screen.getByTestId('digest-daily-time')).toHaveValue('20:30'))
    expect(screen.getByTestId('digest-weekly-day')).toHaveValue('5')
    expect(screen.getByTestId('digest-weekly-time')).toHaveValue('08:15')
  })

  it('sends the schedule fields on save', async () => {
    render(<DigestSettings />)
    await waitFor(() => expect(screen.getByLabelText('启用 AI 日报')).not.toBeChecked())

    fireEvent.click(screen.getByLabelText('启用 AI 日报'))
    fireEvent.change(screen.getByTestId('digest-daily-time'), { target: { value: '07:45' } })
    fireEvent.click(screen.getByLabelText('启用 AI 周报'))
    fireEvent.change(screen.getByTestId('digest-weekly-day'), { target: { value: '6' } })

    fireEvent.click(screen.getByRole('button', { name: /保存/ }))
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/config/digest', expect.objectContaining({
      dailyEnabled: true,
      dailyTime: '07:45',
      weeklyEnabled: true,
      weeklyDay: 6,
    })))
  })
})
