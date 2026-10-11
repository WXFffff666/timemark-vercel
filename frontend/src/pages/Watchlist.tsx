import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clapperboard, Loader2, Plus, Star, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonCard } from '@/components/ui/skeleton-card';

/**
 * v2.31 R5（审计 D3）：观影/追剧清单页——后端 watchlist 路由（task 158）此前
 * 只有 API 没有任何前端入口。待看/在看/看完/弃剧 四态 + 类型筛选 + 评分 + 上映日期。
 */

type WatchKind = 'film' | 'series' | 'book' | 'game' | 'other';
type WatchStatus = 'wanted' | 'in_progress' | 'done' | 'dropped';

interface WatchItem {
  id: number;
  kind: WatchKind;
  title: string;
  status: WatchStatus;
  release_date: string | null;
  link: string | null;
  rating: number | null;
  note: string;
}

const KIND_LABELS: Record<WatchKind, string> = { film: '电影', series: '剧集', book: '书', game: '游戏', other: '其他' };
const STATUS_LABELS: Record<WatchStatus, string> = { wanted: '想看', in_progress: '在看', done: '看完', dropped: '弃了' };
const STATUS_ORDER: WatchStatus[] = ['wanted', 'in_progress', 'done', 'dropped'];

const KIND_TABS: Array<[WatchKind | '', string]> = [
  ['', '全部'],
  ['film', '电影'],
  ['series', '剧集'],
  ['book', '书'],
  ['game', '游戏'],
  ['other', '其他'],
];

export default function Watchlist() {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState<WatchKind | ''>('');
  const [statusFilter, setStatusFilter] = useState<WatchStatus | ''>('');
  const [newTitle, setNewTitle] = useState('');
  const [newKind, setNewKind] = useState<WatchKind>('film');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<{ items: WatchItem[] }>('/watchlist')
      .then((d) => setItems(d.items ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () =>
      items.filter(
        (it) => (!kindFilter || it.kind === kindFilter) && (!statusFilter || it.status === statusFilter),
      ),
    [items, kindFilter, statusFilter],
  );

  const upcoming = useMemo(
    () =>
      items
        .filter((it) => it.release_date && it.release_date >= new Date().toISOString().slice(0, 10) && it.status !== 'done')
        .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''))
        .slice(0, 5),
    [items],
  );

  const add = async () => {
    if (!newTitle.trim()) {
      setError('请填写标题');
      return;
    }
    setAdding(true);
    setError('');
    try {
      await api.post('/watchlist', { title: newTitle.trim(), kind: newKind, status: 'wanted' });
      setNewTitle('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const patch = async (id: number, body: Partial<{ status: WatchStatus; rating: number | null }>) => {
    setBusyId(id);
    setError('');
    try {
      await api.patch(`/watchlist/${id}`, body);
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...body } : it)));
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新失败');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: number) => {
    if (!confirm('确定删除该条目？')) return;
    setBusyId(id);
    try {
      await api.delete(`/watchlist/${id}`);
      setItems((prev) => prev.filter((it) => it.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="观影清单"
        subtitle="想看 / 在看 / 看完 · 电影剧集书游戏"
        back="smart"
        onRefresh={load}
        refreshing={loading}
      />

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-5">
        {/* 快速添加 */}
        <div className="glass-panel rounded-3xl p-4 flex flex-wrap gap-2 items-center">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="标题（如：沙丘 3）"
            aria-label="新条目标题"
            className="flex-1 min-w-[10rem]"
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as WatchKind)}
            aria-label="类型"
            className="h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white"
          >
            {Object.entries(KIND_LABELS).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <Button onClick={() => void add()} disabled={adding} aria-label="添加到清单">
            {adding ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Plus className="w-4 h-4 mr-1" aria-hidden />}
            添加
          </Button>
        </div>

        {error && (
          <p role="alert" className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/10 px-4 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </p>
        )}

        {/* 即将上映 */}
        {upcoming.length > 0 && (
          <section aria-label="即将上映">
            <h2 className="text-sm font-bold text-hint mb-2 px-1">即将上映</h2>
            <ul className="space-y-1.5">
              {upcoming.map((it) => (
                <li key={it.id} className="glass-panel rounded-2xl px-4 py-2.5 text-sm flex items-center gap-3">
                  <Badge variant="outline" className="scale-90 shrink-0">{KIND_LABELS[it.kind]}</Badge>
                  <span className="font-medium text-slate-800 dark:text-slate-100 truncate">{it.title}</span>
                  <span className="ml-auto text-xs text-slate-400 shrink-0 tabular-nums">{it.release_date}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 筛选 */}
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden" role="tablist" aria-label="状态筛选">
            {([['', '全部'], ...STATUS_ORDER.map((s) => [s, STATUS_LABELS[s]] as const)] as const).map(([v, label]) => (
              <button
                key={v || 'all'}
                role="tab"
                aria-selected={statusFilter === v}
                onClick={() => setStatusFilter(v as WatchStatus | '')}
                className={`px-3 h-9 text-xs transition ${statusFilter === v ? 'bg-primary-500/10 text-primary-600 dark:text-primary-300 font-semibold' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden" role="tablist" aria-label="类型筛选">
            {KIND_TABS.map(([v, label]) => (
              <button
                key={v || 'all'}
                role="tab"
                aria-selected={kindFilter === v}
                onClick={() => setKindFilter(v as WatchKind | '')}
                className={`px-3 h-9 text-xs transition ${kindFilter === v ? 'bg-primary-500/10 text-primary-600 dark:text-primary-300 font-semibold' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 列表 */}
        {loading ? (
          <SkeletonCard count={4} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Clapperboard} title="清单是空的" description="添加想看的电影/剧集/书/游戏，追踪观看到哪一集" />
        ) : (
          <ul className="space-y-2.5">
            {filtered.map((it) => (
              <li key={it.id} className="glass-panel rounded-2xl p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-slate-900 dark:text-white truncate">{it.title}</h3>
                      <Badge variant="outline" className="scale-90">{KIND_LABELS[it.kind]}</Badge>
                      {it.rating !== null && (
                        <span className="flex items-center gap-0.5 text-xs text-amber-500" aria-label={`评分 ${it.rating}`}>
                          <Star size={12} className="fill-amber-400" aria-hidden /> {it.rating}
                        </span>
                      )}
                    </div>
                    {it.release_date && <p className="text-xs text-slate-400 mt-0.5">上映/发布：{it.release_date}</p>}
                    {it.note && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 whitespace-pre-wrap">{it.note}</p>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    <select
                      value={it.status}
                      onChange={(e) => void patch(it.id, { status: e.target.value as WatchStatus })}
                      disabled={busyId === it.id}
                      aria-label={`更新「${it.title}」状态`}
                      className="h-9 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-900 dark:text-white"
                    >
                      {STATUS_ORDER.map((s) => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="min-h-9 min-w-9 text-slate-400 hover:text-amber-500"
                      aria-label={`为「${it.title}」评 8 分`}
                      title="记 8 分"
                      disabled={busyId === it.id}
                      onClick={() => void patch(it.id, { rating: it.rating === 8 ? null : 8 })}
                    >
                      <Star size={15} className={it.rating === 8 ? 'fill-amber-400 text-amber-500' : ''} aria-hidden />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="min-h-9 min-w-9 text-red-500"
                      aria-label={`删除「${it.title}」`}
                      disabled={busyId === it.id}
                      onClick={() => void remove(it.id)}
                    >
                      {busyId === it.id ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Trash2 size={15} aria-hidden />}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
