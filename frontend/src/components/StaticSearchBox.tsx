import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { searchStatic, type StaticSearchHit } from '@/lib/static-search';

/**
 * Static corpus search (plan todo 76c).
 *
 * The MiniSearch index is a static asset that is only fetched + parsed on the
 * FIRST query — so pages that never search pay zero transfer/runtime cost.
 * Results (holidays, 节气, templates, relations, help/docs) never hit the API.
 */

const KIND_LABELS: Record<string, string> = {
  holiday: '节假日',
  workday: '调休',
  'solar-term': '节气',
  'almanac-rule': '黄历',
  template: '模板',
  preset: '套餐',
  relation: '关系',
  doc: '帮助',
};

export function StaticSearchBox() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StaticSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setLoading(false);
      setOpen(false);
      return;
    }
    const id = (requestId.current += 1);
    setLoading(true);
    const timer = setTimeout(() => {
      void searchStatic(trimmed, 8).then((results) => {
        if (id !== requestId.current) return;
        setHits(results);
        setLoading(false);
        setOpen(true);
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <section className="glass-panel rounded-2xl p-3 ring-1 ring-black/5 dark:ring-white/10" data-testid="static-search">
      <label className="flex items-center gap-2 text-sm text-slate-500">
        <Search size={16} className="shrink-0" />
        <span className="sr-only">搜索静态数据</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => hits.length > 0 && setOpen(true)}
          placeholder="搜索节假日 / 节气 / 模板 / 帮助"
          aria-label="搜索节假日、节气、模板与帮助文档"
          className="w-full bg-transparent outline-none placeholder:text-slate-400 text-slate-700 dark:text-slate-200"
        />
        {loading && <span className="text-[10px] text-slate-400 shrink-0">搜索中…</span>}
      </label>
      {open && hits.length > 0 && (
        <ul className="mt-2 space-y-1 max-h-48 overflow-y-auto" role="listbox" aria-label="静态搜索结果">
          {hits.map((hit) => (
            <li
              key={hit.id}
              role="option"
              aria-selected={false}
              className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs bg-slate-50/60 dark:bg-slate-800/40"
            >
              <span className="shrink-0 rounded bg-primary-100 px-1 py-0.5 text-[10px] text-primary-700 dark:bg-primary-900/40 dark:text-primary-200">
                {KIND_LABELS[hit.kind] ?? hit.kind}
              </span>
              <span className="truncate">{hit.title}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
