import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import type { AvailableChannel } from '@/lib/api';

/**
 * Checkbox 22 follow-up render proof: with a healthy `fcm` account configured, the Firebase button
 * must be ENABLED (clicking toggles the channel, it must not bounce to /channels); a channel with no
 * account must be DISABLED (clicking navigates to /channels).
 */
const { navigateMock, fetchAvailableChannelsMock, apiGetMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  fetchAvailableChannelsMock: vi.fn(),
  apiGetMock: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/lib/api', () => ({
  api: { get: apiGetMock },
  fetchAvailableChannels: fetchAvailableChannelsMock,
}));

// Radix UI (@radix-ui/react-use-size) needs ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

import { EventForm } from './EventForm';
import { resetChannelTemplatesCache } from '@/lib/channel-templates';

/**
 * 渠道按钮现在由后端目录渲染，不再是前端抄的那份清单。
 * 这里给一份最小目录：fcm 有账号（应可点），zulip 没有（应跳 /channels），
 * 外加一个当初被抄漏的 pushdeer —— 它现在必须能被渲染出来。
 */
const TEMPLATES = [
  { id: 'fcm', name: 'Firebase 推送', description: '', icon: 'Zap', configMethod: 'token', isBuiltIn: true, fields: [] },
  { id: 'zulip', name: 'Zulip', description: '', icon: 'Hash', configMethod: 'token', isBuiltIn: true, fields: [] },
  { id: 'pushdeer', name: 'PushDeer', description: '', icon: 'Send', configMethod: 'token', isBuiltIn: true, fields: [] },
];

function channel(overrides: Partial<AvailableChannel> & { type: string }): AvailableChannel {
  return {
    id: 1,
    name: overrides.type,
    config_method: 'token',
    is_active: true,
    last_test_result: null,
    last_test_at: null,
    connection_status: null,
    ...overrides,
  };
}

describe('EventForm channel picker (new channels must be usable when configured)', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    fetchAvailableChannelsMock.mockReset();
    apiGetMock.mockReset();
    resetChannelTemplatesCache();
    apiGetMock.mockImplementation((path: string) =>
      Promise.resolve(path === '/channels/templates' ? TEMPLATES : [])
    );
  });

  it('enables the Firebase (fcm) button when a matching account is configured', async () => {
    fetchAvailableChannelsMock.mockResolvedValue([channel({ id: 9, type: 'fcm', name: 'FCM' })]);
    const onClose = vi.fn();

    render(
      <BrowserRouter>
        <EventForm open onClose={onClose} onSubmit={vi.fn()} />
      </BrowserRouter>,
    );

    const button = await screen.findByRole('button', { name: /Firebase 推送/ });
    await waitFor(() => expect(button).toHaveAttribute('title', '已配置且可用'));

    await userEvent.click(button);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables a new channel button when no matching account is configured', async () => {
    fetchAvailableChannelsMock.mockResolvedValue([channel({ id: 9, type: 'fcm', name: 'FCM' })]);
    const onClose = vi.fn();

    render(
      <BrowserRouter>
        <EventForm open onClose={onClose} onSubmit={vi.fn()} />
      </BrowserRouter>,
    );

    const button = await screen.findByRole('button', { name: /Zulip/ });
    await waitFor(() => expect(button).toHaveAttribute('title', '未配置，点击去配置'));

    await userEvent.click(button);
    expect(navigateMock).toHaveBeenCalledWith('/channels');
    expect(onClose).toHaveBeenCalled();
  });

  it('offers a channel that the old hard-coded list never had, once an account exists', async () => {
    // pushdeer / generic_webhook / twilio 以前根本不在前端清单里：
    // 用户配好账号，按钮依然不存在。新增渠道必须只改后端目录。
    fetchAvailableChannelsMock.mockResolvedValue([channel({ id: 11, type: 'pushdeer', name: 'PushDeer' })]);
    const onClose = vi.fn();

    render(
      <BrowserRouter>
        <EventForm open onClose={onClose} onSubmit={vi.fn()} />
      </BrowserRouter>,
    );

    const button = await screen.findByRole('button', { name: /PushDeer/ });
    await waitFor(() => expect(button).toHaveAttribute('title', '已配置且可用'));

    await userEvent.click(button);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
