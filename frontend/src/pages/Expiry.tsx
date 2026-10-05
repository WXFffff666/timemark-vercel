import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlarmClock, ArrowLeft, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useSmartBack } from '@/hooks/useSmartBack';
import { api } from '@/lib/api';
import { calculateCountdown } from '@/lib/countdown';
import {
  annualiseSpend,
  bucketFor,
  cycleLabel,
  formatExpiryCountdown,
  formatMoney,
  kindLabel,
  parseLocalYmd,
  summariseBuckets,
  type ExpiryBucket,
  type ExpiryCosts,
  type ExpiryItem,
} from '@/lib/expiry-utils';
import { createExpiryItemSchema, EXPIRY_CYCLES, EXPIRY_KINDS } from '@timemark/shared';
import type { CreateExpiryItemInput, ExpiryCycle, ExpiryItemKind } from '@timemark/shared';

/** 到期中心（D1，todo 47）。全部请求走既有 fetch 封装；形状对齐 backend 的 `/api/expiry`。 */

const KIND_OPTIONS = EXPIRY_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) }));
const CYCLE_OPTIONS = EXPIRY_CYCLES.map((cycle) => ({ value: cycle, label: cycleLabel(cycle) }));

interface ExpiryForm {
  kind: ExpiryItemKind;
  title: string;
  vendor: string;
  amount: string;
  currency: string;
  cycle: ExpiryCycle;
  cycleDays: string;
  startDate: string;
  nextDueDate: string;
  autoRenew: boolean;
  notes: string;
  isActive: boolean;
}

const emptyForm = (): ExpiryForm => ({
  kind: 'subscription',
  title: '',
  vendor: '',
  amount: '',
  currency: 'CNY',
  cycle: 'monthly',
  cycleDays: '',
  startDate: '',
  nextDueDate: '',
  autoRenew: false,
  notes: '',
  isActive: true,
});

function toForm(item: ExpiryItem): ExpiryForm {
  const kind = (EXPIRY_KINDS as readonly string[]).includes(item.kind)
    ? (item.kind as ExpiryItemKind)
    : 'custom';
  const cycle = (EXPIRY_CYCLES as readonly string[]).includes(item.cycle)
    ? (item.cycle as ExpiryCycle)
    : 'once';
  return {
    kind,
    title: item.title,
    vendor: item.vendor ?? '',
    amount: item.amount_cents == null ? '' : String(item.amount_cents / 100),
    currency: item.currency || 'CNY',
    cycle,
    cycleDays: item.cycle_days == null ? '' : String(item.cycle_days),
    startDate: item.start_date ?? '',
    nextDueDate: item.next_due_date ?? '',
    autoRenew: item.auto_renew,
    notes: item.notes ?? '',
    isActive: item.is_active,
  };
}

function buildPayload(form: ExpiryForm): CreateExpiryItemInput {
  const trimmed = form.amount.trim();
  const parsedAmount = trimmed === '' ? null : Math.round(Number(trimmed) * 100);
  const amountCents = parsedAmount != null && Number.isFinite(parsedAmount) ? parsedAmount : null;
  return {
    kind: form.kind,
    title: form.title.trim(),
    vendor: form.vendor.trim() || null,
    amountCents,
    currency: form.currency.trim().toUpperCase() || 'CNY',
    cycle: form.cycle,
    cycleDays: form.cycle === 'custom' ? Number(form.cycleDays) : null,
    startDate: form.startDate || null,
    nextDueDate: form.nextDueDate,
    autoRenew: form.autoRenew,
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

function ExpiryRow({
  item,
  now,
  renewing,
  onRenew,
  onEdit,
  onDelete,
}: {
  item: ExpiryItem;
  now: Date;
  renewing: boolean;
  onRenew: (item: ExpiryItem) => void;
  onEdit: (item: ExpiryItem) => void;
  onDelete: (item: ExpiryItem) => void;
}) {
  const bucket: ExpiryBucket = bucketFor(item.next_due_date, now);
  const target = parseLocalYmd(item.next_due_date);
  const countdown = target ? calculateCountdown(target, now) : null;
  const countdownText = countdown
    ? formatExpiryCountdown({
        days: countdown.days,
        hours: countdown.hours,
        minutes: countdown.minutes,
        isPast: countdown.isPast,
      })
    : { kind: 'unknown' as const, text: '无到期日' };
  const isOverdue = bucket === 'overdue';

  return (
    <div
      data-testid={`expiry-item-${item.id}`}
      data-overdue={isOverdue ? 'true' : undefined}
      data-token={isOverdue ? 'destructive' : undefined}
      className={`glass-panel rounded-2xl px-3 py-3 flex items-start gap-3 ${
        isOverdue ? 'ring-1 ring-destructive/30' : 'ring-1 ring-black/5 dark:ring-white/10'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold truncate">{item.title}</span>
          <Badge variant="secondary" className="text-[10px]">{kindLabel(item.kind)}</Badge>
          {isOverdue && (
            <span
              data-testid={`expiry-overdue-badge-${item.id}`}
              data-token="destructive"
              className="inline-flex items-center rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-destructive"
            >
              已逾期
            </span>
          )}
          {item.is_active === false && <Badge variant="outline" className="text-[10px]">已停用</Badge>}
        </div>
        <p className="text-xs text-hint mt-1">
          <span data-testid={`expiry-due-${item.id}`}>{item.next_due_date ?? '—'}</span>
          {' · '}
          {cycleLabel(item.cycle)}
          {item.vendor ? ` · ${item.vendor}` : ''}
          {item.amount_cents != null ? ` · ${formatMoney(item.amount_cents, item.currency)}` : ''}
        </p>
        <p
          data-testid={`expiry-countdown-${item.id}`}
          data-kind={countdownText.kind}
          className={`text-xs mt-1 font-semibold ${isOverdue ? 'text-destructive' : 'text-primary-600 dark:text-primary-400'}`}
        >
          {countdownText.text}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={renewing}
          onClick={() => onRenew(item)}
          aria-label={`续期 ${item.title}`}
        >
          <RefreshCw className={`w-4 h-4 mr-1 ${renewing ? 'animate-spin' : ''}`} aria-hidden />
          续期
        </Button>
        <Button variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => onEdit(item)} aria-label={`编辑 ${item.title}`}>
          <Pencil className="w-4 h-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => onDelete(item)} aria-label={`删除 ${item.title}`}>
          <Trash2 className="w-4 h-4 text-destructive" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function BucketSection({
  testId,
  title,
  items,
  now,
  renewingId,
  onRenew,
  onEdit,
  onDelete,
  tone,
}: {
  testId: string;
  title: string;
  items: ExpiryItem[];
  now: Date;
  renewingId: number | null;
  onRenew: (item: ExpiryItem) => void;
  onEdit: (item: ExpiryItem) => void;
  onDelete: (item: ExpiryItem) => void;
  tone?: 'destructive';
}) {
  if (items.length === 0) return null;
  return (
    <section data-testid={testId} aria-label={title} className="space-y-2">
      <h2 className={`text-sm font-bold px-1 ${tone === 'destructive' ? 'text-destructive' : 'text-hint'}`}>
        {title} · {items.length}
      </h2>
      {items.map((item) => (
        <ExpiryRow
          key={item.id}
          item={item}
          now={now}
          renewing={renewingId === item.id}
          onRenew={onRenew}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </section>
  );
}

export default function Expiry() {
  const navigate = useNavigate();
  const goBack = useSmartBack('/dashboard');

  const [items, setItems] = useState<ExpiryItem[]>([]);
  const [allItems, setAllItems] = useState<ExpiryItem[]>([]);
  const [overdueCount, setOverdueCount] = useState(0);
  const [costs, setCosts] = useState<ExpiryCosts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [renewingId, setRenewingId] = useState<number | null>(null);

  const [kind, setKind] = useState('');
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const [searchInput, setSearchInput] = useState('');
  // （search 由 useDebouncedValue 派生，见下方）

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ExpiryForm>(emptyForm());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // v2.27 E-11：防抖统一走共享 hook（原四处各手写一份 setTimeout 已删）
  const search = useDebouncedValue(searchInput, 300);

  const loadFiltered = useCallback(async () => {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (active) params.set('active', active);
    if (search.trim()) params.set('q', search.trim());
    params.set('limit', '200');
    const data = await api.get<ExpiryItem[]>(`/expiry?${params.toString()}`);
    setItems(Array.isArray(data) ? data : []);
  }, [kind, active, search]);

  const loadSummary = useCallback(async () => {
    try {
      const [all, overdue, costData] = await Promise.all([
        api.get<ExpiryItem[]>('/expiry?limit=200'),
        api.get<ExpiryItem[]>('/expiry/overdue'),
        api.get<ExpiryCosts>('/expiry/costs?granularity=month'),
      ]);
      setAllItems(Array.isArray(all) ? all : []);
      setOverdueCount(Array.isArray(overdue) ? overdue.length : 0);
      setCosts(costData && typeof costData === 'object' && !Array.isArray(costData) ? costData : null);
    } catch {
      // Summary failure must never blank the list or crash the page.
      setAllItems([]);
      setOverdueCount(0);
      setCosts(null);
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

  const buckets = useMemo(() => {
    const grouped: Record<ExpiryBucket, ExpiryItem[]> = { overdue: [], week: [], month: [], later: [], none: [] };
    for (const item of items) grouped[bucketFor(item.next_due_date, now)].push(item);
    return grouped;
  }, [items, now]);

  const summary = useMemo(() => summariseBuckets(allItems, now, overdueCount), [allItems, now, overdueCount]);
  const annual = useMemo(() => annualiseSpend(costs), [costs]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFieldErrors({});
    setOpen(true);
  };

  const openEdit = (item: ExpiryItem) => {
    setEditingId(item.id);
    setForm(toForm(item));
    setFieldErrors({});
    setOpen(true);
  };

  const save = async () => {
    setFieldErrors({});
    const payload = buildPayload(form);
    const parsed = createExpiryItemSchema.safeParse(payload);
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
        await api.patch<ExpiryItem>(`/expiry/${editingId}`, payload);
        setStatus('到期项已更新');
      } else {
        await api.post<ExpiryItem>('/expiry', payload);
        setStatus('到期项已创建');
      }
      setOpen(false);
      await Promise.all([loadFiltered(), loadSummary()]);
    } catch (e) {
      setFieldErrors({ form: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const renew = async (item: ExpiryItem) => {
    setRenewingId(item.id);
    setStatus('');
    setError('');
    try {
      const result = await api.post<{ item: ExpiryItem }>(`/expiry/${item.id}/renew`);
      const updated = result?.item;
      if (updated) {
        setItems((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
        setAllItems((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
        setStatus(`「${updated.title}」已续期至 ${updated.next_due_date}`);
      }
      void loadSummary();
    } catch (e) {
      setError(e instanceof Error ? e.message : '续期失败');
    } finally {
      setRenewingId(null);
    }
  };

  const remove = async (item: ExpiryItem) => {
    if (!window.confirm(`确定删除「${item.title}」？`)) return;
    setError('');
    try {
      await api.delete(`/expiry/${item.id}`);
      setStatus(`已删除「${item.title}」`);
      await Promise.all([loadFiltered(), loadSummary()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-4 z-40 px-4 max-w-4xl mx-auto" role="banner" aria-label="到期中心顶部导航">
        <div className="glass-panel rounded-full px-4 py-3 flex items-center gap-3 ring-1 ring-black/5 dark:ring-white/10">
          <Button variant="ghost" size="icon" className="rounded-full min-h-11 min-w-11" onClick={goBack} aria-label="返回上一页">
            <ArrowLeft size={20} aria-hidden />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold truncate">到期中心</h1>
            <p className="text-xs text-hint truncate">订阅 · 账单 · 保险 · 域名 · 保修</p>
          </div>
          <Button onClick={openCreate} className="rounded-full min-h-11" aria-label="新建到期项">
            <Plus className="w-4 h-4 mr-1" aria-hidden />
            新建
          </Button>
        </div>
      </header>

      <main id="main-content" className="max-w-4xl mx-auto px-4 py-6 space-y-6" tabIndex={-1}>
        <section aria-label="到期概览" className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard testId="expiry-summary-overdue" label="已逾期" value={summary.overdue} hint="需尽快处理" tone="destructive" />
          <SummaryCard testId="expiry-summary-week" label="本周到期" value={summary.week} hint="7 天内" />
          <SummaryCard testId="expiry-summary-month" label="本月到期" value={summary.month} hint="当前自然月" />
          <SummaryCard
            testId="expiry-summary-annual"
            label="年化支出"
            value={annual.text}
            hint={annual.mixed ? '多币种，分币种展示' : '按周期折算 ×12'}
          />
        </section>

        <section aria-label="筛选" className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="expiry-filter-kind">类型</label>
              <Select
                id="expiry-filter-kind"
                aria-label="类型筛选"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="">全部类型</option>
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="expiry-filter-active">状态</label>
              <Select
                id="expiry-filter-active"
                aria-label="启用状态筛选"
                value={active}
                onChange={(e) => setActive(e.target.value as '' | 'true' | 'false')}
              >
                <option value="">全部状态</option>
                <option value="true">仅启用</option>
                <option value="false">仅停用</option>
              </Select>
            </div>
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="expiry-filter-search">搜索</label>
              <Input
                id="expiry-filter-search"
                aria-label="搜索名称或供应商"
                placeholder="搜索名称 / 供应商"
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
            <AlarmClock className="w-12 h-12 mx-auto text-slate-300 dark:text-slate-600 mb-3" aria-hidden />
            <p className="font-semibold text-slate-700 dark:text-slate-200">暂无到期项</p>
            <p className="text-sm text-hint mt-1">记录订阅、账单、保险、域名与保修，到期前自动提醒</p>
            <Button className="mt-4 rounded-full" variant="outline" onClick={openCreate}>
              新建到期项
            </Button>
          </div>
        ) : (
          <>
            <BucketSection
              testId="expiry-bucket-overdue"
              title="已逾期"
              items={buckets.overdue}
              now={now}
              renewingId={renewingId}
              onRenew={renew}
              onEdit={openEdit}
              onDelete={remove}
              tone="destructive"
            />
            <BucketSection
              testId="expiry-bucket-week"
              title="本周到期"
              items={buckets.week}
              now={now}
              renewingId={renewingId}
              onRenew={renew}
              onEdit={openEdit}
              onDelete={remove}
            />
            <BucketSection
              testId="expiry-bucket-month"
              title="本月到期"
              items={buckets.month}
              now={now}
              renewingId={renewingId}
              onRenew={renew}
              onEdit={openEdit}
              onDelete={remove}
            />
            <BucketSection
              testId="expiry-bucket-later"
              title="更晚"
              items={buckets.later}
              now={now}
              renewingId={renewingId}
              onRenew={renew}
              onEdit={openEdit}
              onDelete={remove}
            />
            <BucketSection
              testId="expiry-bucket-none"
              title="无到期日"
              items={buckets.none}
              now={now}
              renewingId={renewingId}
              onRenew={renew}
              onEdit={openEdit}
              onDelete={remove}
            />
          </>
        )}

        <p className="text-[11px] text-hint text-center">
          共 {allItems.length} 项（启用 {summary.overdue + summary.week + summary.month} 项临期）·
          <button type="button" className="text-primary-600 dark:text-primary-400 underline mx-1" onClick={() => navigate('/dashboard')}>
            返回首页
          </button>
        </p>
      </main>

      <MobileBottomNav />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto overscroll-contain max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId != null ? '编辑到期项' : '新建到期项'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="expiry-title">名称 *</label>
              <Input
                id="expiry-title"
                aria-label="名称"
                placeholder="例如：iCloud+ 订阅"
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              />
              {fieldErrors.title && <p className="text-xs text-destructive mt-1">{fieldErrors.title}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="expiry-kind">类型</label>
                <Select
                  id="expiry-kind"
                  aria-label="类型"
                  value={form.kind}
                  onChange={(e) => setForm((prev) => ({ ...prev, kind: e.target.value as ExpiryItemKind }))}
                >
                  {KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="expiry-cycle">续费周期</label>
                <Select
                  id="expiry-cycle"
                  aria-label="续费周期"
                  value={form.cycle}
                  onChange={(e) => setForm((prev) => ({ ...prev, cycle: e.target.value as ExpiryCycle }))}
                >
                  {CYCLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              </div>
            </div>

            {form.cycle === 'custom' && (
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="expiry-cycle-days">自定义周期（天）</label>
                <Input
                  id="expiry-cycle-days"
                  aria-label="自定义周期天数"
                  type="number"
                  min={1}
                  value={form.cycleDays}
                  onChange={(e) => setForm((prev) => ({ ...prev, cycleDays: e.target.value }))}
                />
                {fieldErrors.cycleDays && <p className="text-xs text-destructive mt-1">{fieldErrors.cycleDays}</p>}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="expiry-next-due">下次到期日 *</label>
                <Input
                  id="expiry-next-due"
                  aria-label="下次到期日"
                  type="date"
                  value={form.nextDueDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, nextDueDate: e.target.value }))}
                />
                {fieldErrors.nextDueDate && <p className="text-xs text-destructive mt-1">{fieldErrors.nextDueDate}</p>}
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="expiry-start">开始日期</label>
                <Input
                  id="expiry-start"
                  aria-label="开始日期"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="expiry-amount">金额（元）</label>
                <Input
                  id="expiry-amount"
                  aria-label="金额"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => setForm((prev) => ({ ...prev, amount: e.target.value }))}
                />
                {fieldErrors.amountCents && <p className="text-xs text-destructive mt-1">{fieldErrors.amountCents}</p>}
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="expiry-currency">币种</label>
                <Input
                  id="expiry-currency"
                  aria-label="币种"
                  maxLength={3}
                  value={form.currency}
                  onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value }))}
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="expiry-vendor">供应商</label>
              <Input
                id="expiry-vendor"
                aria-label="供应商"
                placeholder="可选，例如 Apple"
                value={form.vendor}
                onChange={(e) => setForm((prev) => ({ ...prev, vendor: e.target.value }))}
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="expiry-notes">备注</label>
              <textarea
                id="expiry-notes"
                aria-label="备注"
                className="w-full min-h-[72px] rounded-2xl border border-slate-300 dark:border-white/10 bg-white/70 dark:bg-black/30 p-3 text-sm text-slate-900 dark:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20"
                value={form.notes}
                onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
              />
            </div>

            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="rounded"
                  checked={form.autoRenew}
                  onChange={(e) => setForm((prev) => ({ ...prev, autoRenew: e.target.checked }))}
                />
                自动续费
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="rounded"
                  checked={form.isActive}
                  onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.checked }))}
                />
                启用
              </label>
            </div>

            {fieldErrors.form && <p className="text-sm text-destructive">{fieldErrors.form}</p>}
            <Button className="w-full min-h-11" onClick={save} disabled={saving} aria-label="保存到期项">
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
