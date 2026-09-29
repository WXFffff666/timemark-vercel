import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentToolPreview } from '@/lib/api';

/**
 * checkbox 109 frontend acceptance (vitest):
 *   - a natural-language submit renders the tool-call transcript with the REAL tool name and the
 *     exact args the mock backend received (never paraphrased);
 *   - a `confirm_required` response renders the confirmation card with the backend's VERBATIM
 *     `preview` and issues NO confirm request (never-auto-execute);
 *   - clicking 确认 issues the confirm call exactly once and the action then runs;
 *   - 409 `confirmation_already_used` and 410 `confirmation_expired` render two DISTINCT messages;
 *   - the quick prompts exist and Enter on a focused prompt submits it;
 *   - the input is labelled, the message list is announced, 确认 is a real focusable button.
 */

vi.mock('@/lib/api', () => ({
  fetchAgentTools: vi.fn(),
  invokeAgentAction: vi.fn(),
  confirmAgentAction: vi.fn(),
}));

import { confirmAgentAction, fetchAgentTools, invokeAgentAction } from '@/lib/api';
import { ASSISTANT_QUICK_PROMPTS } from '@/lib/assistant-intent';
import { confirmFailureMessage, useAssistant } from '@/hooks/useAssistant';
import { AssistantPanel } from './AssistantPanel';

const invokeMock = vi.mocked(invokeAgentAction);
const confirmMock = vi.mocked(confirmAgentAction);
const toolsMock = vi.mocked(fetchAgentTools);

const CONFIRMATION_ID = '22222222-2222-4222-8222-222222222222';

/** The exact preview the (mock) backend returns - must be rendered byte-for-byte, not paraphrased. */
const PREVIEW: AgentToolPreview = {
  tool: 'delete_event',
  description: '删除事件「给妈妈打电话」（不可恢复）',
  args: { eventId: 42 },
  expiresAt: '2026-09-29T10:02:00.000Z',
};

function Harness() {
  const assistant = useAssistant();
  return <AssistantPanel assistant={assistant} variant="page" />;
}

/** Type into the labelled input and submit the form. */
async function send(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByTestId('assistant-input'), text);
  await user.click(screen.getByTestId('assistant-submit'));
  return user;
}

beforeEach(() => {
  invokeMock.mockReset();
  confirmMock.mockReset();
  toolsMock.mockReset();
  toolsMock.mockResolvedValue({ tools: [] });
});

describe('AssistantPanel (checkbox 109)', () => {
  it('renders the transcript with the real tool name and the exact args the backend received', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'executed', data: { id: 501 } });
    render(<Harness />);

    await send('2026-10-05 提醒我交报告');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    // The args the backend actually received...
    expect(invokeMock).toHaveBeenCalledWith('create_event', { name: '交报告', date: '2026-10-05' });
    const [tool, args] = invokeMock.mock.calls[0];

    // ...are the args the transcript shows, verbatim (no paraphrase).
    expect(await screen.findByTestId('assistant-tool-name')).toHaveTextContent(tool);
    expect(screen.getByTestId('assistant-tool-args').textContent).toBe(JSON.stringify(args, null, 2));
  });

  it('renders the confirm-required card with the backend preview verbatim and never auto-executes', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'confirm_required', confirmationId: CONFIRMATION_ID, preview: PREVIEW });
    render(<Harness />);

    await send('删除事件 42');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    await screen.findByTestId('assistant-confirmation');
    expect(screen.getByTestId('assistant-confirmation-tool')).toHaveTextContent(PREVIEW.tool);
    expect(screen.getByTestId('assistant-confirmation-description')).toHaveTextContent(PREVIEW.description);
    expect(screen.getByTestId('assistant-confirmation-preview').textContent).toBe(JSON.stringify(PREVIEW.args, null, 2));

    // NEVER-AUTO-EXECUTE: the confirm request is not even sent, and nothing ran.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('assistant-confirmation-done')).toBeNull();
  });

  it('issues the confirm request exactly once on 确认, and the action then runs', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'confirm_required', confirmationId: CONFIRMATION_ID, preview: PREVIEW });
    confirmMock.mockResolvedValueOnce({ kind: 'executed', data: { deleted: 42 } });
    render(<Harness />);

    const user = await send('删除事件 42');
    await screen.findByTestId('assistant-confirmation');

    // Still nothing sent before the click.
    expect(confirmMock).not.toHaveBeenCalled();

    const confirmButton = screen.getByTestId('assistant-confirm');
    confirmButton.focus();
    expect(confirmButton).toHaveFocus();
    await user.click(confirmButton);

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock).toHaveBeenCalledWith(CONFIRMATION_ID);
    expect(await screen.findByTestId('assistant-confirmation-done')).toBeInTheDocument();
  });

  it('renders the 409 confirmation_already_used message', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'confirm_required', confirmationId: CONFIRMATION_ID, preview: PREVIEW });
    confirmMock.mockResolvedValueOnce({
      kind: 'failed',
      status: 409,
      code: 'confirmation_already_used',
      message: 'already used',
    });
    render(<Harness />);

    const user = await send('删除事件 42');
    await screen.findByTestId('assistant-confirmation');
    await user.click(screen.getByTestId('assistant-confirm'));

    const error = await screen.findByTestId('assistant-confirmation-error');
    expect(error).toHaveTextContent(confirmFailureMessage('confirmation_already_used'));
  });

  it('renders the 410 confirmation_expired message, distinct from the 409 one', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'confirm_required', confirmationId: CONFIRMATION_ID, preview: PREVIEW });
    confirmMock.mockResolvedValueOnce({
      kind: 'failed',
      status: 410,
      code: 'confirmation_expired',
      message: 'expired',
    });
    render(<Harness />);

    const user = await send('删除事件 42');
    await screen.findByTestId('assistant-confirmation');
    await user.click(screen.getByTestId('assistant-confirm'));

    const error = await screen.findByTestId('assistant-confirmation-error');
    expect(error).toHaveTextContent(confirmFailureMessage('confirmation_expired'));
    // The two failure messages must not collide.
    expect(confirmFailureMessage('confirmation_expired')).not.toBe(
      confirmFailureMessage('confirmation_already_used'),
    );
  });

  it('lists the quick prompts and submits a focused prompt on Enter (keyboard reachable)', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'executed', data: { ok: true } });
    render(<Harness />);

    const quick = screen.getByTestId('assistant-quick-prompts');
    for (const prompt of ASSISTANT_QUICK_PROMPTS) {
      expect(within(quick).getByRole('button', { name: prompt })).toBeInTheDocument();
    }

    const user = userEvent.setup();
    const first = within(quick).getByRole('button', { name: ASSISTANT_QUICK_PROMPTS[0] });
    first.focus();
    expect(first).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('get_today', { includeCompleted: false });
  });

  it('labels the input and announces the message list', () => {
    render(<Harness />);
    expect(screen.getByLabelText('给助手发消息')).toBeInTheDocument();
    const log = screen.getByRole('log', { name: '助手对话记录' });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('assistant-manual-tool')).toBeInTheDocument();
  });

  it('asks a clarifying question (never a raw error) when the utterance is not executable', async () => {
    render(<Harness />);
    await send('随便说点什么');

    expect(await screen.findByText(/我没完全听懂/)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('assistant-manual-tool')).toBeInTheDocument();
  });
});
