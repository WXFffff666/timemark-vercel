import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, CheckCircle2, Circle, Pencil, Plus, Target, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';
import { dueCountdownLabel, goalPercent } from '@/lib/goals-utils';
import type { GoalStatus, GoalWithMilestones, MilestoneRecord } from '@timemark/shared';

/**
 * 目标与里程碑（plan todo 82，消费 checkbox 81 的 /api/goals）。
 *
 * - 每张目标卡：进度条 + 里程碑清单 + 到期倒计时。
 * - 进度口径：有目标值（target_value）用服务端 clamp 的值进度；否则用
 *   「已完成里程碑 / 总里程碑」百分比（3 个完成 1 个 = 33%）。0 个里程碑 = 0%，
 *   绝不出现 NaN。
 * - 只读展示服务端返回值，任何勾选 / 新增后都重新拉取列表，不维护本地影子状态
 *   （避免离开再返回时看到陈旧缓存）。
 */

const STATUS_LABELS: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  done: '已完成',
  abandoned: '已放弃',
};

const STATUS_VARIANTS: Record<GoalStatus, 'default' | 'secondary' | 'success' | 'outline'> = {
  active: 'default',
  paused: 'secondary',
  done: 'success',
  abandoned: 'outline',
};

interface GoalForm {
  title: string;
  category: string;
  targetValue: string;
  unit: string;
  targetDate: string;
}

const emptyForm = (): GoalForm => ({ title: '', category: '', targetValue: '', unit: '', targetDate: '' });

function toForm(goal: GoalWithMilestones): GoalForm {
  return {
    title: goal.title,
    category: goal.category ?? '',
    targetValue: goal.target_value == null ? '' : String(goal.target_value),
    unit: goal.unit ?? '',
    targetDate: goal.target_date ?? '',
  };
}

export default function Goals() {
  const [goals, setGoals] = useState<GoalWithMilestones[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<GoalForm>(emptyForm());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  /** Uncontrolled milestone inputs: read the DOM value at click/Enter time so a
   *  pending list refresh can never swallow a keystroke into stale state. */
  const milestoneInputs = useRef<Record<number, HTMLInputElement | null>>({});

  // v2.27 F43：排序键 + 方向（服务端 ?sort=/order= 支持）
  const [sortBy, setSortBy] = useState<'created_at' | 'title' | 'status'>('created_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const load = useCallback(async () => {
    const list = await api.get<GoalWithMilestones[]>(`/goals?sort=${sortBy}&order=${sortOrder}`);
    setGoals(Array.isArray(list) ? list : []);
  }, [sortBy, sortOrder]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const refresh = useCallback(async () => {
    setError('');
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '刷新失败');
    }
  }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFieldErrors({});
    setOpen(true);
  };

  const openEdit = (goal: GoalWithMilestones) => {
    setEditingId(goal.id);
    setForm(toForm(goal));
    setFieldErrors({});
    setOpen(true);
  };

  const save = async () => {
    setFieldErrors({});
    const title = form.title.trim();
    if (!title) {
      setFieldErrors({ title: '标题不能为空' });
      return;
    }
    const targetValue = form.targetValue.trim() ? Number(form.targetValue) : null;
    if (targetValue != null && (!Number.isFinite(targetValue) || targetValue <= 0)) {
      setFieldErrors({ targetValue: '目标值必须大于 0' });
      return;
    }
    const payload = {
      title,
      category: form.category.trim() || null,
      targetValue,
      unit: form.unit.trim() || null,
      targetDate: form.targetDate || null,
    };
    setSaving(true);
    try {
      if (editingId != null) {
        await api.patch<GoalWithMilestones>(`/goals/${editingId}`, payload);
        setStatus('目标已更新');
      } else {
        await api.post<GoalWithMilestones>('/goals', payload);
        setStatus('目标已创建');
      }
      setOpen(false);
      await refresh();
    } catch (e) {
      setFieldErrors({ form: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (goal: GoalWithMilestones) => {
    if (!window.confirm(`确定删除「${goal.title}」？`)) return;
    setError('');
    setBusyId(goal.id);
    try {
      await api.delete(`/goals/${goal.id}`);
      setStatus(`已删除「${goal.title}」`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  const toggleMilestone = async (goal: GoalWithMilestones, milestone: MilestoneRecord) => {
    setError('');
    setBusyId(goal.id);
    try {
      await api.post<MilestoneRecord>(`/goals/${goal.id}/milestones/${milestone.id}/toggle`, {});
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新里程碑失败');
    } finally {
      setBusyId(null);
    }
  };

  const addMilestone = async (goal: GoalWithMilestones) => {
    const input = milestoneInputs.current[goal.id];
    const title = (input?.value ?? '').trim();
    if (!title) return;
    // Clear synchronously before the request so a slow round-trip can never wipe
    // a keystroke the user typed while the previous add was still in flight.
    if (input) input.value = '';
    setError('');
    setBusyId(goal.id);
    try {
      await api.post<MilestoneRecord>(`/goals/${goal.id}/milestones`, { title });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加里程碑失败');
    } finally {
      setBusyId(null);
    }
  };

  const changeStatus = async (goal: GoalWithMilestones, next: GoalStatus) => {
    setError('');
    setBusyId(goal.id);
    try {
      await api.patch<GoalWithMilestones>(`/goals/${goal.id}`, { status: next });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新状态失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="目标"
        subtitle="目标卡片 · 里程碑清单 · 到期倒计时"
        back="smart"
        actions={
          <Button onClick={openCreate} className="rounded-full min-h-11" aria-label="新建目标">
            <Plus className="w-4 h-4 mr-1" aria-hidden />
            新建
          </Button>
        }
      />

      <main id="main-content" className="max-w-4xl mx-auto px-4 py-6 space-y-4" tabIndex={-1}>
        {/* v2.27 F43：排序工具条 */}
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
            aria-label="排序字段"
          >
            <option value="created_at">按创建时间</option>
            <option value="title">按名称</option>
            <option value="status">按状态</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full min-h-10"
            aria-label="切换排序方向"
            onClick={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
          >
            {sortOrder === 'asc' ? '↑ 升序' : '↓ 降序'}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive glass-panel rounded-2xl px-4 py-3" role="alert">{error}</p>}
        {status && <p className="text-sm text-hint glass-panel rounded-2xl px-4 py-3" role="status">{status}</p>}

        {loading ? (
          <p className="text-hint text-sm" role="status">加载中…</p>
        ) : goals.length === 0 ? (
          <div data-testid="goal-empty">
            <EmptyState
              icon={Target}
              title="还没有目标"
              description="创建第一个目标，用里程碑把大计划拆成小步"
              action={
                <Button className="rounded-full" variant="outline" onClick={openCreate}>
                  新建目标
                </Button>
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {goals.map((goal) => {
              const percent = goalPercent(goal);
              const due = dueCountdownLabel(goal.target_date);
              const isBusy = busyId === goal.id;
              return (
                <article
                  key={goal.id}
                  data-testid={`goal-card-${goal.id}`}
                  className="glass-panel rounded-[2rem] p-5 ring-1 ring-black/5 dark:ring-white/10 flex flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="text-lg font-bold text-slate-900 dark:text-white truncate" title={goal.title}>
                        {goal.title}
                      </h2>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Badge variant={STATUS_VARIANTS[goal.status]} className="text-[10px]">
                          {STATUS_LABELS[goal.status]}
                        </Badge>
                        {goal.category && <Badge variant="outline" className="text-[10px]">{goal.category}</Badge>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11"
                        onClick={() => openEdit(goal)}
                        aria-label={`编辑 ${goal.title}`}
                        data-testid={`goal-edit-${goal.id}`}
                      >
                        <Pencil className="w-4 h-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11"
                        onClick={() => remove(goal)}
                        disabled={isBusy}
                        aria-label={`删除 ${goal.title}`}
                        data-testid={`goal-delete-${goal.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" aria-hidden />
                      </Button>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span
                        data-testid={`goal-progress-${goal.id}`}
                        data-percent={percent}
                        className="font-bold text-primary-600 dark:text-primary-400"
                      >
                        {percent}%
                      </span>
                      <span className="text-hint">
                        {goal.target_value != null
                          ? `${goal.current_value}/${goal.target_value}${goal.unit ? ` ${goal.unit}` : ''}`
                          : `${goal.milestone_done_count}/${goal.milestone_count} 里程碑`}
                      </span>
                    </div>
                    <div
                      className="h-2 w-full rounded-full bg-slate-200/80 dark:bg-white/10 overflow-hidden"
                      role="progressbar"
                      aria-label={`${goal.title} 进度`}
                      aria-valuenow={percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        data-testid={`goal-progress-bar-${goal.id}`}
                        className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-[width] duration-500 motion-reduce:transition-none"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>

                  {due && (
                    <p data-testid={`goal-due-${goal.id}`} className="flex items-center gap-1 text-xs text-hint">
                      <CalendarClock className="w-3.5 h-3.5" aria-hidden />
                      目标日期 {goal.target_date} · {due}
                    </p>
                  )}

                  <div className="border-t border-slate-200/60 dark:border-slate-700/50 pt-3">
                    <p className="text-xs font-bold text-hint mb-2">里程碑 · {goal.milestone_done_count}/{goal.milestone_count}</p>
                    <ul className="space-y-1">
                      {goal.milestones.map((milestone) => {
                        const done = milestone.done_at != null;
                        const milestoneDue = dueCountdownLabel(milestone.due_at);
                        return (
                          <li
                            key={milestone.id}
                            data-testid={`milestone-row-${milestone.id}`}
                            className="flex items-center gap-2"
                          >
                            <button
                              type="button"
                              data-testid={`milestone-toggle-${milestone.id}`}
                              data-done={done ? 'true' : 'false'}
                              aria-pressed={done}
                              aria-label={`${done ? '取消完成' : '完成'}里程碑 ${milestone.title}`}
                              disabled={isBusy}
                              onClick={() => toggleMilestone(goal, milestone)}
                              className="shrink-0 min-h-11 min-w-11 flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40"
                            >
                              {done ? (
                                <CheckCircle2 className="w-5 h-5 text-primary-500" aria-hidden />
                              ) : (
                                <Circle className="w-5 h-5 text-slate-400 dark:text-slate-500" aria-hidden />
                              )}
                            </button>
                            <span
                              data-testid={`milestone-title-${milestone.id}`}
                              className={`flex-1 min-w-0 truncate text-sm ${done ? 'line-through text-hint' : 'text-slate-700 dark:text-slate-200'}`}
                              title={milestone.title}
                            >
                              {milestone.title}
                            </span>
                            {milestoneDue && <span className="shrink-0 text-[10px] text-hint">{milestoneDue}</span>}
                          </li>
                        );
                      })}
                    </ul>

                    <div className="flex items-center gap-2 mt-2">
                      <Input
                        ref={(el) => {
                          milestoneInputs.current[goal.id] = el;
                        }}
                        data-testid={`milestone-input-${goal.id}`}
                        aria-label="里程碑标题"
                        placeholder="添加里程碑…"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addMilestone(goal);
                        }}
                        className="h-10"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-10 shrink-0"
                        data-testid={`milestone-add-${goal.id}`}
                        disabled={isBusy}
                        onClick={() => addMilestone(goal)}
                        aria-label="添加里程碑"
                      >
                        <Plus className="w-4 h-4" aria-hidden />
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-hint">状态</span>
                    <Select
                      data-testid={`goal-status-${goal.id}`}
                      aria-label={`${goal.title} 状态`}
                      className="h-10 w-36"
                      value={goal.status}
                      disabled={isBusy}
                      onChange={(e) => changeStatus(goal, e.target.value as GoalStatus)}
                    >
                      {(Object.keys(STATUS_LABELS) as GoalStatus[]).map((value) => (
                        <option key={value} value={value}>{STATUS_LABELS[value]}</option>
                      ))}
                    </Select>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      <MobileBottomNav />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto overscroll-contain max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId != null ? '编辑目标' : '新建目标'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="goal-title">目标名称</label>
              <Input
                id="goal-title"
                aria-label="目标名称"
                placeholder="例如：读完 12 本书"
                maxLength={200}
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              />
              {fieldErrors.title && <p className="text-xs text-destructive mt-1">{fieldErrors.title}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="goal-category">分类</label>
                <Input
                  id="goal-category"
                  aria-label="分类"
                  placeholder="可选，如 学习 / 健身"
                  value={form.category}
                  onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="goal-target-date">目标日期</label>
                <Input
                  id="goal-target-date"
                  aria-label="目标日期"
                  type="date"
                  value={form.targetDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, targetDate: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="goal-target-value">目标值（可选）</label>
                <Input
                  id="goal-target-value"
                  aria-label="目标值"
                  type="number"
                  min={1}
                  placeholder="留空 = 纯里程碑目标"
                  value={form.targetValue}
                  onChange={(e) => setForm((prev) => ({ ...prev, targetValue: e.target.value }))}
                />
                {fieldErrors.targetValue && <p className="text-xs text-destructive mt-1">{fieldErrors.targetValue}</p>}
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="goal-unit">单位</label>
                <Input
                  id="goal-unit"
                  aria-label="单位"
                  placeholder="可选，如 本 / 公里"
                  value={form.unit}
                  onChange={(e) => setForm((prev) => ({ ...prev, unit: e.target.value }))}
                />
              </div>
            </div>

            {fieldErrors.form && <p className="text-sm text-destructive">{fieldErrors.form}</p>}
            <Button className="w-full min-h-11" onClick={save} disabled={saving} aria-label="保存目标">
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
