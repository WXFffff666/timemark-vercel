import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import Watchlist from './Watchlist'

const { mockApi } = vi.hoisted(() => ({ mockApi: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }))

vi.mock('@/lib/api', () => ({ api: mockApi }))

const ITEMS = [
  { id: 1, kind: 'film', title: '沙丘 3', status: 'wanted', release_date: '2026-12-18', link: null, rating: null, note: '' },
  { id: 2, kind: 'series', title: '某长剧', status: 'in_progress', release_date: null, link: null, rating: 8, note: 'S2E5' },
]

beforeEach(() => {
  mockApi.get.mockReset()
  mockApi.post.mockReset()
  mockApi.patch.mockReset()
  mockApi.delete.mockReset()
  mockApi.get.mockImplementation((path: string) => {
    if (path === '/watchlist/upcoming') return Promise.resolve({ items: [ITEMS[0]] }) // 仅未来上映条目
    return Promise.resolve({ items: ITEMS })
  })
  mockApi.post.mockResolvedValue({})
  mockApi.patch.mockResolvedValue({})
  mockApi.delete.mockResolvedValue({})
})

function renderPage() {
  return render(
    <BrowserRouter>
      <Watchlist />
    </BrowserRouter>,
  )
}

describe('Watchlist 页（v2.31 R5 / F63）', () => {
  it('renders items with kind badges and upcoming section', async () => {
    renderPage()
    await waitFor(() => expect(screen.getAllByText('沙丘 3').length).toBeGreaterThan(0)) // 主列表 + 即将上映速览各一次
    expect(screen.getByText('某长剧')).toBeInTheDocument()
    expect(screen.getByText('即将上映')).toBeInTheDocument()
    expect(screen.getAllByText('电影').length).toBeGreaterThan(0)
  })

  it('adds a new item via POST /watchlist and reloads', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByPlaceholderText('标题（如：沙丘 3）')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('标题（如：沙丘 3）'), { target: { value: '三体 剧' } })
    fireEvent.click(screen.getByRole('button', { name: '添加到清单' }))
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/watchlist', expect.objectContaining({ title: '三体 剧', kind: 'film', status: 'wanted' })))
  })

  it('status select issues PATCH and updates in place', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('更新「沙丘 3」状态')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('更新「沙丘 3」状态'), { target: { value: 'done' } })
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/watchlist/1', { status: 'done' }))
  })

  it('delete asks for confirmation and calls DELETE', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('删除「沙丘 3」')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('删除「沙丘 3」'))
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/watchlist/1'))
    spy.mockRestore()
  })

  it('status filter narrows the list', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('某长剧')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: '想看' }))
    expect(screen.queryByText('某长剧')).not.toBeInTheDocument()
    // 「在看」条目被滤掉；「想看」条目仍在（主列表 + 未过滤的即将上映速览）
    expect(screen.getAllByText('沙丘 3').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('更新「某长剧」状态')).not.toBeInTheDocument()
  })
})
