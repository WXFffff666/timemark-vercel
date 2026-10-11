import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Broadcast from './Broadcast'

const { mockApi } = vi.hoisted(() => ({ mockApi: { get: vi.fn(), post: vi.fn() } }))

vi.mock('@/lib/api', () => ({ api: mockApi }))
vi.mock('@/lib/contact-event-bridge', () => ({
  contactHasAnyEmail: () => false,
  getContactEmailList: () => [],
  resolveContactGreetingName: (c: { name: string }) => c.name,
}))

// Broadcast 用 useSearchParams / 深链 —— MemoryRouter 提供
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/broadcast']}>
      <Broadcast />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset()
  mockApi.get.mockImplementation((path: string) => {
    if (path === '/contacts') return Promise.resolve([])
    if (path === '/config/accounts') return Promise.resolve([{ id: 1, type: 'resend', name: '主邮箱', is_active: true }])
    if (path === '/broadcast/campaigns') return Promise.resolve([])
    return Promise.resolve([])
  })
  mockApi.post.mockImplementation((path: string) => {
    if (path === '/broadcast/preview') return Promise.resolve({ subject: '主题', htmlPreview: '<p>预览正文</p>' })
    if (path === '/broadcast/email') return Promise.resolve({ recipientCount: 1, successCount: 1, failedCount: 0, status: 'sent' })
    return Promise.resolve({})
  })
})

describe('Broadcast 发送确认闸门（v2.31 R5/Q3）', () => {
  it('send button opens the confirm dialog and calls /broadcast/preview (not /email yet)', async () => {
    renderPage()
    const subject = await screen.findByPlaceholderText('邮件主题')
    fireEvent.change(subject, { target: { value: '测试主题' } })
    const html = screen.getByPlaceholderText('支持 {{contact_name}} 变量，发送时自动替换为联系人姓名')
    fireEvent.change(html, { target: { value: '<p>正文</p>' } })
    // 收件人校验：无联系人时必须给手动邮箱
    fireEvent.change(screen.getByPlaceholderText('手动邮箱（逗号/空格分隔，可选）'), { target: { value: 'a@b.com' } })
    fireEvent.click(screen.getByRole('button', { name: /发送/ }))
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/broadcast/preview', expect.anything()))
    expect(mockApi.post).not.toHaveBeenCalledWith('/broadcast/email', expect.anything())
    expect(await screen.findByRole('dialog', { name: '确认批量发送' })).toBeInTheDocument()
  })

  it('cancel keeps everything unsent', async () => {
    renderPage()
    fireEvent.change(await screen.findByPlaceholderText('邮件主题'), { target: { value: '测试主题' } })
    fireEvent.change(screen.getByPlaceholderText('支持 {{contact_name}} 变量，发送时自动替换为联系人姓名'), { target: { value: '<p>正文</p>' } })
    fireEvent.change(screen.getByPlaceholderText('手动邮箱（逗号/空格分隔，可选）'), { target: { value: 'a@b.com' } })
    fireEvent.click(screen.getByRole('button', { name: /发送/ }))
    fireEvent.click(await screen.findByRole('button', { name: '再检查一下' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认批量发送' })).not.toBeInTheDocument())
    expect(mockApi.post).not.toHaveBeenCalledWith('/broadcast/email', expect.anything())
  })
})
