import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HolidayBadge } from './HolidayBadge';

describe('HolidayBadge (休/班 markers)', () => {
  it('renders 休 with the Chinese holiday name', () => {
    render(<HolidayBadge marker={{ kind: 'holiday', label: '休', name: '国庆节' }} />);
    expect(screen.getByText('休')).toBeInTheDocument();
    expect(screen.getByText('国庆节')).toBeInTheDocument();
  });

  it('renders 班 for compensated workdays without a name', () => {
    render(<HolidayBadge marker={{ kind: 'shift-workday', label: '班', name: null }} />);
    expect(screen.getByText('班')).toBeInTheDocument();
    expect(screen.queryByTestId('holiday-name')).not.toBeInTheDocument();
  });

  it('prompt injection: an HTML-bearing holiday name renders as literal text', () => {
    const hostile = '<img src=x onerror="window.__holidayPwned=1">国庆';
    const { container } = render(<HolidayBadge marker={{ kind: 'holiday', label: '休', name: hostile }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect((window as unknown as { __holidayPwned?: number }).__holidayPwned).toBeUndefined();
  });
});
