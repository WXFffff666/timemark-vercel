import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flame, Pencil, Plus, Repeat, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';
import {
  createHabitSchema,
  dateStringInTimeZone,
  isHabitScheduledOn,
  isoWeekStartYmd,
  shiftCalendarDays,
} from '@timemark/shared';
import type {
  CreateHabitInput,
  HabitGridResult,
  HabitPeriod,
  HabitWithStreak,
} from '@timemark/shared';

/**
 * 习惯打卡（D6，plan 66）。
 *
 * - 今日习惯：每行一个 tap-to-log（POST /api/habits/:id/log，同日 UPSERT 累加 count）。
 * - 7 x 习惯 周网格（GitHub-contribution 风格）：纯主题令牌着色，无图表库；
 *   单元格是 <button>，可回填过去日期、可打卡「今天」；未来日期一律 disabled
 *   （后端也会 400，UI 先行拦截）。
 * - 连胜徽章直接渲染后端返回的 `habit.streak.current/longest`；该值由
 *   shared/src/habit-schedule.ts 的纯函数 computeHabitStreak 在服务端算出
 *   （habit.service.ts streakFor），前端绝不重复实现。
 * - 网格窗口从 `streak.today`（用户 IANA 时区的今天）推导 ISO 周，与服务器 TZ 无关。
 */

const PERIOD_OPTIONS: { value: HabitPeriod; label: string }[] = [
  { value: 'day', label: '每天' },
  { value: 'week', label: '每周' },
];

/** 计划星期：0=周日 … 6=周六（与 shared 的 isHabitScheduledOn 一致）；UI 按周一→周日排列。 */
const SCHEDULE_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
];

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

interface HabitForm {
  name: string;
  icon: string;
  period: HabitPeriod;
  targetPerPeriod: string;
  scheduleDays: number[];
  isActive: boolean;
}

const emptyForm = (): HabitForm => ({
  name: '',
  icon: '',
  period: 'day',
  targetPerPeriod: '1',
  scheduleDays: [],
  isActive: true,
});

function toForm(habit: HabitWithStreak): HabitForm {
  return {
    name: habit.name,
    icon: habit.icon ?? '',
    period: habit.period,
    targetPerPeriod: String(habit.target_per_period),
    scheduleDays: habit.schedule_days ?? [],
    isActive: habit.is_active,
  };
}

function buildPayload(form: HabitForm): CreateHabitInput {
  const target = Number(form.targetPerPeriod);
  return {
    name: form.name.trim(),
    icon: form.icon.trim() || null,
    targetPerPeriod: Number.isFinite(target) ? Math.trunc(target) : 1,
    period: form.period,
    scheduleDays: form.scheduleDays.length > 0 ? form.scheduleDays : null,
    reminderTimes: null,
    isActive: form.isActive,
  };
}

/** 周几（周一=0 … 周日=6），纯 YMD → UTC 运算，避免本地时区漂移。 */
function weekdayIndex(ymd: string): number {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  const day = Number(ymd.slice(8, 10));
  if (!year || !month || !day) return 0;
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** 枚举 [from, to] 的每一天（闭区间）；上限保护防止脏数据死循环。 */
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor: string | null = from;
  let guard = 0;
  while (cursor && cursor <= to && guard < 400) {
    days.push(cursor);
    cursor = shiftCalendarDays(cursor, 1);
    guard += 1;
  }
  return days;
}

export default function Habits() {
  const navigate = useNavigate();

  const [habits, setHabits] = useState<HabitWithStreak[]>([]);
  const [grid, setGrid] = useState<HabitGridResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loggingId, setLoggingId] = useState<number | null>(null);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<HabitForm>(emptyForm());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  /** 用户时区的今天：优先用后端返回的 streak.today；无习惯时退回本地时区换算。 */
  const today = useMemo(() => {
    for (const habit of habits) {
      if (habit.streak?.today) return habit.streak.today;
    }
    return dateStringInTimeZone(new Date(), 'Asia/Shanghai');
  }, [habits]);

  const scheduleById = useMemo(() => {
    const map = new Map<number, number[] | null>();
    for (const habit of habits) map.set(habit.id, habit.schedule_days);
    return map;
  }, [habits]);

  const weekDays = useMemo(() => {
    if (!grid) return [];
    return enumerateDays(grid.from, grid.to);
  }, [grid]);

  // v2.27 F44：按名称/创建时间排序（服务端 ?sort= 支持）
  const [sortBy, setSortBy] = useState<'created_at' | 'name'>('created_at');
  const load = useCallback(async () => {
    const list = await api.get<HabitWithStreak[]>(`/habits?active=true&sort=${sortBy}`);
    const rows = Array.isArray(list) ? list : [];
    setHabits(rows);

    const anchor = rows.find((habit) => habit.streak?.today)?.streak.today
      ?? dateStringInTimeZone(new Date(), 'Asia/Shanghai');
    if (rows.length === 0) {
      setGrid(null);
      return;
    }
    const from = isoWeekStartYmd(anchor) ?? anchor;
    const to = shiftCalendarDays(from, 6) ?? anchor;
    const data = await api.get<HabitGridResult>(`/habits/grid?from=${from}&to=${to}`);
    setGrid(data && Array.isArray(data.habits) ? data : null);
  }, [sortBy]);

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

  const log = async (habit: HabitWithStreak, loggedOn?: string) => {
    setError('');
    setStatus('');
    setLoggingId(habit.id);
    try {
      await api.post(`/habits/${habit.id}/log`, loggedOn ? { loggedOn } : {});
      setStatus(`已打卡「${habit.name}」`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '打卡失败');
    } finally {
      setLoggingId(null);
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFieldErrors({});
    setOpen(true);
  };

  const openEdit = (habit: HabitWithStreak) => {
    setEditingId(habit.id);
    setForm(toForm(habit));
    setFieldErrors({});
    setOpen(true);
  };

  const save = async () => {
    setFieldErrors({});
    const payload = buildPayload(form);
    const parsed = createHabitSchema.safeParse(payload);
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
        await api.patch<HabitWithStreak>(`/habits/${editingId}`, payload);
        setStatus('习惯已更新');
      } else {
        await api.post<HabitWithStreak>('/habits', payload);
        setStatus('习惯已创建');
      }
      setOpen(false);
      await refresh();
    } catch (e) {
      setFieldErrors({ form: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (habit: HabitWithStreak) => {
    if (!window.confirm(`确定删除「${habit.name}」？`)) return;
    setError('');
    try {
      await api.delete(`/habits/${habit.id}`);
      setStatus(`已删除「${habit.name}」`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const toggleScheduleDay = (value: number) => {
    setForm((prev) => ({
      ...prev,
      scheduleDays: prev.scheduleDays.includes(value)
        ? prev.scheduleDays.filter((day) => day !== value)
        : [...prev.scheduleDays, value].sort((a, b) => a - b),
    }));
  };

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="习惯打卡"
        subtitle="每日 / 每周目标 · 连胜 · 周视图"
        back="smart"
        actions={
          <Button onClick={openCreate} className="rounded-full min-h-11" aria-label="新建习惯">
            <Plus className="w-4 h-4 mr-1" aria-hidden />
            新建
          </Button>
        }
      />

      <main id="main-content" className="max-w-4xl mx-auto px-4 py-6 space-y-6" tabIndex={-1}>
        {/* v2.27 F44：排序切换 */}
        <div className="flex justify-end">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
            aria-label="习惯排序"
          >
            <option value="created_at">按创建时间</option>
            <option value="name">按名称</option>
          </select>
        </div>
        {error && (
          <p className="text-sm text-destructive glass-panel rounded-2xl px-4 py-3" role="alert">{error}</p>
        )}
        {status && (
          <p className="text-sm text-hint glass-panel rounded-2xl px-4 py-3" role="status">{status}</p>
        )}

        {loading ? (
          <p className="text-hint text-sm" role="status">加载中…</p>
        ) : habits.length === 0 ? (
          <div data-testid="habit-empty">
            <EmptyState
              icon={Repeat}
              title="还没有习惯"
              description="创建第一个习惯，每天打卡，积累连胜"
              action={
                <Button className="rounded-full" variant="outline" onClick={openCreate}>
                  新建习惯
                </Button>
              }
            />
          </div>
        ) : (
          <>
            <section aria-label="今日习惯" className="space-y-2">
              <h2 className="text-sm font-bold px-1 text-hint">今日习惯 · {habits.length}</h2>
              {habits.map((habit) => {
                const scheduled = isHabitScheduledOn(today, habit.schedule_days);
                const met = habit.streak.targetMet;
                return (
                  <div
                    key={habit.id}
                    data-testid={`habit-row-${habit.id}`}
                    className="glass-panel rounded-2xl px-3 py-3 flex items-center gap-3 ring-1 ring-black/5 dark:ring-white/10"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold truncate">
                          {habit.icon ? `${habit.icon} ` : ''}
                          {habit.name}
                        </span>
                        <Badge
                          data-testid={`habit-today-badge-${habit.id}`}
                          data-met={met ? 'true' : 'false'}
                          variant={met ? 'success' : 'secondary'}
                          className="text-[10px]"
                        >
                          {met ? '今日已达标' : `今日 ${habit.streak.todayCount}/${habit.target_per_period}`}
                        </Badge>
                        {!scheduled && <Badge variant="outline" className="text-[10px]">今日不打卡</Badge>}
                      </div>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        <span
                          data-testid={`habit-streak-current-${habit.id}`}
                          data-streak={habit.streak.current}
                          className="inline-flex items-center gap-1 text-xs font-bold text-primary-600 dark:text-primary-400"
                        >
                          <Flame className="w-3.5 h-3.5" aria-hidden />
                          连胜 {habit.streak.current}
                        </span>
                        <span
                          data-testid={`habit-streak-longest-${habit.id}`}
                          data-streak={habit.streak.longest}
                          className="text-xs text-hint"
                        >
                          最长 {habit.streak.longest}
                        </span>
                      </div>
                    </div>
                    <Button
                      data-testid={`habit-log-${habit.id}`}
                      variant={met ? 'outline' : 'default'}
                      className="min-h-11 motion-reduce:transition-none motion-reduce:duration-0"
                      disabled={loggingId === habit.id}
                      onClick={() => log(habit)}
                      aria-label={`打卡 ${habit.name}`}
                    >
                      <Plus className="w-4 h-4 mr-1" aria-hidden />
                      打卡
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="min-h-11 min-w-11 motion-reduce:transition-none motion-reduce:duration-0"
                      onClick={() => openEdit(habit)}
                      aria-label={`编辑 ${habit.name}`}
                    >
                      <Pencil className="w-4 h-4" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="min-h-11 min-w-11 motion-reduce:transition-none motion-reduce:duration-0"
                      onClick={() => remove(habit)}
                      aria-label={`删除 ${habit.name}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" aria-hidden />
                    </Button>
                  </div>
                );
              })}
            </section>

            {grid && grid.habits.length > 0 && (
              <section aria-label="每周打卡网格" className="glass-panel rounded-2xl p-3 ring-1 ring-black/5 dark:ring-white/10 overflow-x-auto">
                <h2 className="text-sm font-bold px-1 text-hint mb-2">本周打卡</h2>
                <table className="w-full min-w-[380px] border-separate border-spacing-1">
                  <caption className="sr-only">本 ISO 周每个习惯每天的打卡情况，未来日期不可打卡</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="text-left text-xs font-medium text-hint px-1">习惯</th>
                      {weekDays.map((date) => (
                        <th key={date} scope="col" className="text-xs font-medium text-hint px-1">
                          <span className="block">{WEEKDAY_LABELS[weekdayIndex(date)]}</span>
                          <span className="block text-[10px] opacity-70">{date.slice(5)}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grid.habits.map((habit) => {
                      const schedule = scheduleById.get(habit.id) ?? null;
                      return (
                        <tr key={habit.id}>
                          <th scope="row" className="text-left text-xs font-semibold px-1 whitespace-nowrap">
                            {habit.icon ? `${habit.icon} ` : ''}
                            {habit.name}
                          </th>
                          {weekDays.map((date) => {
                            const day = habit.days.find((entry) => entry.date === date);
                            const count = day?.count ?? 0;
                            const met = day?.met ?? false;
                            const future = date > today;
                            const scheduled = isHabitScheduledOn(date, schedule);
                            const tone = met
                              ? 'bg-primary text-primary-foreground'
                              : count > 0
                                ? 'bg-primary/40 text-slate-900 dark:text-white'
                                : scheduled
                                  ? 'bg-slate-200/80 dark:bg-white/10 text-slate-500 dark:text-slate-400'
                                  : 'bg-slate-100/60 dark:bg-white/5 text-slate-400 dark:text-slate-500';
                            const name = [
                              `${habit.name} ${date}`,
                              met ? '已达标' : `未达标（${count}/${habit.targetPerPeriod}）`,
                              future ? '未来日期，不可打卡' : '',
                            ]
                              .filter(Boolean)
                              .join(' ');
                            return (
                              <td key={date} className="text-center">
                                <button
                                  type="button"
                                  data-testid={`habit-cell-${habit.id}-${date}`}
                                  data-met={met ? 'true' : 'false'}
                                  data-filled={met ? 'true' : 'false'}
                                  data-future={future ? 'true' : 'false'}
                                  data-scheduled={scheduled ? 'true' : 'false'}
                                  data-count={count}
                                  disabled={future}
                                  aria-label={name}
                                  title={name}
                                  onClick={() => log(habits.find((h) => h.id === habit.id) ?? habits[0], date)}
                                  className={`mx-auto h-8 w-8 sm:h-9 sm:w-9 rounded-lg text-xs font-semibold flex items-center justify-center transition-colors alive-interactive motion-reduce:transition-none motion-reduce:duration-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 disabled:opacity-40 disabled:cursor-not-allowed ${tone}`}
                                >
                                  {date.slice(8, 10)}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}
          </>
        )}

        <p className="text-[11px] text-hint text-center">
          <button type="button" className="text-primary-600 dark:text-primary-400 underline mx-1" onClick={() => navigate('/dashboard')}>
            返回首页
          </button>
        </p>
      </main>

      <MobileBottomNav />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto overscroll-contain max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId != null ? '编辑习惯' : '新建习惯'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="habit-name">习惯名称</label>
              <Input
                id="habit-name"
                aria-label="习惯名称"
                placeholder="例如：晨跑"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              />
              {fieldErrors.name && <p className="text-xs text-destructive mt-1">{fieldErrors.name}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="habit-icon">图标</label>
                <Input
                  id="habit-icon"
                  aria-label="图标"
                  maxLength={16}
                  placeholder="可选，如 🏃 / 📚"
                  value={form.icon}
                  onChange={(e) => setForm((prev) => ({ ...prev, icon: e.target.value }))}
                />
                {fieldErrors.icon && <p className="text-xs text-destructive mt-1">{fieldErrors.icon}</p>}
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="habit-period">周期</label>
                <Select
                  id="habit-period"
                  aria-label="周期"
                  value={form.period}
                  onChange={(e) => setForm((prev) => ({ ...prev, period: e.target.value as HabitPeriod }))}
                >
                  {PERIOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="habit-target">每周期目标次数</label>
              <Input
                id="habit-target"
                aria-label="每周期目标次数"
                type="number"
                min={1}
                max={1000}
                value={form.targetPerPeriod}
                onChange={(e) => setForm((prev) => ({ ...prev, targetPerPeriod: e.target.value }))}
              />
              {fieldErrors.targetPerPeriod && <p className="text-xs text-destructive mt-1">{fieldErrors.targetPerPeriod}</p>}
            </div>

            <fieldset>
              <legend className="text-sm font-medium mb-1">计划星期（留空 = 每天）</legend>
              <div className="flex flex-wrap gap-2">
                {SCHEDULE_OPTIONS.map((option) => {
                  const checked = form.scheduleDays.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={option.label}
                      onClick={() => toggleScheduleDay(option.value)}
                      className={`min-h-11 px-3 rounded-xl text-sm font-semibold transition-colors alive-interactive motion-reduce:transition-none motion-reduce:duration-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 ${
                        checked
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-slate-200/80 dark:bg-white/10 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="flex items-center gap-3">
              <Switch
                id="habit-active"
                aria-label="启用"
                checked={form.isActive}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, isActive: checked }))}
              />
              <label className="text-sm" htmlFor="habit-active">启用</label>
            </div>

            {fieldErrors.form && <p className="text-sm text-destructive">{fieldErrors.form}</p>}
            <Button
              className="w-full min-h-11 motion-reduce:transition-none motion-reduce:duration-0"
              onClick={save}
              disabled={saving}
              aria-label="保存习惯"
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
