import { useState } from 'react';
import { CalendarClock, Play, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DegradedRoutineBadge } from '@/components/ai/DegradedBanner';
import { Skeleton } from '@/components/agent-console/Skeleton';
import { formatRelativeTime } from '@/lib/format-time';
import {
  AGENT_ROUTINE_TIERS,
  AGENT_TIER_LABELS,
  runRoutineNow,
  updateAgentRoutine,
  type AgentRoutine,
  type AgentRoutineTier,
} from '@/pages/agent-console/agent-console-api';

export interface RoutineControlsProps {
  routines: AgentRoutine[];
  loading: boolean;
  error?: string;
  /** routine_id -> degraded reason, from /api/agent/health. */
  degradedByRoutineId: Record<string, string>;
  onChanged: () => void;
}

export function RoutineControls({ routines, loading, error, degradedByRoutineId, onChanged }: RoutineControlsProps) {
  return (
    <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10 flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <CalendarClock size={20} className="text-teal-600 dark:text-teal-400" aria-hidden />
        <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">例行任务（Routines）</h2>
      </header>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">Routines 接口不可用：{error}</p>
      ) : loading && routines.length === 0 ? (
        <Skeleton className="h-28 rounded-2xl" />
      ) : routines.length === 0 ? (
        <div
          data-testid="routines-empty"
          className="rounded-2xl border border-slate-200/70 dark:border-slate-700/60 bg-white/40 dark:bg-slate-800/30 p-4 text-sm text-slate-500 dark:text-slate-400"
        >
          还没有注册任何例行任务。例行任务是后台 AI 的调度源 —— 没有任何 routine 时，队列不会产生周期性工作。
        </div>
      ) : (
        <ul className="space-y-3" role="list">
          {routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              degradedReason={degradedByRoutineId[routine.id]}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface RoutineRowProps {
  routine: AgentRoutine;
  degradedReason?: string;
  onChanged: () => void;
}

function RoutineRow({ routine, degradedReason, onChanged }: RoutineRowProps) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [schedule, setSchedule] = useState(routine.cron_expr ?? '');
  const [budget, setBudget] = useState(routine.budget_per_day === null ? '' : String(routine.budget_per_day));

  async function applyPatch(patch: Parameters<typeof updateAgentRoutine>[1], okText: string) {
    setBusy(true);
    setFeedback(null);
    try {
      await updateAgentRoutine(routine.id, patch);
      setFeedback({ tone: 'ok', text: okText });
      onChanged();
    } catch (cause) {
      setFeedback({ tone: 'err', text: cause instanceof Error ? cause.message : '更新失败' });
    } finally {
      setBusy(false);
    }
  }

  async function onRunNow() {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await runRoutineNow(routine.id);
      setFeedback({
        tone: 'ok',
        text: result.created ? `已入队（job ${result.job_id.slice(0, 8)}…）` : `复用已有任务（job ${result.job_id.slice(0, 8)}…）`,
      });
      onChanged();
    } catch (cause) {
      setFeedback({ tone: 'err', text: cause instanceof Error ? cause.message : '立即运行失败' });
    } finally {
      setBusy(false);
    }
  }

  function commitSchedule() {
    const next = schedule.trim();
    if (next === (routine.cron_expr ?? '')) return;
    void applyPatch({ cron_expr: next === '' ? null : next }, '调度已更新');
  }

  function commitBudget() {
    const trimmed = budget.trim();
    const parsed = trimmed === '' ? null : Number.parseInt(trimmed, 10);
    const next = parsed === null || Number.isNaN(parsed) ? null : parsed;
    if (next === routine.budget_per_day) return;
    void applyPatch({ budget_per_day: next }, '预算已更新');
  }

  return (
    <li className="rounded-2xl bg-white/50 dark:bg-slate-800/40 p-4 ring-1 ring-black/5 dark:ring-white/5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Switch
              checked={routine.enabled}
              disabled={busy}
              aria-label={`启用 ${routine.name}`}
              onCheckedChange={(checked) => void applyPatch({ enabled: checked }, checked ? '已启用' : '已停用')}
            />
            <span className="text-sm font-bold text-slate-900 dark:text-white">{routine.name}</span>
            <Badge variant={routine.enabled ? 'success' : 'secondary'}>{routine.enabled ? '已启用' : '已停用'}</Badge>
            <Badge variant="outline" className="font-mono normal-case tracking-normal">{routine.kind}</Badge>
            {degradedReason && <DegradedRoutineBadge reason={degradedReason} />}
          </div>
          <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            {routine.last_run_at ? `上次运行：${formatRelativeTime(routine.last_run_at)} · ` : '尚未运行 · '}
            {routine.next_run_at ? `下次：${formatRelativeTime(routine.next_run_at)}` : '未排期'}
          </div>
        </div>
        <Button
          size="sm"
          variant="default"
          className="rounded-full shrink-0"
          disabled={busy || !routine.enabled}
          title={routine.enabled ? '立即入队一次' : '请先启用该例行任务'}
          onClick={() => void onRunNow()}
        >
          <Zap size={15} className="mr-1" aria-hidden />
          {busy ? '处理中…' : '立即运行'}
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          调度 (cron)
          <Input
            value={schedule}
            onChange={(event) => setSchedule(event.target.value)}
            onBlur={commitSchedule}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            placeholder="0 8 * * *"
            className="h-10 font-mono text-xs"
            aria-label={`${routine.name} 的 cron 表达式`}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          层级 (tier)
          <Select
            value={routine.tier ?? ''}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value as AgentRoutineTier | '';
              void applyPatch({ tier: value === '' ? null : value }, '层级已更新');
            }}
            className="h-10 text-xs"
            aria-label={`${routine.name} 的层级`}
          >
            <option value="">未设置</option>
            {AGENT_ROUTINE_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {AGENT_TIER_LABELS[tier]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          每日预算
          <Input
            type="number"
            min={0}
            max={1000}
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            onBlur={commitBudget}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            placeholder="不限"
            className="h-10 text-xs"
            aria-label={`${routine.name} 的每日预算`}
          />
        </label>
      </div>

      {feedback && (
        <p className={`mt-2 text-xs font-medium ${feedback.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
          {feedback.text}
        </p>
      )}

      <div className="mt-2 flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
        <Play size={11} aria-hidden /> 停用的例行任务不会被调度；「立即运行」需要先启用。
      </div>
    </li>
  );
}
