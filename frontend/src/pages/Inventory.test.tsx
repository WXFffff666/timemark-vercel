import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';

/**
 * 库存页面渲染证明（失败场景优先）：
 * - 无 expires_at 的项必须渲染「无保质期」，绝不出现 NaN / Invalid Date
 * - 数量耗尽到阈值及以下 → 低库存徽章出现（判定方向不可反转）
 * - 空列表 → 空状态
 */

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
import Inventory from './Inventory';
import type { InventoryItem } from '@/lib/inventory-utils';

function item(overrides: Partial<InventoryItem>): InventoryItem {
  return {
    id: 1,
    user_id: 1,
    profile_id: null,
    name: '牛奶',
    category: 'food',
    quantity: 3,
    unit: '盒',
    low_stock_threshold: 2,
    purchased_at: null,
    expires_at: null,
    location: null,
    notes: null,
    reminder_config: null,
    is_active: true,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

const getMock = vi.mocked(api.get);
const postMock = vi.mocked(api.post);

function installApi(items: InventoryItem[], low: InventoryItem[] = [], expiring: InventoryItem[] = []) {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/inventory/low-stock')) return Promise.resolve(low as never);
    if (url.includes('/inventory/expiring')) return Promise.resolve(expiring as never);
    return Promise.resolve(items as never);
  });
}

describe('Inventory page', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('renders 无保质期 for an item with no expires_at (never NaN)', async () => {
    installApi([item({ id: 5, name: '大米', expires_at: null })]);

    render(
      <BrowserRouter>
        <Inventory />
      </BrowserRouter>,
    );

    expect(await screen.findByRole('heading', { name: '库存' })).toBeInTheDocument();

    const expiry = await screen.findByTestId('inventory-expiry-5');
    expect(expiry).toHaveTextContent('无保质期');
    expect(expiry.getAttribute('data-kind')).toBe('none');
    expect(expiry.textContent).not.toContain('NaN');
    expect(expiry.textContent).not.toContain('Invalid');
  });

  it('shows the low-stock badge only at or below the threshold', async () => {
    installApi([item({ id: 6, quantity: 5, low_stock_threshold: 2 })]);

    render(
      <BrowserRouter>
        <Inventory />
      </BrowserRouter>,
    );

    await screen.findByTestId('inventory-item-6');
    expect(screen.queryByTestId('inventory-low-stock-badge-6')).not.toBeInTheDocument();
  });

  it('lights the low-stock badge after consuming below the threshold', async () => {
    installApi([item({ id: 7, name: '鸡蛋', quantity: 3, low_stock_threshold: 2 })]);
    postMock.mockResolvedValue(item({ id: 7, name: '鸡蛋', quantity: 2, low_stock_threshold: 2 }) as never);

    render(
      <BrowserRouter>
        <Inventory />
      </BrowserRouter>,
    );

    const row = await screen.findByTestId('inventory-item-7');
    expect(within(row).queryByTestId('inventory-low-stock-badge-7')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('消耗 鸡蛋'));

    const badge = await screen.findByTestId('inventory-low-stock-badge-7');
    expect(badge).toHaveAttribute('data-token', 'destructive');
    expect(badge.className).toContain('text-destructive');
    expect(postMock).toHaveBeenCalledWith('/inventory/7/consume', { quantity: 1 });
  });

  it('shows an empty state when there are no items', async () => {
    installApi([]);

    render(
      <BrowserRouter>
        <Inventory />
      </BrowserRouter>,
    );

    expect(await screen.findByText('暂无库存项')).toBeInTheDocument();
    expect(screen.queryByTestId('inventory-category-food')).not.toBeInTheDocument();
  });
});
