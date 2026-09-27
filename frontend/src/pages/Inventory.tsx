import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Boxes, Minus, Package, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { useSmartBack } from '@/hooks/useSmartBack';
import { api } from '@/lib/api';
import { daysUntil } from '@/lib/expiry-utils';
import {
  categoryLabel,
  countLowStock,
  formatQuantity,
  groupByCategory,
  inventoryExpiryText,
  isLowStock,
  type InventoryItem,
} from '@/lib/inventory-utils';
import {
  createInventoryItemSchema,
  INVENTORY_CATEGORIES,
  type CreateInventoryItemInput,
  type InventoryCategory,
} from '@timemark/shared';

/**
 * 库存（D12，todo 51）。全部请求走既有 fetch 封装；形状对齐 backend 的 `/api/inventory`。
 *
 * 失败/边界优先：无 expires_at 的库存项必须渲染「无保质期」而不是 NaN 倒计时；
 * 消耗到阈值及以下必须点亮低库存徽章；消耗超过现有数量由后端 400 拒绝，页面只显示错误、不崩溃。
 */

const CATEGORY_OPTIONS = INVENTORY_CATEGORIES.map((category) => ({
  value: category,
  label: categoryLabel(category),
}));

interface InventoryForm {
  name: string;
  category: InventoryCategory;
  quantity: string;
  unit: string;
  lowStockThreshold: string;
  purchasedAt: string;
  expiresAt: string;
  location: string;
  notes: string;
  isActive: boolean;
}

const emptyForm = (): InventoryForm => ({
  name: '',
  category: 'food',
  quantity: '1',
  unit: '',
  lowStockThreshold: '',
  purchasedAt: '',
  expiresAt: '',
  location: '',
  notes: '',
  isActive: true,
});

function toForm(item: InventoryItem): InventoryForm {
  const category = (INVENTORY_CATEGORIES as readonly string[]).includes(item.category)
    ? (item.category as InventoryCategory)
    : 'other';
  return {
    name: item.name,
    category,
    quantity: String(item.quantity),
    unit: item.unit ?? '',
    lowStockThreshold: item.low_stock_threshold == null ? '' : String(item.low_stock_threshold),
    purchasedAt: item.purchased_at ?? '',
    expiresAt: item.expires_at ?? '',
    location: item.location ?? '',
    notes: item.notes ?? '',
    isActive: item.is_active,
  };
}

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function buildPayload(form: InventoryForm): CreateInventoryItemInput {
  return {
    name: form.name.trim(),
    category: form.category,
    quantity: parseNumber(form.quantity) ?? 0,
    unit: form.unit.trim() || null,
    lowStockThreshold: parseNumber(form.lowStockThreshold),
    purchasedAt: form.purchasedAt || null,
    expiresAt: form.expiresAt || null,
    location: form.location.trim() || null,
    notes: form.notes.trim() || null,
    isActive: form.isActive,
  };
}

function SummaryCard({
  testId,
  label,
  value,
  hint,
  tone,
}: {
  testId: string;
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'destructive';
}) {
  return (
    <div
      data-testid={testId}
      data-count={typeof value === 'number' ? value : undefined}
      className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10"
    >
      <p className="text-xs text-hint">{label}</p>
      <p className={`text-2xl font-extrabold mt-1 ${tone === 'destructive' ? 'text-destructive' : 'text-slate-900 dark:text-slate-100'}`}>
        {value}
      </p>
      {hint && <p className="text-[10px] text-hint mt-1">{hint}</p>}
    </div>
  );
}

function InventoryRow({
  item,
  now,
  consuming,
  onConsume,
  onEdit,
  onDelete,
}: {
  item: InventoryItem;
  now: Date;
  consuming: boolean;
  onConsume: (item: InventoryItem) => void;
  onEdit: (item: InventoryItem) => void;
  onDelete: (item: InventoryItem) => void;
}) {
  const lowStock = isLowStock(item);
  const expiry = inventoryExpiryText(item.expires_at, now);
  const isOverdue = expiry.kind === 'overdue';

  return (
    <div
      data-testid={`inventory-item-${item.id}`}
      data-low-stock={lowStock ? 'true' : undefined}
      className={`glass-panel rounded-2xl px-3 py-3 flex items-start gap-3 ${
        isOverdue ? 'ring-1 ring-destructive/30' : 'ring-1 ring-black/5 dark:ring-white/10'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold truncate">{item.name}</span>
          <Badge variant="secondary" className="text-[10px]">{categoryLabel(item.category)}</Badge>
          {lowStock && (
            <span
              data-testid={`inventory-low-stock-badge-${item.id}`}
              data-token="destructive"
              className="inline-flex items-center rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-destructive"
            >
              低库存
            </span>
          )}
          {item.is_active === false && <Badge variant="outline" className="text-[10px]">已停用</Badge>}
        </div>
        <p className="text-xs text-hint mt-1">
          <span data-testid={`inventory-qty-${item.id}`}>{formatQuantity(item.quantity, item.unit)}</span>
          {item.low_stock_threshold != null ? ` · 阈值 ${formatQuantity(item.low_stock_threshold, item.unit)}` : ''}
          {item.location ? ` · ${item.location}` : ''}
        </p>
        <p
          data-testid={`inventory-expiry-${item.id}`}
          data-kind={expiry.kind}
          className={`text-xs mt-1 font-semibold ${isOverdue ? 'text-destructive' : 'text-primary-600 dark:text-primary-400'}`}
        >
          {expiry.text}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={consuming}
          onClick={() => onConsume(item)}
          aria-label={`消耗 ${item.name}`}
        >
          <Minus className={`w-4 h-4 mr-1 ${consuming ? 'animate-pulse' : ''}`} aria-hidden />
          消耗 1
        </Button>
        <Button variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => onEdit(item)} aria-label={`编辑 ${item.name}`}>
          <Pencil className="w-4 h-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => onDelete(item)} aria-label={`删除 ${item.name}`}>
          <Trash2 className="w-4 h-4 text-destructive" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export default function Inventory() {
  const navigate = useNavigate();
  const goBack = useSmartBack('/dashboard');

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [allItems, setAllItems] = useState<InventoryItem[]>([]);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [expiringCount, setExpiringCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [consumingId, setConsumingId] = useState<number | null>(null);

  const [category, setCategory] = useState('');
  const [lowOnly, setLowOnly] = useState<'' | 'true'>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<InventoryForm>(emptyForm());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput), 300);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const loadFiltered = useCallback(async () => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (lowOnly === 'true') params.set('lowStock', 'true');
    if (search.trim()) params.set('q', search.trim());
    params.set('limit', '200');
    const data = await api.get<InventoryItem[]>(`/inventory?${params.toString()}`);
    setItems(Array.isArray(data) ? data : []);
  }, [category, lowOnly, search]);

  const loadSummary = useCallback(async () => {
    try {
      const [all, low, expiring] = await Promise.all([
        api.get<InventoryItem[]>('/inventory?limit=200'),
        api.get<InventoryItem[]>('/inventory/low-stock'),
        api.get<InventoryItem[]>('/inventory/expiring?days=7'),
      ]);
      const allList = Array.isArray(all) ? all : [];
      setAllItems(allList);
      setLowStockCount(Array.isArray(low) ? low.length : countLowStock(allList));
      setExpiringCount(Array.isArray(expiring) ? expiring.length : 0);
    } catch {
      // Summary failure must never blank the list or crash the page.
      setAllItems([]);
      setLowStockCount(0);
      setExpiringCount(0);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadFiltered()
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadFiltered]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const groups = useMemo(() => groupByCategory(items), [items]);

  const expiredCount = useMemo(
    () =>
      allItems.filter((item) => {
        const days = daysUntil(item.expires_at, now);
        return days !== null && days < 0;
      }).length,
    [allItems, now],
  );

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFieldErrors({});
    setOpen(true);
  };

  const openEdit = (item: InventoryItem) => {
    setEditingId(item.id);
    setForm(toForm(item));
    setFieldErrors({});
    setOpen(true);
  };

  const save = async () => {
    setFieldErrors({});
    const payload = buildPayload(form);
    const parsed = createInventoryItemSchema.safeParse(payload);
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (!nextErrors[key]) nextErrors[key] = issue.message;
      }
      setFieldErrors(nextErrors);
      return;
    }
    setSaving(true);
    try {
      if (editingId != null) {
        await api.patch<InventoryItem>(`/inventory/${editingId}`, payload);
        setStatus('库存项已更新');
      } else {
        await api.post<InventoryItem>('/inventory', payload);
        setStatus('库存项已创建');
      }
      setOpen(false);
      await Promise.all([loadFiltered(), loadSummary()]);
    } catch (e) {
      setFieldErrors({ form: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const consume = async (item: InventoryItem, amount: number) => {
    setConsumingId(item.id);
    setStatus('');
    setError('');
    try {
      const updated = await api.post<InventoryItem>(`/inventory/${item.id}/consume`, { quantity: amount });
      if (updated) {
        setItems((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
        setAllItems((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
        setStatus(`「${updated.name}」已消耗 ${amount}${updated.unit ?? ''}`);
      }
      void loadSummary();
    } catch (e) {
      // 400「库存不足」走这里：显示后端消息，绝不静默夹到 0。
      setError(e instanceof Error ? e.message : '消耗失败');
    } finally {
      setConsumingId(null);
    }
  };

  const remove = async (item: InventoryItem) => {
    if (!window.confirm(`确定删除「${item.name}」？`)) return;
    setError('');
    try {
      await api.delete(`/inventory/${item.id}`);
      setStatus(`已删除「${item.name}」`);
      await Promise.all([loadFiltered(), loadSummary()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-4 z-40 px-4 max-w-4xl mx-auto" role="banner" aria-label="库存顶部导航">
        <div className="glass-panel rounded-full px-4 py-3 flex items-center gap-3 ring-1 ring-black/5 dark:ring-white/10">
          <Button variant="ghost" size="icon" className="rounded-full min-h-11 min-w-11" onClick={goBack} aria-label="返回上一页">
            <ArrowLeft size={20} aria-hidden />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold truncate">库存</h1>
            <p className="text-xs text-hint truncate">食品 · 药品 · 耗材 · 低库存提醒</p>
          </div>
          <Button onClick={openCreate} className="rounded-full min-h-11" aria-label="新建库存项">
            <Plus className="w-4 h-4 mr-1" aria-hidden />
            新建
          </Button>
        </div>
      </header>

      <main id="main-content" className="max-w-4xl mx-auto px-4 py-6 space-y-6" tabIndex={-1}>
        <section aria-label="库存概览" className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard testId="inventory-summary-total" label="全部库存" value={allItems.length} hint="当前用户全部项" />
          <SummaryCard testId="inventory-summary-low" label="低库存" value={lowStockCount} hint="达到或低于阈值" tone="destructive" />
          <SummaryCard testId="inventory-summary-expiring" label="临期" value={expiringCount} hint="7 天内（含已过期）" />
          <SummaryCard testId="inventory-summary-expired" label="已过期" value={expiredCount} hint="需尽快处理" tone="destructive" />
        </section>

        <section aria-label="筛选" className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="inventory-filter-category">分类筛选</label>
              <Select
                id="inventory-filter-category"
                aria-label="分类筛选"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">全部分类</option>
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="inventory-filter-low">库存状态</label>
              <Select
                id="inventory-filter-low"
                aria-label="库存状态筛选"
                value={lowOnly}
                onChange={(e) => setLowOnly(e.target.value as '' | 'true')}
              >
                <option value="">全部</option>
                <option value="true">只看低库存</option>
              </Select>
            </div>
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="inventory-filter-search">搜索</label>
              <Input
                id="inventory-filter-search"
                aria-label="搜索名称或存放位置"
                placeholder="搜索名称 / 位置"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
          </div>
        </section>

        {error && (
          <p className="text-sm text-destructive glass-panel rounded-2xl px-4 py-3" role="alert">{error}</p>
        )}
        {status && (
          <p className="text-sm text-hint glass-panel rounded-2xl px-4 py-3" role="status">{status}</p>
        )}

        {loading ? (
          <p className="text-hint text-sm" role="status">加载中…</p>
        ) : items.length === 0 ? (
          <div className="text-center py-16 glass-panel rounded-3xl">
            <Package className="w-12 h-12 mx-auto text-slate-300 dark:text-slate-600 mb-3" aria-hidden />
            <p className="font-semibold text-slate-700 dark:text-slate-200">暂无库存项</p>
            <p className="text-sm text-hint mt-1">记录食品、药品与耗材，临期与低库存自动提醒</p>
            <Button className="mt-4 rounded-full" variant="outline" onClick={openCreate}>
              新建库存项
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <section
                key={group.category}
                data-testid={`inventory-category-${group.category}`}
                aria-label={categoryLabel(group.category)}
                className="space-y-2"
              >
                <h2 className="text-sm font-bold px-1 text-hint">
                  {categoryLabel(group.category)} · {group.items.length}
                </h2>
                {group.items.map((item) => (
                  <InventoryRow
                    key={item.id}
                    item={item}
                    now={now}
                    consuming={consumingId === item.id}
                    onConsume={(row) => consume(row, 1)}
                    onEdit={openEdit}
                    onDelete={remove}
                  />
                ))}
              </section>
            ))}
          </div>
        )}

        <p className="text-[11px] text-hint text-center">
          <Boxes className="w-3 h-3 inline-block mr-1" aria-hidden />
          共 {allItems.length} 项库存 ·
          <button type="button" className="text-primary-600 dark:text-primary-400 underline mx-1" onClick={() => navigate('/dashboard')}>
            返回首页
          </button>
        </p>
      </main>

      <MobileBottomNav />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId != null ? '编辑库存项' : '新建库存项'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="inventory-name">名称 *</label>
              <Input
                id="inventory-name"
                aria-label="名称"
                placeholder="例如：牛奶"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              />
              {fieldErrors.name && <p className="text-xs text-destructive mt-1">{fieldErrors.name}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="inventory-category">分类</label>
                <Select
                  id="inventory-category"
                  aria-label="分类"
                  value={form.category}
                  onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value as InventoryCategory }))}
                >
                  {CATEGORY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="inventory-unit">单位</label>
                <Input
                  id="inventory-unit"
                  aria-label="单位"
                  placeholder="可选，例如 盒 / kg"
                  value={form.unit}
                  onChange={(e) => setForm((prev) => ({ ...prev, unit: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="inventory-quantity">数量 *</label>
                <Input
                  id="inventory-quantity"
                  aria-label="数量"
                  type="number"
                  min={0}
                  step="0.5"
                  value={form.quantity}
                  onChange={(e) => setForm((prev) => ({ ...prev, quantity: e.target.value }))}
                />
                {fieldErrors.quantity && <p className="text-xs text-destructive mt-1">{fieldErrors.quantity}</p>}
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="inventory-threshold">低库存阈值</label>
                <Input
                  id="inventory-threshold"
                  aria-label="低库存阈值"
                  type="number"
                  min={0}
                  step="0.5"
                  placeholder="达到或低于即提醒"
                  value={form.lowStockThreshold}
                  onChange={(e) => setForm((prev) => ({ ...prev, lowStockThreshold: e.target.value }))}
                />
                {fieldErrors.lowStockThreshold && <p className="text-xs text-destructive mt-1">{fieldErrors.lowStockThreshold}</p>}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="inventory-purchased">购买日期</label>
                <Input
                  id="inventory-purchased"
                  aria-label="购买日期"
                  type="date"
                  value={form.purchasedAt}
                  onChange={(e) => setForm((prev) => ({ ...prev, purchasedAt: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="inventory-expires">到期日</label>
                <Input
                  id="inventory-expires"
                  aria-label="到期日"
                  type="date"
                  value={form.expiresAt}
                  onChange={(e) => setForm((prev) => ({ ...prev, expiresAt: e.target.value }))}
                />
                {fieldErrors.expiresAt && <p className="text-xs text-destructive mt-1">{fieldErrors.expiresAt}</p>}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="inventory-location">存放位置</label>
              <Input
                id="inventory-location"
                aria-label="存放位置"
                placeholder="可选，例如 冰箱"
                value={form.location}
                onChange={(e) => setForm((prev) => ({ ...prev, location: e.target.value }))}
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="inventory-notes">备注</label>
              <textarea
                id="inventory-notes"
                aria-label="备注"
                className="w-full min-h-[72px] rounded-2xl border border-slate-300 dark:border-white/10 bg-white/70 dark:bg-black/30 p-3 text-sm text-slate-900 dark:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20"
                value={form.notes}
                onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="rounded"
                checked={form.isActive}
                onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.checked }))}
              />
              启用
            </label>

            {fieldErrors.form && <p className="text-sm text-destructive">{fieldErrors.form}</p>}
            <Button className="w-full min-h-11" onClick={save} disabled={saving} aria-label="保存库存项">
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
