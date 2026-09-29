import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GlobalSearchFacets, GlobalSearchHit, GlobalSearchResponse } from '@/lib/api';

/**
 * checkbox 132 frontend acceptance (vitest):
 *   - the palette opens on Ctrl/Cmd+K, takes focus, and issues NO network request until the user
 *     types (and never for a whitespace-only query);
 *   - typing issues exactly one debounced search with the trimmed query;
 *   - arrow keys move the active option and Enter opens it (navigate), Esc closes;
 *   - facet chips re-run the search filtered to one type.
 */

const { navigateSpy, globalSearchMock } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  globalSearchMock: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateSpy, useLocation: () => ({ pathname: '/dashboard' }) };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, globalSearch: globalSearchMock };
});

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (state: { isAuthenticated: boolean }) => unknown) =>
    selector({ isAuthenticated: true }),
}));

import { GLOBAL_SEARCH_TYPES } from '@/lib/api';
import { CommandPalette } from './CommandPalette';

const HITS: GlobalSearchHit[] = [
  { owner_type: 'event', owner_id: 7, title: '苹果手机发布会', subtitle: 'custom', rank: 0.42 },
  { owner_type: 'inbox', owner_id: 9, title: '关于苹果的通知', subtitle: 'webhook', rank: 0.1 },
  { owner_type: 'goal', owner_id: 2, title: '买苹果', subtitle: 'active', rank: 0.05 },
];

const FACETS: GlobalSearchFacets = {
  event: 1,
  contact: 0,
  interaction: 0,
  document: 0,
  expiry: 0,
  inventory: 0,
  maintenance: 0,
  habit: 0,
  goal: 1,
  inbox: 1,
};

function response(overrides: Partial<GlobalSearchResponse> = {}): GlobalSearchResponse {
  return {
    mode: 'trigram',
    query: '苹果',
    types: [...GLOBAL_SEARCH_TYPES],
    ignoredTypes: [],
    limit: 20,
    total: 3,
    facets: FACETS,
    results: HITS,
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function openPalette() {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value } });
}

beforeEach(() => {
  navigateSpy.mockReset();
  globalSearchMock.mockReset();
  globalSearchMock.mockResolvedValue(response());
});

describe('CommandPalette (checkbox 132)', () => {
  it('issues NO network request when it is merely opened', async () => {
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette')).toBeNull();

    openPalette();
    const input = screen.getByTestId('command-palette-input');
    expect(input).toHaveFocus();
    expect(screen.getByTestId('command-palette-hint')).toBeInTheDocument();

    // Even after the debounce window elapses, an open-with-empty-box never calls the API.
    await sleep(300);
    expect(globalSearchMock).not.toHaveBeenCalled();
  });

  it('opens on Ctrl/Cmd+K, closes on Esc, and toggles closed on a second shortcut', async () => {
    render(<CommandPalette />);
    openPalette();
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('command-palette')).toBeNull();

    openPalette();
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    openPalette();
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('issues exactly one debounced search after typing, and none for whitespace', async () => {
    render(<CommandPalette />);
    openPalette();

    typeQuery('   ');
    await sleep(300);
    expect(globalSearchMock).not.toHaveBeenCalled();

    typeQuery('苹果');
    await waitFor(() => expect(globalSearchMock).toHaveBeenCalledTimes(1));
    expect(globalSearchMock).toHaveBeenCalledWith('苹果', {});
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('is keyboard navigable: ArrowDown/ArrowUp move aria-selected and Enter opens the active hit', async () => {
    render(<CommandPalette />);
    openPalette();
    typeQuery('苹果');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));

    const input = screen.getByTestId('command-palette-input');
    expect(screen.getByTestId('command-palette-option-0')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('command-palette-option-1')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('command-palette-option-0')).toHaveAttribute('aria-selected', 'false');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('command-palette-option-2')).toHaveAttribute('aria-selected', 'true');

    // ArrowUp cannot move above the first option.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('command-palette-option-0')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('command-palette-option-0')).toHaveAttribute('aria-selected', 'true');

    // Enter opens the active hit (event -> /calendar) and closes the palette.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigateSpy).toHaveBeenCalledWith('/calendar');
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('renders facet counts and clicking a chip filters the search to that type', async () => {
    render(<CommandPalette />);
    openPalette();
    typeQuery('苹果');
    await waitFor(() => expect(globalSearchMock).toHaveBeenCalledTimes(1));

    expect(screen.getByTestId('command-palette-facet-event')).toHaveTextContent('事件 1');
    expect(screen.getByTestId('command-palette-facet-goal')).toHaveTextContent('目标 1');
    // Zero-count types are not rendered as chips.
    expect(screen.queryByTestId('command-palette-facet-contact')).toBeNull();

    fireEvent.click(screen.getByTestId('command-palette-facet-goal'));
    await waitFor(() => expect(globalSearchMock).toHaveBeenCalledTimes(2));
    expect(globalSearchMock).toHaveBeenLastCalledWith('苹果', { types: ['goal'] });
  });

  it('shows a valid empty state when the query matches nothing', async () => {
    globalSearchMock.mockResolvedValue(
      response({ results: [], total: 0, facets: Object.fromEntries(GLOBAL_SEARCH_TYPES.map((t) => [t, 0])) as GlobalSearchFacets }),
    );
    render(<CommandPalette />);
    openPalette();
    typeQuery('不存在的词');
    await waitFor(() => expect(screen.getByTestId('command-palette-empty')).toBeInTheDocument());
    expect(screen.getByTestId('command-palette-empty')).toHaveTextContent('未找到「不存在的词」的结果');
  });
});
