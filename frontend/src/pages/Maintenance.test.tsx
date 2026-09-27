import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';

/**
 * 保养页面渲染证明（失败场景优先）：
 * - 日期计划展示下次保养倒计时与用量进度条（比例夹在 0..1）
 * - 只有用量间隔的计划显示「按用量保养」，绝不出现 NaN / Invalid Date
 * - 记录保养对话框对「按用量计划」强制要求用量读数（400 语义的前端镜像）
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
import Maintenance from './Maintenance';
import type { MaintenancePlan } from '@/lib/maintenance-utils';

function plan(overrides: Partial<MaintenancePlan>): MaintenancePlan {
  return {
    id: 1,
    user_id: 1,
    profile_id: null,
    asset_name: '家用轿车',
    asset_kind: 'vehicle',
    interval_days: 180,
    interval_usage: 10000,
    usage_unit: 'km',
    current_usage: 43000,
    last_done_at: '2026-01-01',
    next_due_at: '2099-07-01',
    next_due_usage: 50000,
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

function installApi(plans: MaintenancePlan[]) {
  getMock.mockImplementation(() => Promise.resolve(plans as never));
}

describe('Maintenance page', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('renders an asset card with the next-due countdown and a clamped usage bar', async () => {
    installApi([plan({ id: 11 })]);

    render(
      <BrowserRouter>
        <Maintenance />
      </BrowserRouter>,
    );

    expect(await screen.findByRole('heading', { name: '保养' })).toBeInTheDocument();
    expect(await screen.findByTestId('maintenance-next-due-11')).toHaveTextContent('2099-07-01');

    const bar = screen.getByTestId('maintenance-usage-bar-11');
    expect(bar).toHaveAttribute('role', 'progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '30');

    const countdown = screen.getByTestId('maintenance-due-countdown-11');
    expect(countdown.textContent).not.toContain('NaN');
    expect(countdown.textContent).not.toContain('Invalid');
  });

  it('renders 按用量保养 for a usage-only plan without a progress bar', async () => {
    installApi([plan({ id: 12, interval_days: null, next_due_at: null, current_usage: null, next_due_usage: null })]);

    render(
      <BrowserRouter>
        <Maintenance />
      </BrowserRouter>,
    );

    const countdown = await screen.findByTestId('maintenance-due-countdown-12');
    expect(countdown).toHaveTextContent('按用量保养');
    expect(screen.queryByTestId('maintenance-usage-bar-12')).not.toBeInTheDocument();
  });

  it('requires a usage reading when recording service on a usage plan', async () => {
    installApi([plan({ id: 13, interval_days: null, next_due_at: null, current_usage: null, next_due_usage: null })]);

    render(
      <BrowserRouter>
        <Maintenance />
      </BrowserRouter>,
    );

    await userEvent.click(await screen.findByLabelText('记录保养 家用轿车'));

    expect(await screen.findByLabelText('本次用量读数')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('保存保养记录'));

    expect(await screen.findByText('该计划按用量保养，必须填写本次用量读数')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('shows an empty state when there are no plans', async () => {
    installApi([]);

    render(
      <BrowserRouter>
        <Maintenance />
      </BrowserRouter>,
    );

    expect(await screen.findByText('暂无保养计划')).toBeInTheDocument();
  });
});
