import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Gauge, Pencil, Plus, Trash2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { api } from '@/lib/api';
import { daysUntil } from '@/lib/expiry-utils';
import {
  assetKindLabel,
  maintenanceDueText,
  usageProgress,
  usageUnitLabel,
  type MaintenancePlan,
} from '@/lib/maintenance-utils';
import {
  ASSET_KINDS,
  createMaintenancePlanSchema,
  NO_INTERVAL_MESSAGE,
  USAGE_UNITS,
  type AssetKind,
  type CreateMaintenancePlanInput,
  type UsageUnit,
} from '@timemark/shared';

/**
 * 保养（D12，todo 51）。全部请求走既有 fetch 封装；形状对齐 backend 的 `/api/maintenance`。
 *
 * 「记录保养」对话框 POST `/maintenance/:id/log`，后端重算 next_due_at / next_due_usage，
 * 页面用返回的 plan 断言真实日期变化（不是本地猜测）。带用量间隔的计划必须填写本次用量读数。
 */

const KIND_OPTIONS = ASSET_KINDS.map((kind) => ({ value: kind, label: assetKindLabel(kind) }));
const UNIT_OPTIONS = USAGE_UNITS.map((unit) => ({ value: unit, label: usageUnitLabel(unit) }));

interface PlanForm {
  assetName: string;
  assetKind: AssetKind;
  intervalDays: string;
  intervalUsage: string;
  usageUnit: '' | UsageUnit;
  currentUsage: string;
  nextDueUsage: string;
  lastDoneAt: string;
  nextDueAt: string;
  notes: string;
  isActive: boolean;
}

const emptyForm = (): PlanForm => ({
  assetName: '',
  assetKind: 'vehicle',
  intervalDays: '',
  intervalUsage: '',
  usageUnit: 'km',
  currentUsage: '',
  nextDueUsage: '',
  lastDoneAt: '',
  nextDueAt: '',
  notes: '',
  isActive: true,
});

function toForm(plan: MaintenancePlan): PlanForm {
  const assetKind = (ASSET_KINDS as readonly string[]).includes(plan.asset_kind)
    ? (plan.asset_kind as AssetKind)
    : 'other';
  const usageUnit = (USAGE_UNITS as readonly string[]).includes(plan.usage_unit ?? '')
    ? (plan.usage_unit as UsageUnit)
    : '';
  return {
    assetName: plan.asset_name,
    assetKind,
    intervalDays: plan.interval_days == null ? '' : String(plan.interval_days),
    intervalUsage: plan.interval_usage == null ? '' : String(plan.interval_usage),
    usageUnit,
    currentUsage: plan.current_usage == null ? '' : String(plan.current_usage),
    nextDueUsage: plan.next_due_usage == null ? '' : String(plan.next_due_usage),
    lastDoneAt: plan.last_done_at ?? '',
    nextDueAt: plan.next_due_at ?? '',
    notes: plan.notes ?? '',
    isActive: plan.is_active,
  };
}

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function buildPayload(form: PlanForm): CreateMaintenancePlanInput {
  return {
    assetName: form.assetName.trim(),
    assetKind: form.assetKind,
    intervalDays: parseNumber(form.intervalDays),
    intervalUsage: parseNumber(form.intervalUsage),
    usageUnit: form.usageUnit || null,
    currentUsage: parseNumber(form.currentUsage),
    nextDueUsage: parseNumber(form.nextDueUsage),
    lastDoneAt: form.lastDoneAt || null,
    nextDueAt: form.nextDueAt || null,
    notes: form.notes.trim() || null,
    isActive: form.isActive,
  };
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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

function PlanCard({
  plan,
  now,
  onRecord,
  onEdit,
  onDelete,
}: {
  plan: MaintenancePlan;
  now: Date;
  onRecord: (plan: MaintenancePlan) => void;
  onEdit: (plan: MaintenancePlan) => void;
  onDelete: (plan: MaintenancePlan) => void;
}) {
  const due = maintenanceDueText(plan, now);
  const isOverdue = due.kind === 'overdue';
  const progress = usageProgress(plan);

  return (
    <div
      data-testid={`maintenance-card-${plan.id}`}
      data-overdue={isOverdue ? 'true' : undefined}
      className={`glass-panel rounded-2xl p-4 flex flex-col gap-3 ${
        isOverdue ? 'ring-1 ring-destructive/30' : 'ring-1 ring-black/5 dark:ring-white/10'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold truncate">{plan.asset_name}</span>
            <Badge variant="secondary" className="text-[10px]">{assetKindLabel(plan.asset_kind)}</Badge>
            {plan.is_active === false && <Badge variant="outline" className="text-[10px]">已停用</Badge>}
          </div>
          <p className="text-xs text-hint mt-1">
            <span data-testid={`maintenance-next-due-${plan.id}`}>{plan.next_due_at ?? '—'}</span>
            {' · '}
            {plan.interval_days != null ? `每 ${plan.interval_days} 天` : '按用量'}
            {plan.last_done_at ? ` · 上次 ${plan.last_done_at}` : ''}
          </p>
          <p
            data-testid={`maintenance-due-countdown-${plan.id}`}
            data-kind={due.kind}
            className={`text-xs mt-1 font-semibold ${isOverdue ? 'text-destructive' : 'text-primary-600 dark:text-primary-400'}`}
          >
            {due.text}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            onClick={() => onRecord(plan)}
            aria-label={`记录保养 ${plan.asset_name}`}
          >
            <Wrench className="w-4 h-4 mr-1" aria-hidden />
            记录保养
          </Button>
          <Button variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => onEdit(plan)} aria-label={`编辑 ${plan.asset_name}`}>
            <Pencil className="w-4 h-4" aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => onDelete(plan)} aria-label={`删除 ${plan.asset_name}`}>
            <Trash2 className="w-4 h-4 text-destructive" aria-hidden />
          </Button>
        </div>
      </div>

      {progress ? (
        <div>
          <div className="flex items-center justify-between text-[11px] text-hint mb-1">
            <span data-testid={`maintenance-usage-text-${plan.id}`}>
              {progress.currentLabel} / {progress.nextLabel}
            </span>
            <span>{progress.percentage}%</span>
          </div>
          <div
            data-testid={`maintenance-usage-bar-${plan.id}`}
            role="progressbar"
            aria-label={`${plan.asset_name} 用量进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percentage}
            className="h-2 w-full rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden"
          >
            <div
              className={`h-full rounded-full transition-all ${progress.percentage >= 100 ? 'bg-destructive' : 'bg-primary-500'}`}
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-hint flex items-center gap-1">
          <Gauge className="w-3 h-3" aria-hidden />
          {plan.interval_usage != null ? '待记录用量读数' : '未设置用量间隔'}
        </p>
      )}
    </div>
  );
}

export default function Maintenance() {
  const navigate = useNavigate();

  const [plans, setPlans] = useState<MaintenancePlan[]>([]);
  const [allPlans, setAllPlans] = useState<MaintenancePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const [assetKind, setAssetKind] = useState('');
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const [searchInput, setSearchInput] = useState('');
  // （search 由 useDebouncedValue 派生，见下方）

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<PlanForm>(emptyForm());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [recordPlan, setRecordPlan] = useState<MaintenancePlan | null>(null);
  const [logDoneAt, setLogDoneAt] = useState('');
  const [logUsageAt, setLogUsageAt] = useState('');
  const [logCost, setLogCost] = useState('');
  const [logNotes, setLogNotes] = useState('');
  const [logError, setLogError] = useState('');
  const [logSaving, setLogSaving] = useState(false);

  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // v2.27 E-11：防抖统一走共享 hook（原手写 setTimeout 版已删）
  const search = useDebouncedValue(searchInput, 300);

  const loadFiltered = useCallback(async () => {
    const params = new URLSearchParams();
    if (assetKind) params.set('assetKind', assetKind);
    if (active) params.set('active', active);
    if (search.trim()) params.set('q', search.trim());
    params.set('limit', '200');
    const data = await api.get<MaintenancePlan[]>(`/maintenance?${params.toString()}`);
    setPlans(Array.isArray(data) ? data : []);
  }, [assetKind, active, search]);

  const loadSummary = useCallback(async () => {
    try {
      const all = await api.get<MaintenancePlan[]>('/maintenance?limit=200');
      setAllPlans(Array.isArray(all) ? all : []);
    } catch {
      setAllPlans([]);
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

  const summary = useMemo(() => {
    let overdue = 0;
    let soon = 0;
    let usage = 0;
    for (const plan of allPlans) {
      if (plan.is_active === false) continue;
      const days = daysUntil(plan.next_due_at, now);
      if (days !== null && days < 0) overdue += 1;
      else if (days !== null && days <= 30) soon += 1;
      if (plan.interval_usage != null) usage += 1;
    }
    return { overdue, soon, usage };
  }, [allPlans, now]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFieldErrors({});
    setOpen(true);
  };

  const openEdit = (plan: MaintenancePlan) => {
    setEditingId(plan.id);
    setForm(toForm(plan));
    setFieldErrors({});
    setOpen(true);
  };

  const save = async () => {
    setFieldErrors({});
    const payload = buildPayload(form);
    const parsed = createMaintenancePlanSchema.safeParse(payload);
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
        await api.patch<MaintenancePlan>(`/maintenance/${editingId}`, payload);
        setStatus('保养计划已更新');
      } else {
        await api.post<MaintenancePlan>('/maintenance', payload);
        setStatus('保养计划已创建');
      }
      setOpen(false);
      await Promise.all([loadFiltered(), loadSummary()]);
    } catch (e) {
      setFieldErrors({ form: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (plan: MaintenancePlan) => {
    if (!window.confirm(`确定删除「${plan.asset_name}」？`)) return;
    setError('');
    try {
      await api.delete(`/maintenance/${plan.id}`);
      setStatus(`已删除「${plan.asset_name}」`);
      await Promise.all([loadFiltered(), loadSummary()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const openRecord = (plan: MaintenancePlan) => {
    setRecordPlan(plan);
    setLogDoneAt(ymd(new Date()));
    setLogUsageAt(plan.current_usage == null ? '' : String(plan.current_usage));
    setLogCost('');
    setLogNotes('');
    setLogError('');
  };

  const saveLog = async () => {
    if (!recordPlan) return;
    if (!logDoneAt) {
      setLogError('请填写保养日期');
      return;
    }
    const usageAt = parseNumber(logUsageAt);
    if (recordPlan.interval_usage != null && usageAt == null) {
      setLogError('该计划按用量保养，必须填写本次用量读数');
      return;
    }
    setLogError('');
    setLogSaving(true);
    try {
      const cost = parseNumber(logCost);
      const updated = await api.post<MaintenancePlan>(`/maintenance/${recordPlan.id}/log`, {
        doneAt: logDoneAt,
        usageAt,
        costCents: cost == null ? null : Math.round(cost * 100),
        notes: logNotes.trim() || null,
      });
      if (updated) {
        setPlans((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
        setAllPlans((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
        setStatus(`已记录保养，「${updated.asset_name}」下次保养 ${updated.next_due_at ?? '按用量'}`);
      }
      setRecordPlan(null);
      void loadFiltered();
    } catch (e) {
      setLogError(e instanceof Error ? e.message : '记录失败');
    } finally {
      setLogSaving(false);
    }
  };

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="保养"
        subtitle="车辆 · 家电 · 设备 · 按日期或用量"
        back="smart"
        maxWidth="max-w-5xl"
        actions={
          <Button onClick={openCreate} className="rounded-full min-h-11" aria-label="新建保养计划">
            <Plus className="w-4 h-4 mr-1" aria-hidden />
            新建
          </Button>
        }
      />

      <main id="main-content" className="max-w-5xl mx-auto px-4 py-6 space-y-6" tabIndex={-1}>
        <section aria-label="保养概览" className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard testId="maintenance-summary-overdue" label="已逾期" value={summary.overdue} hint="已过下次保养日" tone="destructive" />
          <SummaryCard testId="maintenance-summary-soon" label="30 天内" value={summary.soon} hint="即将到期" />
          <SummaryCard testId="maintenance-summary-usage" label="用量跟踪" value={summary.usage} hint="带用量间隔的计划" />
          <SummaryCard testId="maintenance-summary-total" label="全部计划" value={allPlans.length} hint="当前用户全部计划" />
        </section>

        <section aria-label="筛选" className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="maintenance-filter-kind">资产类型筛选</label>
              <Select
                id="maintenance-filter-kind"
                aria-label="资产类型筛选"
                value={assetKind}
                onChange={(e) => setAssetKind(e.target.value)}
              >
                <option value="">全部类型</option>
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="maintenance-filter-active">状态筛选</label>
              <Select
                id="maintenance-filter-active"
                aria-label="状态筛选"
                value={active}
                onChange={(e) => setActive(e.target.value as '' | 'true' | 'false')}
              >
                <option value="">全部状态</option>
                <option value="true">仅启用</option>
                <option value="false">仅停用</option>
              </Select>
            </div>
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="maintenance-filter-search">搜索资产</label>
              <Input
                id="maintenance-filter-search"
                aria-label="搜索资产"
                placeholder="搜索资产名称"
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
        ) : plans.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="暂无保养计划"
            description="为车辆、家电与设备登记保养间隔，到期或接近用量阈值自动提醒"
            action={
              <Button className="rounded-full" variant="outline" onClick={openCreate}>
                新建保养计划
              </Button>
            }
          />
        ) : (
          <section aria-label="保养计划列表" className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                now={now}
                onRecord={openRecord}
                onEdit={openEdit}
                onDelete={remove}
              />
            ))}
          </section>
        )}

        <p className="text-[11px] text-hint text-center">
          <Wrench className="w-3 h-3 inline-block mr-1" aria-hidden />
          共 {allPlans.length} 个保养计划 ·
          <button type="button" className="text-primary-600 dark:text-primary-400 underline mx-1" onClick={() => navigate('/dashboard')}>
            返回首页
          </button>
        </p>
      </main>

      <MobileBottomNav />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto overscroll-contain max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId != null ? '编辑保养计划' : '新建保养计划'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-name">资产名称 *</label>
              <Input
                id="maintenance-name"
                aria-label="资产名称"
                placeholder="例如：家用轿车"
                value={form.assetName}
                onChange={(e) => setForm((prev) => ({ ...prev, assetName: e.target.value }))}
              />
              {fieldErrors.assetName && <p className="text-xs text-destructive mt-1">{fieldErrors.assetName}</p>}
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-kind">资产类型</label>
              <Select
                id="maintenance-kind"
                aria-label="资产类型"
                value={form.assetKind}
                onChange={(e) => setForm((prev) => ({ ...prev, assetKind: e.target.value as AssetKind }))}
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </div>

            <fieldset className="space-y-3 border-0 p-0 m-0">
              <legend className="text-sm font-medium">保养间隔（至少填一项）</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-interval-days">按日期间隔（天）</label>
                  <Input
                    id="maintenance-interval-days"
                    aria-label="按日期间隔（天）"
                    type="number"
                    min={1}
                    value={form.intervalDays}
                    onChange={(e) => setForm((prev) => ({ ...prev, intervalDays: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-interval-usage">按用量间隔</label>
                  <Input
                    id="maintenance-interval-usage"
                    aria-label="按用量间隔"
                    type="number"
                    min={1}
                    value={form.intervalUsage}
                    onChange={(e) => setForm((prev) => ({ ...prev, intervalUsage: e.target.value }))}
                  />
                </div>
              </div>
              {fieldErrors.intervalDays && <p className="text-xs text-destructive">{fieldErrors.intervalDays}</p>}
              {!fieldErrors.intervalDays && !form.intervalDays && !form.intervalUsage && (
                <p className="text-xs text-hint">{NO_INTERVAL_MESSAGE}</p>
              )}
            </fieldset>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-usage-unit">用量单位</label>
                <Select
                  id="maintenance-usage-unit"
                  aria-label="用量单位"
                  value={form.usageUnit}
                  onChange={(e) => setForm((prev) => ({ ...prev, usageUnit: e.target.value as '' | UsageUnit }))}
                >
                  <option value="">未指定</option>
                  {UNIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-current-usage">当前用量</label>
                <Input
                  id="maintenance-current-usage"
                  aria-label="当前用量"
                  type="number"
                  min={0}
                  value={form.currentUsage}
                  onChange={(e) => setForm((prev) => ({ ...prev, currentUsage: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-next-due-usage">下次保养用量</label>
                <Input
                  id="maintenance-next-due-usage"
                  aria-label="下次保养用量"
                  type="number"
                  min={0}
                  value={form.nextDueUsage}
                  onChange={(e) => setForm((prev) => ({ ...prev, nextDueUsage: e.target.value }))}
                />
              </div>
            </div>
            {form.intervalUsage && !form.nextDueUsage && (
              <p className="text-xs text-hint">
                填写下次保养用量后，剩余用量进入间隔的 10% 时会写入收件箱提醒
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-last-done">上次保养日期</label>
                <Input
                  id="maintenance-last-done"
                  aria-label="上次保养日期"
                  type="date"
                  value={form.lastDoneAt}
                  onChange={(e) => setForm((prev) => ({ ...prev, lastDoneAt: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-next-due">下次保养日期</label>
                <Input
                  id="maintenance-next-due"
                  aria-label="下次保养日期"
                  type="date"
                  value={form.nextDueAt}
                  onChange={(e) => setForm((prev) => ({ ...prev, nextDueAt: e.target.value }))}
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-notes">备注</label>
              <textarea
                id="maintenance-notes"
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
            <Button className="w-full min-h-11" onClick={save} disabled={saving} aria-label="保存保养计划">
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={recordPlan != null} onOpenChange={(next) => { if (!next) setRecordPlan(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto overscroll-contain max-w-lg">
          <DialogHeader>
            <DialogTitle>记录保养{recordPlan ? ` · ${recordPlan.asset_name}` : ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-log-done">保养日期 *</label>
              <Input
                id="maintenance-log-done"
                aria-label="保养日期"
                type="date"
                value={logDoneAt}
                onChange={(e) => setLogDoneAt(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-log-usage">
                本次用量读数{recordPlan?.interval_usage != null ? ' *' : ''}
              </label>
              <Input
                id="maintenance-log-usage"
                aria-label="本次用量读数"
                type="number"
                min={0}
                value={logUsageAt}
                onChange={(e) => setLogUsageAt(e.target.value)}
              />
              {recordPlan?.interval_usage != null && (
                <p className="text-xs text-hint mt-1">计划按用量保养，记录时必须填写读数（单位 {usageUnitLabel(recordPlan.usage_unit) || '未指定'}）</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-log-cost">费用（元）</label>
              <Input
                id="maintenance-log-cost"
                aria-label="费用（元）"
                type="number"
                min={0}
                step="0.01"
                value={logCost}
                onChange={(e) => setLogCost(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="maintenance-log-notes">记录备注</label>
              <textarea
                id="maintenance-log-notes"
                aria-label="记录备注"
                className="w-full min-h-[72px] rounded-2xl border border-slate-300 dark:border-white/10 bg-white/70 dark:bg-black/30 p-3 text-sm text-slate-900 dark:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20"
                value={logNotes}
                onChange={(e) => setLogNotes(e.target.value)}
              />
            </div>
            {logError && <p className="text-sm text-destructive" role="alert">{logError}</p>}
            <Button className="w-full min-h-11" onClick={saveLog} disabled={logSaving} aria-label="保存保养记录">
              {logSaving ? '保存中…' : '保存记录'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
