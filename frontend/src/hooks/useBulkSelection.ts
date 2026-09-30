import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * Task 139 - reusable row-selection model for a list page.
 *
 * The hook owns three interactions every list page needs:
 *  - select-all-on-page (the header checkbox) and its inverse (clear),
 *  - shift-range: click a row, shift-click another, the span between them toggles on,
 *  - invert: flip the selection of the current page without touching off-page rows.
 *
 * Pass the page's currently rendered, ordered ids so range math and the
 * "are all page rows selected?" indicator are always computed against what the
 * user can actually see.
 */
export interface UseBulkSelectionResult {
  selectedIds: number[];
  selected: Set<number>;
  count: number;
  isSelected: (id: number) => boolean;
  toggle: (id: number) => void;
  select: (id: number) => void;
  deselect: (id: number) => void;
  /** Header checkbox: adds every visible row id. */
  selectAllOnPage: () => void;
  /** Clears the entire selection (page and off-page). */
  clear: () => void;
  /** Flips the selection of the visible page rows only. */
  invert: () => void;
  /** Adds (never removes) every id between two visible ids, in list order. */
  selectRange: (fromId: number, toId: number) => void;
  /** Row click handler; `shiftKey` extends from the last-clicked anchor. */
  handleItemClick: (id: number, shiftKey: boolean) => void;
  setSelection: (ids: number[]) => void;
  allOnPageSelected: boolean;
  someOnPageSelected: boolean;
}

export function useBulkSelection(orderedIds: number[]): UseBulkSelectionResult {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchorRef = useRef<number | null>(null);

  // De-duplicate while keeping list order, so range math is stable.
  const pageIds = useMemo(() => {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const id of orderedIds) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }, [orderedIds]);

  const isSelected = useCallback((id: number) => selected.has(id), [selected]);

  const toggle = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const select = useCallback((id: number) => {
    setSelected((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const deselect = useCallback((id: number) => {
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const selectAllOnPage = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) next.add(id);
      return next;
    });
  }, [pageIds]);

  const clear = useCallback(() => {
    anchorRef.current = null;
    setSelected(new Set());
  }, []);

  const invert = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [pageIds]);

  const selectRange = useCallback(
    (fromId: number, toId: number) => {
      const from = pageIds.indexOf(fromId);
      const to = pageIds.indexOf(toId);
      if (from === -1 || to === -1) return;
      const [start, end] = from <= to ? [from, to] : [to, from];
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i += 1) next.add(pageIds[i]);
        return next;
      });
    },
    [pageIds],
  );

  const handleItemClick = useCallback(
    (id: number, shiftKey: boolean) => {
      const anchor = anchorRef.current;
      if (shiftKey && anchor !== null && anchor !== id) {
        selectRange(anchor, id);
        return;
      }
      anchorRef.current = id;
      toggle(id);
    },
    [selectRange, toggle],
  );

  const setSelection = useCallback((ids: number[]) => {
    anchorRef.current = null;
    setSelected(new Set(ids));
  }, []);

  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPageSelected = !allOnPageSelected && pageIds.some((id) => selected.has(id));

  return {
    selectedIds: useMemo(() => Array.from(selected), [selected]),
    selected,
    count: selected.size,
    isSelected,
    toggle,
    select,
    deselect,
    selectAllOnPage,
    clear,
    invert,
    selectRange,
    handleItemClick,
    setSelection,
    allOnPageSelected,
    someOnPageSelected,
  };
}
