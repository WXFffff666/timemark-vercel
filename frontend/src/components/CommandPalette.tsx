import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlarmClock,
  Calendar,
  FileText,
  Inbox,
  MessageSquare,
  Package,
  Repeat,
  Search,
  Target,
  Users,
  Wrench,
} from 'lucide-react';
import { GLOBAL_SEARCH_TYPES, globalSearch } from '@/lib/api';
import type { GlobalSearchFacets, GlobalSearchHit, GlobalSearchType } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

/**
 * checkbox 132: the keyboard-first command palette (Ctrl/Cmd+K).
 *
 * A self-contained overlay mounted once from App (like AssistantDock). It searches ALL ten
 * entity types through `GET /api/search` and renders ranked hits + per-type facet chips.
 *
 * Keyboard-first + lazy: the palette opens on Ctrl/Cmd+K, the input takes focus, arrow keys move
 * the active option, Enter opens it, Esc closes. Opening issues NO network request - a call is
 * made only after the user types, debounced, and never for a blank query. Facet chips reuse the
 * glass primitives and re-run the search filtered to one type.
 */

const DEBOUNCE_MS = 180;

const TYPE_LABELS: Record<GlobalSearchType, string> = {
  event: '事件',
  contact: '联系人',
  interaction: '互动',
  document: '证件',
  expiry: '到期',
  inventory: '物品',
  maintenance: '保养',
  habit: '习惯',
  goal: '目标',
  inbox: '收件箱',
};

const TYPE_ROUTES: Record<GlobalSearchType, string> = {
  event: '/calendar',
  contact: '/contacts',
  interaction: '/contacts',
  document: '/documents',
  expiry: '/expiry',
  inventory: '/inventory',
  maintenance: '/maintenance',
  habit: '/habits',
  goal: '/goals',
  inbox: '/inbox',
};

function TypeIcon({ type, size = 16 }: { type: GlobalSearchType; size?: number }) {
  switch (type) {
    case 'event':
      return <Calendar size={size} aria-hidden />;
    case 'contact':
      return <Users size={size} aria-hidden />;
    case 'interaction':
      return <MessageSquare size={size} aria-hidden />;
    case 'document':
      return <FileText size={size} aria-hidden />;
    case 'expiry':
      return <AlarmClock size={size} aria-hidden />;
    case 'inventory':
      return <Package size={size} aria-hidden />;
    case 'maintenance':
      return <Wrench size={size} aria-hidden />;
    case 'habit':
      return <Repeat size={size} aria-hidden />;
    case 'goal':
      return <Target size={size} aria-hidden />;
    case 'inbox':
      return <Inbox size={size} aria-hidden />;
    default:
      return <Search size={size} aria-hidden />;
  }
}

export function CommandPalette() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchHit[]>([]);
  const [facets, setFacets] = useState<GlobalSearchFacets | null>(null);
  const [activeType, setActiveType] = useState<GlobalSearchType | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);

  // Global shortcut: Ctrl/Cmd+K toggles, Esc closes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // On open: reset state and focus the input. This deliberately issues NO request.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setFacets(null);
    setActiveType(null);
    setActiveIndex(0);
    setLoading(false);
    setError(null);
    inputRef.current?.focus();
  }, [open]);

  // Debounced search: fires ONLY when the (trimmed) query is non-empty, so opening the palette
  // with an empty box never touches the network. The sequence guard drops stale responses.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed === '') {
      requestSeq.current += 1;
      setResults([]);
      setFacets(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    const timer = window.setTimeout(() => {
      globalSearch(trimmed, activeType ? { types: [activeType] } : {})
        .then((data) => {
          if (seq !== requestSeq.current) return;
          setResults(data.results);
          setFacets(data.facets);
          setActiveIndex(0);
          setError(null);
        })
        .catch((err: unknown) => {
          if (seq !== requestSeq.current) return;
          setResults([]);
          setError(err instanceof Error ? err.message : '搜索失败');
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, open, activeType]);

  const activate = useCallback(
    (hit: GlobalSearchHit) => {
      navigate(TYPE_ROUTES[hit.owner_type]);
      setOpen(false);
    },
    [navigate],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = results[activeIndex];
      if (hit) activate(hit);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const excluded =
    location.pathname === '/login' ||
    location.pathname.startsWith('/share/') ||
    location.pathname.startsWith('/embed/');

  if (!isAuthenticated || excluded) return null;
  if (!open) return null;

  const trimmed = query.trim();
  const activeFacets = facets
    ? GLOBAL_SEARCH_TYPES.filter((type) => (facets[type] ?? 0) > 0)
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        className="absolute inset-0 bg-slate-950/30 backdrop-blur-sm"
        aria-hidden
        onClick={() => setOpen(false)}
      />
      <div
        data-testid="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        className="glass-panel relative z-10 w-full max-w-xl overflow-hidden rounded-2xl"
      >
        <div className="flex items-center gap-2 border-b border-white/40 px-4 py-3 dark:border-white/10">
          <Search size={18} className="shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
          <input
            ref={inputRef}
            data-testid="command-palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? `command-palette-option-${activeIndex}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索事件、联系人、证件、物品、目标…"
            className="w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100"
          />
        </div>

        {activeFacets.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 py-2" data-testid="command-palette-facets">
            {activeFacets.map((type) => (
              <button
                key={type}
                type="button"
                tabIndex={-1}
                data-testid={`command-palette-facet-${type}`}
                aria-pressed={activeType === type}
                onClick={() => setActiveType((current) => (current === type ? null : type))}
                className={`glass alive-interactive rounded-full px-2.5 py-1 text-xs ${
                  activeType === type
                    ? 'text-primary-600 dark:text-primary-500'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                {TYPE_LABELS[type]} {facets?.[type] ?? 0}
              </button>
            ))}
          </div>
        )}

        <ul
          role="listbox"
          id="command-palette-listbox"
          aria-label="搜索结果"
          data-testid="command-palette-results"
          className="max-h-[50vh] overflow-y-auto py-1"
        >
          {results.map((hit, index) => (
            <li
              key={`${hit.owner_type}:${hit.owner_id}`}
              id={`command-palette-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              data-testid={`command-palette-option-${index}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => activate(hit)}
              className={`flex cursor-pointer items-center gap-3 px-4 py-2 text-sm ${
                index === activeIndex
                  ? 'bg-primary-500/10 text-primary-700 dark:text-primary-400'
                  : 'text-slate-700 dark:text-slate-200'
              }`}
            >
              <span className="shrink-0 text-slate-500 dark:text-slate-400">
                <TypeIcon type={hit.owner_type} />
              </span>
              <span className="min-w-0 flex-1 truncate">{hit.title || '（无标题）'}</span>
              <span className="shrink-0 rounded-full bg-slate-900/5 px-2 py-0.5 text-xs text-slate-500 dark:bg-white/10 dark:text-slate-400">
                {TYPE_LABELS[hit.owner_type]}
              </span>
            </li>
          ))}
        </ul>

        {trimmed !== '' && loading && (
          <p data-testid="command-palette-loading" className="px-4 py-6 text-center text-sm text-hint">
            搜索中…
          </p>
        )}
        {trimmed !== '' && !loading && results.length === 0 && (
          <p data-testid="command-palette-empty" className="px-4 py-6 text-center text-sm text-hint">
            {error ? error : `未找到「${trimmed}」的结果`}
          </p>
        )}
        {trimmed === '' && (
          <p data-testid="command-palette-hint" className="px-4 py-6 text-center text-sm text-hint">
            输入关键词，搜索事件、联系人、互动、证件、到期、物品、保养、习惯、目标和收件箱
          </p>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-white/40 px-4 py-2 text-xs text-hint dark:border-white/10">
          <span>↑↓ 选择</span>
          <span>↵ 打开</span>
          <span>esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
