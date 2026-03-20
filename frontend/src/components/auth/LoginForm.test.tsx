import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoginForm } from './LoginForm'

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: () => ({
    login: vi.fn()
  })
}))

describe('LoginForm', () => {
  it('renders login form', () => {
    render(<LoginForm />)
    expect(screen.getByPlaceholderText('用户名')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('密码')).toBeInTheDocument()
  })

  it('renders title', () => {
    render(<LoginForm />)
    expect(screen.getByText('倒计时提醒系统')).toBeInTheDocument()
  })
})
