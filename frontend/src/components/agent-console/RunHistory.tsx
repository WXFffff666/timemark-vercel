import { useState } from 'react';
import { ChevronDown, ChevronRight, Coins, History } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/agent-console/Skeleton';
import { formatRelativeTime } from '@/lib/format-time';
import {
  fetchAgentJobDetail,
  statusLabel,
  statusTone,
  type AgentJobDetail,
  type AgentRun,
} from '@/pages/agent-console/agent-console-api';

export interface RunHistoryProps {
  runs: AgentRun[];
  loading: boolean;
  error?: string;
}

function compactDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function durationText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RunHistory({ runs, loading, error }: RunHistoryProps) {
  return (
    <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10 flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <History size={20} className="text-slate-600 dark:text-slate-300" aria-hidden />
        <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">运行历史</h2>
      </header>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">运行历史接口不可用：{error}</p>
      ) : loading && runs.length === 0 ? (
        <Skeleton className="h-28 rounded-2xl" />
      ) : runs.length === 0 ? (
        <div
          data-testid="runs-empty"
          className="rounded-2xl border border-slate-200/70 dark:border-slate-700/60 bg-white/40 dark:bg-slate-800/30 p-4 text-sm text-slate-500 dark:text-slate-400"
        >
          还没有任何运行记录。点击上方「立即运行」或等待例行任务调度即可产生记录。
        </div>
      ) : (
        <ul className="space-y-2" role="list">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AgentJobDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && detail === null && !loadingDetail) {
      setLoadingDetail(true);
      setDetailError(null);
      fetchAgentJobDetail(run.id)
        .then((value) => setDetail(value))
        .catch((cause: unknown) => setDetailError(cause instanceof Error ? cause.message : '事件加载失败'))
        .finally(() => setLoadingDetail(false));
    }
  }

  return (
    <li className="rounded-2xl bg-white/50 dark:bg-slate-800/40 ring-1 ring-black/5 dark:ring-white/5 overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/70 dark:hover:bg-slate-800/60 transition-colors"
      >
        {open ? <ChevronDown size={16} className="shrink-0 text-slate-400" aria-hidden /> : <ChevronRight size={16} className="shrink-0 text-slate-400" aria-hidden />}
        <Badge variant={statusTone(run.status)} className="shrink-0">{statusLabel(run.status)}</Badge>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-900 dark:text-white">
            {run.routine_name ?? run.kind}
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            {run.kind} · 尝试 {run.attempt}/{run.max_attempts} · {run.created_at ? formatRelativeTime(run.created_at) : ''}
            {run.error_code ? ` · ${run.error_code}` : ''}
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-3 text-xs tabular-nums text-slate-500 dark:text-slate-400 sm:flex">
          <span>{durationText(run.durationMs)}</span>
          <span className="inline-flex items-center gap-1 font-semibold text-slate-700 dark:text-slate-200">
            <Coins size={13} aria-hidden /> {run.costTokens} tok
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-black/5 dark:border-white/5 px-4 py-3">
          {loadingDetail && <Skeleton className="h-16 rounded-xl" />}
          {detailError && <p className="text-xs text-red-600 dark:text-red-400">{detailError}</p>}
          {detail && (
            <>
              <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                <span className="sm:hidden">耗时 {durationText(detail.job.durationMs)}</span>
                <span className="sm:hidden">Tokens {detail.job.costTokens}</span>
                <span>事件 {detail.eventsTotal} 条{detail.eventsHasMore ? '（仅显示最近 ' + detail.eventsLimit + '）' : ''}</span>
                {detail.job.error_message && <span className="text-red-600 dark:text-red-400">{detail.job.error_message}</span>}
              </div>
              {detail.events.length === 0 ? (
                <p className="text-xs text-slate-400 dark:text-slate-500">该任务没有记录到生命周期事件。</p>
              ) : (
                <ol className="relative ml-1 border-l border-slate-200 dark:border-slate-700 space-y-2 pl-4">
                  {detail.events.map((event) => (
                    <li key={event.id} className="relative text-xs">
                      <span className="absolute -left-[1.36rem] top-1 h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600" aria-hidden />
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-800 dark:text-slate-200">{event.status ?? '事件'}</span>
                        <span className="text-slate-400 dark:text-slate-500">
                          {event.at ? formatRelativeTime(event.at) : ''}
                        </span>
                      </div>
                      {compactDetail(event.detail) && (
                        <code className="mt-0.5 block break-all font-mono text-[11px] text-slate-500 dark:text-slate-400">
                          {compactDetail(event.detail)}
                        </code>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
