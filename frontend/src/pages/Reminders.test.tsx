import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

/**
 * 提醒记录页面字段绑定回归证明：
 * - `GET /events/reminder-logs` 返回 `created_at`（端点没有 `sent_at`），
 *   页面必须按 `created_at` 渲染真实相对时间，绝不出现 Invalid Date / undefined。
 * - 同一次 SELECT 里是 `channel_results`（不是 `channel`）与 `error_message`（不是 `message`），
 *   页面必须按真实字段渲染。
 */

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import Reminders from './Reminders';

const getMock = vi.mocked(api.get);

function renderPage() {
  return render(
    <BrowserRouter>
      <Reminders />
    </BrowserRouter>,
  );
}

describe('Reminders page', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('renders created_at as a real relative time, never Invalid Date', async () => {
    getMock.mockResolvedValue([
      {
        id: 1,
        event_id: 10,
        event_name: '周年纪念',
        status: 'success',
        error_message: null,
        channel_results: JSON.stringify({ email: { success: true } }),
        created_at: new Date().toISOString(),
      },
    ] as never);

    renderPage();

    expect(await screen.findByRole('heading', { name: /周年纪念/ })).toBeInTheDocument();
    expect(await screen.findByText('刚刚')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    expect(screen.getByText(/渠道: 邮件/)).toBeInTheDocument();
  });

  it('renders error_message (not message) for a failed reminder', async () => {
    getMock.mockResolvedValue([
      {
        id: 2,
        event_id: 11,
        event_name: '服务器续费',
        status: 'failed',
        error_message: 'HTTP 401 Unauthorized',
        channel_results: JSON.stringify({ webhook: { success: false, error: 'HTTP 401' } }),
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    ] as never);

    renderPage();

    expect(await screen.findByRole('heading', { name: /服务器续费/ })).toBeInTheDocument();
    expect(await screen.findByText('2小时前')).toBeInTheDocument();
    expect(await screen.findByText('HTTP 401 Unauthorized')).toBeInTheDocument();
    expect(screen.getByText(/渠道: Webhook/)).toBeInTheDocument();
  });
});
