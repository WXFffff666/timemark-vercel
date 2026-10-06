import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { LoginForm } from './LoginForm'

const { mockApiGet } = vi.hoisted(() => ({ mockApiGet: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: { get: mockApiGet },
}))

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector?: (s: { login: () => void; loginPasskey: () => void }) => unknown) => {
    const state = { login: vi.fn(), loginPasskey: vi.fn() }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/lib/webauthn', () => ({
  isPasskeySupported: () => false,
}))

function renderLogin() {
  return render(
    <BrowserRouter>
      <LoginForm />
    </BrowserRouter>,
  )
}

beforeEach(() => {
  mockApiGet.mockReset()
  // 默认：验证未启用（本地开发常见形态），不打扰既有断言
  mockApiGet.mockResolvedValue({ siteKey: null, enabled: false, misconfigured: false })
})

describe('LoginForm', () => {
  it('renders login form', () => {
    renderLogin()
    expect(screen.getByPlaceholderText('用户名')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('密码')).toBeInTheDocument()
  })

  it('renders title', () => {
    renderLogin()
    expect(screen.getByText('TimeMark')).toBeInTheDocument()
  })

  // v2.28 生产事故复盘：服务端 enabled=true 而 siteKey 缺失时，验证组件凭空消失、
  // 登录必被拒，用户却对着空表单反复重试——必须显式说出口。
  it('shows actionable banner when server requires turnstile but siteKey is missing', async () => {
    mockApiGet.mockResolvedValue({ siteKey: null, enabled: true, misconfigured: true })
    renderLogin()
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('站点密钥')
    })
    expect(screen.getByRole('alert').textContent).toContain('TURNSTILE_SITE_KEY')
  })

  // 配置接口本身失败（如后端冷启动崩溃）也不再静默——v2.28 的 .catch(() => {})
  // 让用户把"后端整个挂了"误读成"人机验证不见了"。
  it('shows banner when turnstile config request fails', async () => {
    mockApiGet.mockRejectedValue(new Error('500 FUNCTION_INVOCATION_FAILED'))
    renderLogin()
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('人机验证配置加载失败')
    })
  })

  it('renders no banner when turnstile is disabled', async () => {
    renderLogin()
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
