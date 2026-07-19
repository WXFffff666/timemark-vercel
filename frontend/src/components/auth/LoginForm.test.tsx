import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { LoginForm } from './LoginForm'

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
})
