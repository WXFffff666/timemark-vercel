import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { EditIcon } from './EditIcon'

describe('EditIcon', () => {
  it('renders correctly', () => {
    const { container } = render(<EditIcon />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('applies custom className', () => {
    const { container } = render(<EditIcon className="custom-class" />)
    expect(container.querySelector('svg')).toHaveClass('custom-class')
  })

  it('respects custom size', () => {
    const { container } = render(<EditIcon size={32} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '32')
    expect(svg).toHaveAttribute('height', '32')
  })
})
