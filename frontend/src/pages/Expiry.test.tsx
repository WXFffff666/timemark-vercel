import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

/**
 * 到期中心页面渲染证明（失败场景优先）：
 * - 过去日期的条目必须落在 overdue 桶，并使用 destructive 设计令牌（绝不静默隐藏）
 * - 空列表 → 空状态
 * - `/api/expiry/costs` 返回畸形载荷（a11y mock 会返回 []）时不崩溃、不显示 NaN
 */

// Radix UI (@radix-ui/react-use-size) needs ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import Expiry from './Expiry';
import type { ExpiryItem } from '@/lib/expiry-utils';

const pastItem: ExpiryItem = {
  id: 101,
  user_id: 1,
  profile_id: null,
  kind: 'bill',
  title: '已逾期账单',
  vendor: null,
  amount_cents: 1200,
  currency: 'CNY',
  cycle: 'once',
  cycle_days: null,
  start_date: null,
  next_due_date: '2020-01-01',
  auto_renew: false,
  notes: null,
  tags: [],
  reminder_config: null,
  is_active: true,
  created_at: null,
  updated_at: null,
};

const getMock = vi.mocked(api.get);

function installApi(items: ExpiryItem[], overdue: ExpiryItem[], costs: unknown) {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/expiry/overdue')) return Promise.resolve(overdue as never);
    if (url.includes('/expiry/costs')) return Promise.resolve(costs as never);
    return Promise.resolve(items as never);
  });
}

describe('Expiry page', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('renders a past item in the overdue bucket with the destructive token', async () => {
    installApi([pastItem], [pastItem], {
      totalCents: 0,
      currency: null,
      mixedCurrencies: false,
      byCurrency: {},
      byKind: [],
      monthly: [],
      once: { totalCents: 0, currency: null, byCurrency: {}, count: 0 },
    });

    render(
      <BrowserRouter>
        <Expiry />
      </BrowserRouter>,
    );

    expect(await screen.findByRole('heading', { name: '到期中心' })).toBeInTheDocument();

    const overdueBucket = await screen.findByTestId('expiry-bucket-overdue');
    const row = within(overdueBucket).getByTestId('expiry-item-101');
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute('data-overdue', 'true');

    const badge = within(overdueBucket).getByTestId('expiry-overdue-badge-101');
    expect(badge).toHaveAttribute('data-token', 'destructive');
    expect(badge.className).toContain('text-destructive');

    // It must NOT be hidden / misplaced into the "this week" bucket.
    expect(screen.queryByTestId('expiry-bucket-week')).not.toBeInTheDocument();

    const countdown = within(overdueBucket).getByTestId('expiry-countdown-101');
    expect(countdown.textContent).toContain('已逾期');
  });

  it('shows an empty state when there are no items', async () => {
    installApi([], [], {
      totalCents: 0,
      currency: null,
      mixedCurrencies: false,
      byCurrency: {},
      byKind: [],
      monthly: [],
      once: { totalCents: 0, currency: null, byCurrency: {}, count: 0 },
    });

    render(
      <BrowserRouter>
        <Expiry />
      </BrowserRouter>,
    );

    expect(await screen.findByText('暂无到期项')).toBeInTheDocument();
    expect(screen.queryByTestId('expiry-bucket-overdue')).not.toBeInTheDocument();
  });

  it('survives a malformed costs payload without NaN (a11y mock returns [])', async () => {
    installApi([pastItem], [pastItem], []);

    render(
      <BrowserRouter>
        <Expiry />
      </BrowserRouter>,
    );

    const annualCard = await screen.findByTestId('expiry-summary-annual');
    expect(annualCard.textContent).toContain('—');
    expect(annualCard.textContent).not.toContain('NaN');
  });
});
