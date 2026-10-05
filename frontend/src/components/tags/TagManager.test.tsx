import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import type { TagRecord, TaggedEntity } from '@/lib/api';

/**
 * checkbox 134 frontend acceptance (vitest):
 *   - the vocabulary renders with link counts, creates, deletes;
 *   - selecting tags + the AND/OR toggle calls the smart filter with the right arguments;
 *   - results render grouped by entity type;
 *   - the filter button is disabled until at least one tag is selected;
 *   - a duplicate-name error from the API renders as an alert (clear message, no crash).
 */

const { listTagsMock, createTagMock, deleteTagMock, listTaggedEntitiesMock } = vi.hoisted(() => ({
  listTagsMock: vi.fn(),
  createTagMock: vi.fn(),
  deleteTagMock: vi.fn(),
  listTaggedEntitiesMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    listTags: listTagsMock,
    createTag: createTagMock,
    deleteTag: deleteTagMock,
    listTaggedEntities: listTaggedEntitiesMock,
  };
});

import { TAG_ENTITY_TYPES } from '@/lib/api';
import { TagChips, TagManager } from './TagManager';

const TAGS: TagRecord[] = [
  { id: 1, name: '工作', color: '#ff0000', created_at: '2026-01-01T00:00:00Z', link_count: 2 },
  { id: 2, name: '生活', color: null, created_at: '2026-01-01T00:00:00Z', link_count: 0 },
];

const RESULTS: TaggedEntity[] = [
  { entity_type: 'event', entity_id: 7, tag_ids: [1, 2] },
  { entity_type: 'goal', entity_id: 9, tag_ids: [1] },
];

beforeEach(() => {
  listTagsMock.mockReset().mockResolvedValue(TAGS);
  createTagMock.mockReset().mockResolvedValue({ ...TAGS[0], id: 3, name: '新标签' });
  deleteTagMock.mockReset().mockResolvedValue(undefined);
  listTaggedEntitiesMock.mockReset().mockResolvedValue(RESULTS);
});

describe('TagManager (checkbox 134)', () => {
  it('renders the vocabulary with link counts and creates a trimmed tag', async () => {
    render(<BrowserRouter><TagManager  /></BrowserRouter>);
    expect(await screen.findByText('工作')).toBeTruthy();
    expect(screen.getByText('生活')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy(); // link_count of 工作

    fireEvent.change(screen.getByLabelText('新建标签名称'), { target: { value: '  新标签  ' } });
    fireEvent.click(screen.getByRole('button', { name: /新建/ }));

    await waitFor(() => expect(createTagMock).toHaveBeenCalledWith({ name: '新标签' }));
    await waitFor(() => expect(listTagsMock).toHaveBeenCalledTimes(2)); // initial + refresh
  });

  it('renders a duplicate-name error as an alert instead of crashing', async () => {
    createTagMock.mockRejectedValueOnce(new Error('标签名称已存在: 工作'));
    render(<BrowserRouter><TagManager  /></BrowserRouter>);
    await screen.findByText('工作');

    fireEvent.change(screen.getByLabelText('新建标签名称'), { target: { value: '工作' } });
    fireEvent.click(screen.getByRole('button', { name: /新建/ }));

    const alert = await screen.findByTestId('tag-error');
    expect(alert.textContent).toContain('标签名称已存在');
  });

  it('deletes a tag after confirmation of the API call', async () => {
    render(<BrowserRouter><TagManager  /></BrowserRouter>);
    await screen.findByText('生活');

    fireEvent.click(screen.getByLabelText('删除标签 生活'));
    await waitFor(() => expect(deleteTagMock).toHaveBeenCalledWith(2));
    await waitFor(() => expect(listTagsMock).toHaveBeenCalledTimes(2));
  });

  it('smart filter: AND by default, OR once the toggle changes, composed with entity types', async () => {
    render(<BrowserRouter><TagManager  /></BrowserRouter>);
    await screen.findByText('工作');

    // Disabled until a tag is selected.
    const filterButton = screen.getByRole('button', { name: '筛选' });
    expect((filterButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('筛选标签 工作'));
    fireEvent.click(screen.getByLabelText('筛选标签 生活'));
    await waitFor(() => expect((filterButton as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(filterButton);
    await waitFor(() =>
      expect(listTaggedEntitiesMock).toHaveBeenCalledWith({
        tagIds: [1, 2],
        mode: 'and',
        entityTypes: [...TAG_ENTITY_TYPES],
        limit: 100,
      }),
    );

    // Results are grouped by entity type.
    expect(await screen.findByText(/事件（1）/)).toBeTruthy();
    expect(screen.getByText(/目标（1）/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/任一包含/));
    fireEvent.click(filterButton);
    await waitFor(() =>
      expect(listTaggedEntitiesMock).toHaveBeenLastCalledWith({
        tagIds: [1, 2],
        mode: 'or',
        entityTypes: [...TAG_ENTITY_TYPES],
        limit: 100,
      }),
    );
  });

  it('TagChips renders a remove affordance only when onRemove is provided', () => {
    const onRemove = vi.fn();
    const { rerender } = render(<TagChips tags={TAGS} />);
    expect(screen.queryByLabelText('移除标签 工作')).toBeNull();

    rerender(<TagChips tags={TAGS} onRemove={onRemove} />);
    fireEvent.click(screen.getByLabelText('移除标签 工作'));
    expect(onRemove).toHaveBeenCalledWith(TAGS[0]);
  });
});
