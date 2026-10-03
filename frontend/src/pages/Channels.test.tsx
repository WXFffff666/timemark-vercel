import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';

/**
 * Channels 页数据加载的回归证明。
 *
 * 旧实现有三个毛病，这里逐条钉住：
 *  1) `loading` 门控整页内容，首屏只剩一个 h-64 的转圈，页面框架和说明文字全消失；
 *  2) 目录与账户两个请求串行（先目录后账户），白等一倍时间；
 *  3) 每次 fetchData 都 `fetchChannelTemplates({ refresh: true })` 并 setLoading(true)，
 *     于是保存/停用一个账户就整页白转一次、并把目录缓存彻底废掉。
 *
 * 现在：并行请求；目录只在首屏强制刷新一次；刷新保留旧内容不再整页转圈；
 * 并发的 fetchData 共享同一次请求。
 */

const { apiGetMock, apiPutMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPutMock: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('@/lib/api', () => ({
  api: { get: apiGetMock, post: vi.fn(), put: apiPutMock, patch: vi.fn(), delete: vi.fn() },
}));

// 故意**不** mock @/lib/channel-templates：单飞缓存就在那个模块里，mock 掉就等于
// 把要验证的逻辑也 mock 掉了。这里让它跑真实实现，网络请求由 api.get 拦截，
// 于是断言的是真实网络请求次数，而不是"调用 loader 几次"。

// Radix UI 需要 ResizeObserver，jsdom 不提供。
class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

import Channels from './Channels';
import { resetChannelTemplatesCache } from '@/lib/channel-templates';

const TEMPLATE = {
  id: 'discord',
  name: 'Discord',
  description: 'Discord 频道消息推送',
  icon: 'MessageSquare',
  configMethod: 'webhook' as const,
  isBuiltIn: true,
  fields: [{ name: 'webhook', label: 'Webhook URL', type: 'text' as const, required: true }],
};

/** 按路径分发，模板与账户各回各的形状 */
function routeGet(accounts: unknown[] = []) {
  return (path: string) =>
    Promise.resolve(path === '/channels/templates' ? [TEMPLATE] : accounts);
}

const countCalls = (path: string) =>
  apiGetMock.mock.calls.filter(([p]) => p === path).length;

/** 手动 resolve 的 promise：用来把某一次请求停在半路。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: '7',
    type: 'discord',
    name: '我的 Discord',
    is_active: true,
    last_test_result: 'success',
    ...overrides,
  };
}

function renderPage() {
  return render(
    <BrowserRouter>
      <Channels />
    </BrowserRouter>,
  );
}

describe('Channels 数据加载', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPutMock.mockReset();
    // 目录缓存是模块级的，每个用例都要清干净，否则用例之间互相污染
    resetChannelTemplatesCache();
    apiPutMock.mockResolvedValue({});
  });

  it('首屏显示局部骨架，页面框架与说明文字不消失（不是整页转圈）', async () => {
    // 故意不 resolve：停在加载态，检查骨架而不是空白页
    apiGetMock.mockImplementation(() => new Promise(() => {}));

    renderPage();

    // 局部骨架在
    expect(await screen.findByLabelText('正在加载通知渠道')).toBeInTheDocument();
    // 关键：标题与说明始终可见。旧实现用 loading 门控整页内容，这些会一起消失。
    expect(screen.getByRole('heading', { name: '通知渠道' })).toBeInTheDocument();
    expect(screen.getByText(/通知渠道均为可选/)).toBeInTheDocument();
  });

  it('目录与账户并行请求，而不是先目录后账户', async () => {
    apiGetMock.mockImplementation(routeGet());

    renderPage();

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith('/config/accounts'));
    // 目录与账户在同一轮各自发出一次网络请求
    expect(countCalls('/channels/templates')).toBe(1);
    expect(countCalls('/config/accounts')).toBe(1);
  });

  it('目录只在首屏拉一次：停用账户触发刷新时不再重复请求目录', async () => {
    apiGetMock.mockImplementation(routeGet([account()]));

    renderPage();

    const toggle = await screen.findByRole('switch', { name: '启用或停用渠道账户 我的 Discord' });
    expect(countCalls('/channels/templates')).toBe(1);

    await userEvent.click(toggle);
    await waitFor(() => expect(apiPutMock).toHaveBeenCalled());

    // 保存/停用后只重取账户；目录是单飞缓存的会话级数据
    await waitFor(() => expect(countCalls('/config/accounts')).toBeGreaterThan(1));
    expect(countCalls('/channels/templates')).toBe(1);
  });

  it('刷新撞上正在进行的请求时不会被丢掉：排一次尾随刷新', async () => {
    // 第 1 次账户请求（首屏）立即返回；第 2 次（停用后的刷新）挂住，用来制造"请求进行中"，
    // 这样第 2 次停用触发的刷新就会撞上它 —— 旧实现直接 return inflight，把它丢了。
    let accountCalls = 0;
    const gate = deferred<unknown[]>();
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/channels/templates') return Promise.resolve([TEMPLATE]);
      accountCalls += 1;
      if (accountCalls === 1) return Promise.resolve([account()]);
      if (accountCalls === 2) return gate.promise;
      return Promise.resolve([account()]);
    });

    renderPage();

    const toggle = await screen.findByRole('switch', { name: '启用或停用渠道账户 我的 Discord' });

    // 第一次停用 → 触发第 2 次请求，并挂住
    await userEvent.click(toggle);
    await waitFor(() => expect(countCalls('/config/accounts')).toBe(2));

    // 第二次停用 → 这次刷新撞上仍在进行的请求
    await userEvent.click(toggle);
    await waitFor(() => expect(apiPutMock).toHaveBeenCalledTimes(2));
    expect(countCalls('/config/accounts')).toBe(2);

    // 进行中的请求结束 → 尾随刷新必须补跑，否则界面停在旧数据上
    gate.resolve([account()]);
    await waitFor(() => expect(countCalls('/config/accounts')).toBe(3));
  });

  it('拉取失败时如实报错，而不是显示成"还没有配置通知渠道"', async () => {
    apiGetMock.mockRejectedValue(new Error('network down'));

    renderPage();

    expect(await screen.findByText('渠道加载失败')).toBeInTheDocument();
    // 关键：不能把网络故障伪装成"你还没配置渠道"
    expect(screen.queryByText('还没有配置通知渠道')).not.toBeInTheDocument();
  });

  it('加载成功后不再显示骨架', async () => {
    apiGetMock.mockImplementation(routeGet([account()]));

    renderPage();

    expect(await screen.findByRole('switch', { name: /我的 Discord/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('正在加载通知渠道')).not.toBeInTheDocument();
  });
});