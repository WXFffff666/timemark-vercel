import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_TODAY_CARD_ORDER, isTodayCardId, type TodayCardId } from './cards';

export interface TodayCardsState {
  /** Full render order of every known card. */
  order: TodayCardId[];
  /** Cards the user has switched off. */
  hidden: TodayCardId[];
}

function normalize(raw: unknown): TodayCardsState {
  const fallback: TodayCardsState = { order: [...DEFAULT_TODAY_CARD_ORDER], hidden: [] };
  if (!raw || typeof raw !== 'object') return fallback;
  const candidate = raw as { order?: unknown; hidden?: unknown };
  const order = Array.isArray(candidate.order) ? candidate.order.filter(isTodayCardId) : [];
  // A newly shipped card id is appended so it is never silently lost.
  for (const id of DEFAULT_TODAY_CARD_ORDER) {
    if (!order.includes(id)) order.push(id);
  }
  const hidden = Array.isArray(candidate.hidden) ? candidate.hidden.filter(isTodayCardId) : [];
  return { order, hidden };
}

/** Config persists per user (and per browser) so the layout survives reloads. */
export function todayCardsStorageKey(userId?: string): string {
  return `timemark:today-cards:${userId ?? 'anon'}`;
}

function load(userId?: string): TodayCardsState {
  try {
    const raw = localStorage.getItem(todayCardsStorageKey(userId));
    return normalize(raw ? JSON.parse(raw) : null);
  } catch {
    return normalize(null);
  }
}

function save(userId: string | undefined, state: TodayCardsState): void {
  try {
    localStorage.setItem(todayCardsStorageKey(userId), JSON.stringify(state));
  } catch {
    // storage unavailable (private mode) — the in-memory state still works this session
  }
}

export interface UseTodayCardsResult {
  state: TodayCardsState;
  /** Card ids in render order, minus the hidden ones. */
  visibleOrder: TodayCardId[];
  toggle: (id: TodayCardId) => void;
  move: (id: TodayCardId, direction: -1 | 1) => void;
  reset: () => void;
}

export function useTodayCards(userId?: string): UseTodayCardsResult {
  const [state, setState] = useState<TodayCardsState>(() => load(userId));

  useEffect(() => {
    setState(load(userId));
  }, [userId]);

  const persist = useCallback(
    (next: TodayCardsState) => {
      setState(next);
      save(userId, next);
    },
    [userId],
  );

  const toggle = useCallback(
    (id: TodayCardId) => {
      const hidden = state.hidden.includes(id)
        ? state.hidden.filter((candidate) => candidate !== id)
        : [...state.hidden, id];
      persist({ ...state, hidden });
    },
    [persist, state],
  );

  const move = useCallback(
    (id: TodayCardId, direction: -1 | 1) => {
      const order = [...state.order];
      const index = order.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return;
      [order[index], order[target]] = [order[target], order[index]];
      persist({ ...state, order });
    },
    [persist, state],
  );

  const reset = useCallback(() => persist(normalize(null)), [persist]);

  const visibleOrder = useMemo(
    () => state.order.filter((id) => !state.hidden.includes(id)),
    [state],
  );

  return { state, visibleOrder, toggle, move, reset };
}
