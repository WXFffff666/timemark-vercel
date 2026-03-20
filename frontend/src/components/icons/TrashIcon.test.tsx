import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TrashIcon } from './TrashIcon'

describe('TrashIcon', () => {
  it('renders correctly', () => {
    const { container } = render(<TrashIcon />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('applies custom className', () => {
    const { container } = render(<TrashIcon className="custom-class" />)
    expect(container.querySelector('svg')).toHaveClass('custom-class')
  })

  it('respects custom size', () => {
    const { container } = render(<TrashIcon size={32} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '32')
    expect(svg).toHaveAttribute('height', '32')
  })
})
