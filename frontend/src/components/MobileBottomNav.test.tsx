import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { initI18n, setLang } from '@/i18n';
import { NAV_ALL_PATHS } from '@/lib/nav-groups';

/**
 * 导航可达性的行为证明。
 *
 * 关键回归：组件曾经是 md:hidden，只在移动端渲染。页面的桌面端没有任何导航，
 * 于是 /cron-monitor /data-health /today /assistant /agent-console /ask /
 * lunar-holidays /docker-migration 这些已挂载页面在桌面端只能手敲地址。
 * 这里断言的是「每个入口都真的渲染成一个可点的导航项」，而不是某个 class 名，
 * 所以将来有人再加断点隐藏也会被抓到。
 */

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
    BrowserRouter: actual.BrowserRouter,
  };
});

import { MobileBottomNav } from './MobileBottomNav';

function renderNav() {
  return render(
    <BrowserRouter>
      <MobileBottomNav />
    </BrowserRouter>,
  );
}

describe('导航可达性', () => {
  beforeEach(async () => {
    navigateMock.mockClear();
    // i18n 资源是异步加载的：没 init 就断言文案，只会拿到键名本身
    setLang('zh');
    await initI18n();
  });

  it('底栏渲染高频入口，并提供通往全部页面的「更多」入口', async () => {
    renderNav();

    const more = screen.getByRole('button', { name: '更多' });
    expect(more).toBeInTheDocument();
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('「更多」面板按四组列出每一条已挂载的受保护路由', async () => {
    renderNav();

    await userEvent.click(screen.getByRole('button', { name: '更多' }));

    const dialog = screen.getByRole('dialog');
    // 面板按四组分区呈现
    for (const group of ['概览', '提醒与通知', '家庭与生活', '助手与系统']) {
      expect(within(dialog).getByRole('heading', { name: group })).toBeInTheDocument();
    }

    // 面板必须为每一条已挂载的受保护路由渲染一个入口——这就是「已挂载即可达」
    const entryButtons = within(dialog).getAllByRole('button');
    expect(entryButtons).toHaveLength(NAV_ALL_PATHS.length);

    // 逐个点名曾经失联的页面，确保它们真的出现在面板里
    // （v2.26 C：/assistant 页删除、入口只剩 dock，面板里不再有「AI 助手」）
    for (const name of ['Cron 监控', '数据健康', '今日一览', '本地 AI', '智能体控制台', '智能问答', '农历节日', 'Docker 迁移']) {
      expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('底栏本身不再被 md:hidden 藏起来（否则桌面端无入口）', async () => {
    const { container } = renderNav();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    // 桌面端可达性的回归点：任何断点隐藏都会让这些页面在桌面端失联
    expect(nav.className).not.toMatch(/md:hidden/);
    expect(container).toBeTruthy();
  });

  it('面板打开后点击某项会导航并关闭面板', async () => {
    renderNav();

    await userEvent.click(screen.getByRole('button', { name: '更多' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Cron 监控/ }));

    expect(navigateMock).toHaveBeenCalledWith('/cron-monitor');
    // 导航后应关闭，避免遮罩留在屏幕上
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});