import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * checkbox 109 e2e: the in-app assistant on `/assistant`.
 *
 * RT: typing "明天提醒我给妈妈打电话" posts `create_event` to the REAL `/api/agent/actions/:tool`
 * route and the transcript shows that tool name + the exact args (never paraphrased). Issuing a
 * delete renders the confirmation card, and NOTHING is deleted until 确认 is clicked - the confirm
 * request is not even sent (state.confirmCalls stays 0). After 确认 it executes exactly once.
 *
 * Negative control (adversarial): BEFORE the click, both `confirmCalls` and `deleteExecuted` are
 * asserted to be falsy, so a UI that auto-executed would fail this spec.
 */

const USER = { id: 1, username: 'e2e-assistant-user', role: 'admin', mustChangePassword: false };

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
function shanghaiYmd(now: Date): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const TOMORROW = addDaysYmd(shanghaiYmd(new Date()), 1);

interface AgentState {
  actions: Array<{ tool: string; args: unknown }>;
  confirmCalls: number;
  deleteExecuted: boolean;
  createdEventId: number | null;
}

async function mockAgentApi(page: Page, state: AgentState): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('accessToken', 'e2e-assistant-token');
  });

  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const cors: Record<string, string> = {
      'Access-Control-Allow-Origin': 'http://localhost:5173',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

    const { pathname } = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    if (pathname === '/api/auth/session') return json({ success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config')
      return json({ success: true, data: { siteKey: null, enabled: false } });
    if (pathname === '/api/agent/tools') return json({ success: true, data: { tools: [] } });

    if (pathname === '/api/agent/actions/create_event') {
      const body = (req.postDataJSON() as { args: unknown }) ?? { args: {} };
      state.actions.push({ tool: 'create_event', args: body.args });
      state.createdEventId = 501;
      return json({ success: true, data: { id: 501, name: '给妈妈打电话', date: TOMORROW } });
    }

    if (pathname === '/api/agent/actions/delete_event') {
      const body = (req.postDataJSON() as { args: unknown }) ?? { args: {} };
      state.actions.push({ tool: 'delete_event', args: body.args });
      // 202 confirm_required: NOTHING was mutated.
      return json(
        {
          success: true,
          data: {
            status: 'confirm_required',
            confirmationId: '44444444-4444-4444-8444-444444444444',
            preview: {
              tool: 'delete_event',
              description: '删除事件「给妈妈打电话」（不可恢复）',
              args: body.args,
              expiresAt: '2026-09-29T10:02:00.000Z',
            },
          },
        },
        202,
      );
    }

    if (pathname.startsWith('/api/agent/confirm/')) {
      state.confirmCalls += 1;
      state.deleteExecuted = true;
      return json({ success: true, data: { deleted: state.createdEventId } });
    }

    return json({ success: true, data: [] });
  });
}

test.describe('checkbox 109 - in-app assistant', () => {
  test.use({ timezoneId: 'Asia/Shanghai' });

  test('shows the real tool call, and a destructive delete waits for 确认', async ({ page }) => {
    const state: AgentState = { actions: [], confirmCalls: 0, deleteExecuted: false, createdEventId: null };
    await mockAgentApi(page, state);

    await page.goto('/assistant');
    const input = page.getByTestId('assistant-input');
    await expect(input).toBeVisible();

    // 1. Natural language -> create_event. The transcript shows the REAL tool name + args.
    await input.fill('明天提醒我给妈妈打电话');
    await page.getByTestId('assistant-submit').click();
    await expect(page.getByTestId('assistant-tool-name').first()).toHaveText('create_event');
    const createArgs = await page.getByTestId('assistant-tool-args').first().innerText();
    expect(createArgs).toContain('给妈妈打电话');
    expect(createArgs).toContain(TOMORROW);
    expect(state.actions).toContainEqual({ tool: 'create_event', args: { name: '给妈妈打电话', date: TOMORROW } });

    // 2. Destructive delete -> confirmation card, nothing executed yet.
    await input.fill('删除事件 501');
    await page.getByTestId('assistant-submit').click();
    const card = page.getByTestId('assistant-confirmation');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('assistant-confirmation-tool')).toHaveText('delete_event');
    await expect(page.getByTestId('assistant-confirmation-preview')).toContainText('501');

    // NEGATIVE CONTROL: the confirm request was not sent and nothing was deleted.
    expect(state.confirmCalls).toBe(0);
    expect(state.deleteExecuted).toBe(false);
    await expect(page.getByTestId('assistant-confirmation-done')).toHaveCount(0);

    // 3. 确认 executes exactly once.
    await page.getByTestId('assistant-confirm').click();
    await expect(page.getByTestId('assistant-confirmation-done')).toBeVisible();
    await expect.poll(() => state.confirmCalls).toBe(1);
    expect(state.deleteExecuted).toBe(true);
  });

  test('quick prompts exist and the input is labelled', async ({ page }) => {
    const state: AgentState = { actions: [], confirmCalls: 0, deleteExecuted: false, createdEventId: null };
    await mockAgentApi(page, state);

    await page.goto('/assistant');
    await expect(page.getByLabel('给助手发消息')).toBeVisible();
    const quick = page.getByTestId('assistant-quick-prompts');
    await expect(quick.getByRole('button')).toHaveCount(4);
  });
});
