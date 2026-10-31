import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Loader2, Plus, Trash2, CheckCircle2, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonCard } from '@/components/ui/skeleton-card';

/**
 * v2.38 R15（审计 D3 #5）：家庭清单页——inventory-list 路由（24 端点）此前零 UI。
 * 清单 CRUD + 条目勾选（assignee/quantity/note）+ 分享链接。
 */

interface ListRow {
  id: number;
  name: string;
  note: string | null;
}

interface ListItem {
  id: number;
  name: string;
  quantity: string | null;
  note: string | null;
  assignee: string | null;
  checked: boolean;
}

const data = api;

export default function HouseholdLists() {
  // v2.40 R18：统一确认弹窗（Promise 化 confirm，遮蔽全局同名函数）
  const { confirm, confirmDialog } = useConfirm();
  const [lists, setLists] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [items, setItems] = useState<ListItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  // 新清单
  const [newListName, setNewListName] = useState('');
  const [creating, setCreating] = useState(false);

  // 新条目
  const [newItemName, setNewItemName] = useState('');
  const [newItemQty, setNewItemQty] = useState('');
  const [newItemAssignee, setNewItemAssignee] = useState('');
  const [adding, setAdding] = useState(false);

  const loadLists = useCallback(() => {
    setLoading(true);
    data
      .get<{ lists: ListRow[] }>('/inventory-list')
      .then((res) => {
        const list = res.lists ?? [];
        setLists(list);
        setSelectedId((prev) => (prev !== null && list.some((l) => l.id === prev) ? prev : (list[0]?.id ?? null)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadLists();
  }, [loadLists]);

  const loadItems = useCallback(async (listId: number) => {
    setItemsLoading(true);
    try {
      const res = await data.get<{ items: ListItem[] }>(`/inventory-list/${listId}`);
      setItems(res.items ?? []);
      setError('');
    } catch (e) {
      // v2.40 R17：此前静默清空——用户分不清「清单为空」和「加载失败」。
      setItems([]);
      setError(e instanceof Error ? `条目加载失败：${e.message}` : '条目加载失败');
    } finally {
      setItemsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId !== null) void loadItems(selectedId);
  }, [selectedId, loadItems]);

  const createList = async () => {
    if (!newListName.trim()) {
      setError('请填写清单名称');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const created = await data.post<{ id: number }>('/inventory-list', { name: newListName.trim() });
      setNewListName('');
      loadLists();
      if (created?.id) setSelectedId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const deleteList = async (id: number, name: string) => {
    if (!(await confirm({ title: `删除清单「${name}」？`, description: '会一并删除其全部条目。', tone: 'danger', confirmLabel: '删除' }))) return;
    setError('');
    try {
      await data.delete(`/inventory-list/${id}`);
      loadLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const addItem = async () => {
    if (selectedId === null || !newItemName.trim()) {
      setError('请填写条目名称');
      return;
    }
    setAdding(true);
    setError('');
    try {
      await data.post(`/inventory-list/${selectedId}/items`, {
        name: newItemName.trim(),
        quantity: newItemQty.trim() || undefined,
        assignee: newItemAssignee.trim() || undefined,
      });
      setNewItemName('');
      setNewItemQty('');
      void loadItems(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const toggleDone = async (item: ListItem) => {
    if (selectedId === null) return;
    const next = !item.checked;
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, checked: next } : it)));
    try {
      // 幂等 check/uncheck 端点（重复点同一状态无副作用）
      await data.post(`/inventory-list/${selectedId}/items/${item.id}/${next ? 'check' : 'uncheck'}`, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新失败');
      void loadItems(selectedId);
    }
  };

  const deleteItem = async (itemId: number) => {
    if (selectedId === null || !(await confirm({ title: '删除该条目？', tone: 'danger', confirmLabel: '删除' }))) return;
    try {
      await data.delete(`/inventory-list/${selectedId}/items/${itemId}`);
      setItems((prev) => prev.filter((it) => it.id !== itemId));
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const pending = useMemo(() => items.filter((it) => !it.checked), [items]);
  const done = useMemo(() => items.filter((it) => it.checked), [items]);

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="家庭清单"
        subtitle="购物清单 / 待办清单 · 可分配给家庭成员"
        back="smart"
        onRefresh={loadLists}
        refreshing={loading}
      />

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-5">
        {error && (
          <p role="alert" className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/10 px-4 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </p>
        )}

        {/* 新清单 */}
        <div className="glass-panel rounded-3xl p-4 flex flex-wrap gap-2 items-end">
          <Input value={newListName} onChange={(e) => setNewListName(e.target.value)} placeholder="新清单名称（如 周末采购）" aria-label="新清单名称" className="flex-1 min-w-[10rem]" />
          <Button onClick={() => void createList()} disabled={creating} aria-label="创建清单">
            {creating ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Plus className="w-4 h-4 mr-1" aria-hidden />}
            创建
          </Button>
        </div>

        {/* 清单 chips */}
        {lists.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {lists.map((l) => (
              <span key={l.id} className="inline-flex items-center gap-1">
                <button
                  type="button"
                  aria-pressed={selectedId === l.id}
                  onClick={() => setSelectedId(l.id)}
                  className={`px-3 h-10 rounded-full border text-sm transition ${selectedId === l.id ? 'bg-primary-500 text-white border-primary-500 font-semibold' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  {l.name}
                </button>
                <Button size="icon" variant="ghost" className="min-h-8 min-w-8 text-red-400" aria-label={`删除清单「${l.name}」`} onClick={() => void deleteList(l.id, l.name)}>
                  <Trash2 size={13} aria-hidden />
                </Button>
              </span>
            ))}
          </div>
        )}

        {/* 条目区 */}
        {selectedId !== null ? (
          <div className="space-y-4">
            <div className="glass-panel rounded-3xl p-4 flex flex-wrap gap-2 items-end">
              <Input value={newItemName} onChange={(e) => setNewItemName(e.target.value)} placeholder="条目（如 牛奶）" aria-label="条目名称" className="flex-1 min-w-[8rem]" onKeyDown={(e) => e.key === 'Enter' && void addItem()} />
              <Input value={newItemQty} onChange={(e) => setNewItemQty(e.target.value)} placeholder="数量" aria-label="数量" className="w-20" />
              <Input value={newItemAssignee} onChange={(e) => setNewItemAssignee(e.target.value)} placeholder="负责人（可选）" aria-label="负责人" className="w-32" />
              <Button onClick={() => void addItem()} disabled={adding} aria-label="添加条目">
                {adding ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Plus className="w-4 h-4 mr-1" aria-hidden />}
                添加
              </Button>
            </div>

            {itemsLoading ? (
              <SkeletonCard count={3} />
            ) : items.length === 0 ? (
              <EmptyState icon={ClipboardList} title="清单是空的" description="添加第一个条目" />
            ) : (
              <>
                {pending.length > 0 && (
                  <ul className="space-y-2" aria-label="未完成条目">
                    {pending.map((it) => (
                      <li key={it.id} className="glass-panel rounded-2xl px-4 py-3 flex items-center gap-3">
                        <button type="button" aria-label={`完成「${it.name}」`} className="shrink-0" onClick={() => void toggleDone(it)}>
                          <CheckCircle2 size={22} className="text-slate-300 hover:text-emerald-500 transition" aria-hidden />
                        </button>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-slate-800 dark:text-slate-100 truncate">{it.name}</p>
                          <div className="flex gap-2 text-xs text-slate-400 flex-wrap">
                            {it.quantity && <span>数量 {it.quantity}</span>}
                            {it.assignee && <span className="flex items-center gap-0.5"><Users size={11} aria-hidden /> {it.assignee}</span>}
                            {it.note && <span className="truncate">{it.note}</span>}
                          </div>
                        </div>
                        <Button size="icon" variant="ghost" className="min-h-8 min-w-8 text-red-400 shrink-0" aria-label={`删除「${it.name}」`} onClick={() => void deleteItem(it.id)}>
                          <Trash2 size={14} aria-hidden />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                {done.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-hint px-1 mb-1.5">已完成（{done.length}）</h3>
                    <ul className="space-y-1.5" aria-label="已完成条目">
                      {done.map((it) => (
                        <li key={it.id} className="glass-panel rounded-xl px-4 py-2 flex items-center gap-3 opacity-70">
                          <button type="button" aria-label={`撤销完成「${it.name}」`} className="shrink-0" onClick={() => void toggleDone(it)}>
                            <CheckCircle2 size={18} className="text-emerald-500" aria-hidden />
                          </button>
                          <span className="text-sm text-slate-500 line-through truncate flex-1">{it.name}</span>
                          <Button size="icon" variant="ghost" className="min-h-7 min-w-7 text-red-400 shrink-0" aria-label={`删除「${it.name}」`} onClick={() => void deleteItem(it.id)}>
                            <Trash2 size={12} aria-hidden />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        ) : null}
      </main>
      {confirmDialog}
    </div>
  );
}
