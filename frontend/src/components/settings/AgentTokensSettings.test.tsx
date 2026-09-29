import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentTokenView } from '@/lib/api';

/**
 * checkbox 101 frontend acceptance:
 *   - a raw token is shown ONCE at creation, then hidden on dismissal and never re-listed;
 *   - the create form defaults to the `read` scope and never to a broader grant.
 */

vi.mock('@/lib/api', () => ({
  fetchAgentTokens: vi.fn(),
  createAgentToken: vi.fn(),
  renameAgentToken: vi.fn(),
  revokeAgentToken: vi.fn(),
}));

import {
  createAgentToken,
  fetchAgentTokens,
  renameAgentToken,
  revokeAgentToken,
} from '@/lib/api';
import { AgentTokensSettings } from './AgentTokensSettings';

const fetchMock = vi.mocked(fetchAgentTokens);
const createMock = vi.mocked(createAgentToken);
const renameMock = vi.mocked(renameAgentToken);
const revokeMock = vi.mocked(revokeAgentToken);

const RAW_TOKEN = 'tmt_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function view(overrides: Partial<AgentTokenView> = {}): AgentTokenView {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'My client',
    scopes: ['read'],
    createdAt: '2026-09-29T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  createMock.mockReset();
  renameMock.mockReset();
  revokeMock.mockReset();
  fetchMock.mockResolvedValue({ tokens: [] });
});

describe('AgentTokensSettings (checkbox 101)', () => {
  it('shows the raw token once, hides it on dismissal, and never lists it again', async () => {
    fetchMock.mockResolvedValueOnce({ tokens: [] }).mockResolvedValue({ tokens: [view()] });
    createMock.mockResolvedValue({ token: RAW_TOKEN, record: view() });
    render(<AgentTokensSettings />);

    fireEvent.change(screen.getByLabelText('令牌名称'), { target: { value: 'My client' } });
    fireEvent.click(screen.getByTestId('agent-token-create'));

    await screen.findByTestId('agent-token-new');
    expect(screen.getByText(RAW_TOKEN)).toBeInTheDocument();
    // The list refresh after creation carries only the public view (no raw token).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('My client')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agent-token-dismiss'));
    expect(screen.queryByTestId('agent-token-new')).toBeNull();
    expect(screen.queryByText(RAW_TOKEN)).toBeNull();
    // It is gone from the whole rendered document, not merely hidden.
    expect(document.body.textContent ?? '').not.toContain(RAW_TOKEN);
  });

  it('defaults the grant to read (never a broader scope)', async () => {
    createMock.mockResolvedValue({ token: RAW_TOKEN, record: view() });
    render(<AgentTokensSettings />);

    const scopeSelect = screen.getByLabelText('令牌权限') as HTMLSelectElement;
    expect(scopeSelect.value).toBe('read');

    fireEvent.change(screen.getByLabelText('令牌名称'), { target: { value: 'CI' } });
    fireEvent.click(screen.getByTestId('agent-token-create'));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith('CI', ['read']));
    expect(createMock).not.toHaveBeenCalledWith('CI', ['admin']);
  });

  it('renames and revokes an existing token through the API', async () => {
    fetchMock
      .mockResolvedValueOnce({ tokens: [view()] })
      .mockResolvedValue({ tokens: [view({ name: 'renamed' }), view({ id: '00000000-0000-4000-8000-000000000002', name: 'other' })] });
    renameMock.mockResolvedValue(undefined);
    revokeMock.mockResolvedValue(undefined);
    render(<AgentTokensSettings />);

    fireEvent.click(await screen.findByLabelText('重命名 My client'));
    fireEvent.change(screen.getByLabelText('重命名令牌'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(renameMock).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', 'renamed'));
    expect(await screen.findByText('other')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('撤销 renamed'));
    await waitFor(() =>
      expect(revokeMock).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'),
    );
  });
});
