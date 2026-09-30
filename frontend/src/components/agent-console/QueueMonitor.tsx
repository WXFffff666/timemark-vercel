import { useEffect, useRef, useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Activity, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/agent-console/Skeleton';
import {
  AGENT_JOB_STATUSES,
  statusLabel,
  type AgentStats,
} from '@/pages/agent-console/agent-console-api';
import { cn } from '@/lib/utils';

/** Queue monitor: counts by status + a depth sparkline sampled on each refresh. */
export interface QueueMonitorProps {
  stats: AgentStats | null;
  loading: boolean;
  error?: string;
}

function statusTileClass(status: string): string {
  if (status === 'succeeded') return 'bg-emerald-50/70 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-200/70 dark:ring-emerald-500/30';
  if (status === 'failed' || status === 'dead_letter') return 'bg-red-50/70 dark:bg-red-500/10 text-red-700 dark:text-red-300 ring-red-200/70 dark:ring-red-500/30';
  if (status === 'running' || status === 'leased') return 'bg-blue-50/70 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 ring-blue-200/70 dark:ring-blue-500/30';
  if (status === 'cancelled') return 'bg-slate-100/70 dark:bg-slate-800/50 text-slate-600 dark:text-slate-400 ring-slate-200/70 dark:ring-slate-700';
  return 'bg-amber-50/70 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-200/70 dark:ring-amber-500/30';
}

export function QueueMonitor({ stats, loading, error }: QueueMonitorProps) {
  const depth = stats?.byStatus?.queued ?? 0;
  const [samples, setSamples] = useState<Array<{ n: number; depth: number }>>([]);
  const seq = useRef(0);

  useEffect(() => {
    seq.current += 1;
    const n = seq.current;
    setSamples((prev) => [...prev, { n, depth }].slice(-40));
  }, [depth]);

  const failurePct = stats ? Math.round(stats.failureRate * 1000) / 10 : 0;
  const hasFailure = since24hFailure(stats);

  return (
    <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10 flex flex-col gap-5">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity size={20} className="text-blue-600 dark:text-blue-400" aria-hidden />
          <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">队列监控</h2>
        </div>
        {stats && (
          <Badge variant={hasFailure ? 'destructive' : 'success'} className="shrink-0">
            {hasFailure ? <AlertTriangle size={12} className="mr-1" aria-hidden /> : null}
            失败率 {failurePct}%
          </Badge>
        )}
      </header>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">统计接口不可用：{error}</p>
      ) : loading && !stats ? (
        <Skeleton className="h-32 rounded-2xl" />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5" role="list" aria-label="按状态计数">
            {AGENT_JOB_STATUSES.map((status) => (
              <div
                key={status}
                role="listitem"
                className={cn('rounded-2xl px-3 py-2.5 ring-1', statusTileClass(status))}
              >
                <div className="text-2xl font-extrabold tabular-nums leading-none">
                  {stats?.byStatus?.[status] ?? 0}
                </div>
                <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider opacity-80">
                  {statusLabel(status)}
                </div>
              </div>
            ))}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
              <span>队列深度趋势</span>
              <span className="tabular-nums">当前 {depth} · 本地采样近 {samples.length} 次刷新</span>
            </div>
            <div className="h-16 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={samples} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="queueDepthFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area
                    type="monotone"
                    dataKey="depth"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    fill="url(#queueDepthFill)"
                    isAnimationActive={false}
                  />
                  <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} labelFormatter={() => '深度'} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {stats && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs font-medium text-slate-500 dark:text-slate-400">
              <span>近 24h 完成 <b className="text-slate-800 dark:text-slate-200 tabular-nums">{stats.throughput.finishedLast24h}</b></span>
              <span>成功 <b className="text-emerald-600 dark:text-emerald-400 tabular-nums">{stats.throughput.succeededLast24h}</b></span>
              <span>失败 <b className="text-red-600 dark:text-red-400 tabular-nums">{stats.throughput.failedLast24h}</b></span>
              <span>死信 <b className="text-red-600 dark:text-red-400 tabular-nums">{stats.throughput.deadLetterLast24h}</b></span>
              <span>近 1h 完成 <b className="text-slate-800 dark:text-slate-200 tabular-nums">{stats.throughput.finishedLastHour}</b></span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function since24hFailure(stats: AgentStats | null): boolean {
  if (!stats) return false;
  return stats.throughput.failedLast24h > 0 || stats.throughput.deadLetterLast24h > 0;
}
