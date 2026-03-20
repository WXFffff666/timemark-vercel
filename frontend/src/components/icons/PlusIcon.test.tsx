import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PlusIcon } from './PlusIcon'

describe('PlusIcon', () => {
  it('renders correctly', () => {
    const { container } = render(<PlusIcon />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('applies custom className', () => {
    const { container } = render(<PlusIcon className="custom-class" />)
    expect(container.querySelector('svg')).toHaveClass('custom-class')
  })

  it('respects custom size', () => {
    const { container } = render(<PlusIcon size={32} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '32')
    expect(svg).toHaveAttribute('height', '32')
  })
})
