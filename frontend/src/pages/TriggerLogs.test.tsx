import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

/**
 * 提醒日志页的投递状态判定。
 *
 * 部分失败（3 个渠道到了、1 个没到）落库时 status='success'。只看 status 的话，
 * 这个页面会把部分失败画成绿色对勾，并且**永远不渲染重试按钮**——后端已经放行的
 * 那条重试路径根本走不到，等于 ece3892 的修复在界面上完全看不见。
 *
 * 页面用 api.getRaw 读分页信封（{ data, pagination }），不是 api.get。
 */

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), getRaw: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

import { api } from '@/lib/api';
import TriggerLogs from './TriggerLogs';

const getRawMock = vi.mocked(api.getRaw);

function log(overrides: Record<string, unknown>) {
  return {
    id: 1,
    event_id: 10,
    event_name: '周年纪念',
    trigger_type: 'scheduled',
    trigger_date: '2026-10-05#d0#t09:00',
    status: 'success',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** 页面读的是分页信封，不是裸数组。 */
function mockLogs(logs: unknown[]) {
  getRawMock.mockResolvedValue({ data: logs, pagination: { total: logs.length } } as never);
}

/** 状态筛选里也有一个写着「成功」的 <option>，所以只在日志列表 <main> 内断言。 */
function list() {
  return within(screen.getByRole('main'));
}

function renderPage() {
  return render(
    <BrowserRouter>
      <TriggerLogs />
    </BrowserRouter>,
  );
}

describe('提醒日志页的投递状态', () => {
  beforeEach(() => {
    getRawMock.mockReset();
  });

  it('部分失败显示为「部分失败」而不是绿色「成功」', async () => {
    mockLogs([
      log({
        status: 'success',
        error_message: 'fcm: HTTP 500',
        channel_results: {
          email: { success: true },
          telegram: { success: true },
          fcm: { success: false, error: 'HTTP 500' },
        },
      }),
    ]);

    renderPage();

    expect(await list().findByText('部分失败')).toBeInTheDocument();
    expect(list().queryByText('成功')).not.toBeInTheDocument();
    expect(list().getByText(/已送达 2 个，未送达 1 个/)).toBeInTheDocument();
  });

  it('部分失败仍然提供重试按钮——后端已放行，界面必须能走到', async () => {
    mockLogs([
      log({
        status: 'success',
        error_message: 'fcm: HTTP 500',
        channel_results: { email: { success: true }, fcm: { success: false, error: 'HTTP 500' } },
      }),
    ]);

    renderPage();

    expect(await list().findByRole('button', { name: '手动重试' })).toBeInTheDocument();
  });

  it('全部成功时既不显示部分失败也不给重试按钮', async () => {
    mockLogs([log({ status: 'success', channel_results: { email: { success: true } } })]);

    renderPage();

    expect(await list().findByText('成功')).toBeInTheDocument();
    expect(list().queryByRole('button', { name: '手动重试' })).not.toBeInTheDocument();
  });

  it('全部失败显示「失败」并提供重试', async () => {
    mockLogs([
      log({
        status: 'failed',
        error_message: 'telegram: 401',
        channel_results: { telegram: { success: false, error: '401' } },
      }),
    ]);

    renderPage();

    expect(await list().findByText('失败')).toBeInTheDocument();
    expect(list().getByRole('button', { name: '手动重试' })).toBeInTheDocument();
  });

  it('内部标记键不会被当成渠道显示', async () => {
    // 安静时段：真实渠道失败 + 一个 _quiet_hours 标记。标记不是渠道。
    mockLogs([
      log({
        status: 'failed',
        error_message: 'email: quiet_hours',
        channel_results: {
          email: { success: false, error: 'quiet_hours' },
          _quiet_hours: { success: false, error: 'quiet_hours' },
        },
      }),
    ]);

    renderPage();

    expect(await list().findByText('✗ email')).toBeInTheDocument();
    expect(list().queryByText(/✗ _quiet_hours/)).not.toBeInTheDocument();
  });

  it('认得历史 TEXT 列的 JSON 字符串形态', async () => {
    mockLogs([
      log({
        status: 'success',
        channel_results: JSON.stringify({ email: { success: true }, fcm: { success: false, error: 'x' } }),
      }),
    ]);

    renderPage();

    expect(await list().findByText('部分失败')).toBeInTheDocument();
  });
});