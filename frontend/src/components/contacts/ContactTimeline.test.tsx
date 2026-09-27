import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TimelineEntry } from '@timemark/shared';
import { ContactTimeline } from './ContactTimeline';

/**
 * 时间线渲染证明（失败场景优先）：
 * - 空列表 → 空状态，且**不是** loading（spinner 与空状态必须互斥）
 * - loading → spinner（不是空状态）
 * - 约定（promise）只读：不得出现任何完成操作
 */

function interaction(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    type: 'interaction',
    id: 1,
    at: '2026-01-15T09:30:00.000Z',
    interaction_kind: 'call',
    summary: '聊了工作',
    mood: null,
    promise_text: null,
    due_at: null,
    done_at: null,
    gift_description: null,
    direction: null,
    occasion: null,
    amount_cents: null,
    created_at: '2026-01-15T09:30:00.000Z',
    ...overrides,
  };
}

function promise(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    type: 'promise',
    id: 2,
    at: '2026-01-10T09:30:00.000Z',
    interaction_kind: null,
    summary: null,
    mood: null,
    promise_text: '还书',
    due_at: '2026-02-01',
    done_at: null,
    gift_description: null,
    direction: null,
    occasion: null,
    amount_cents: null,
    created_at: '2026-01-10T09:30:00.000Z',
    ...overrides,
  };
}

describe('ContactTimeline', () => {
  it('renders an empty state (never a spinner) for a contact with zero entries', () => {
    render(<ContactTimeline entries={[]} loading={false} />);
    expect(screen.getByTestId('contact-timeline-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('contact-timeline-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contact-timeline')).not.toBeInTheDocument();
  });

  it('renders a loading spinner and NOT the empty state while loading', () => {
    render(<ContactTimeline entries={[]} loading />);
    expect(screen.getByTestId('contact-timeline-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('contact-timeline-empty')).not.toBeInTheDocument();
  });

  it('renders entries and keeps promises read-only (no completion affordance)', () => {
    render(<ContactTimeline entries={[promise(), interaction()]} loading={false} />);

    expect(screen.getByTestId('timeline-entry-promise-2')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-entry-interaction-1')).toBeInTheDocument();
    expect(screen.getByText('聊了工作')).toBeInTheDocument();
    expect(screen.getByText('还书')).toBeInTheDocument();
    expect(screen.getByText('截止 2026-02-01')).toBeInTheDocument();

    // No button of any kind inside a promise row → no invented completion endpoint.
    const promiseRow = screen.getByTestId('timeline-entry-promise-2');
    expect(promiseRow.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders an error with a retry action instead of a blank/crash', () => {
    const onRetry = vi.fn();
    render(<ContactTimeline entries={[]} loading={false} error="HTTP 500" onRetry={onRetry} />);
    expect(screen.getByTestId('contact-timeline-error')).toHaveTextContent('HTTP 500');
    screen.getByRole('button', { name: '重试' }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
