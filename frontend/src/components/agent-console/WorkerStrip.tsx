import { Cpu, Wifi, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/agent-console/Skeleton';
import { formatRelativeTime } from '@/lib/format-time';
import type { AgentWorker } from '@/pages/agent-console/agent-console-api';

/** Worker status strip: online / stale / last-seen, from /api/admin/agent/workers. */
export interface WorkerStripProps {
  workers: AgentWorker[];
  staleAfterMs?: number | null;
  loading: boolean;
  error?: string;
}

export function WorkerStrip({ workers, staleAfterMs, loading, error }: WorkerStripProps) {
  const online = workers.filter((worker) => worker.online).length;

  return (
    <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10 flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Cpu size={20} className="text-violet-600 dark:text-violet-400" aria-hidden />
          <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">Worker 状态</h2>
        </div>
        <Badge variant={online > 0 ? 'success' : 'destructive'} className="shrink-0">
          {online} / {workers.length} 在线
        </Badge>
      </header>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">Worker 接口不可用：{error}</p>
      ) : loading && workers.length === 0 ? (
        <Skeleton className="h-16 rounded-2xl" />
      ) : workers.length === 0 ? (
        <div
          data-testid="worker-strip-empty"
          className="rounded-2xl border border-amber-300/70 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-200"
        >
          没有任何 worker 上报过心跳 —— 后台任务不会被认领。请按 <code className="font-mono text-xs">docs/CRON.md</code> 配置 drain 触发。
        </div>
      ) : (
        <ul className="space-y-2.5" role="list">
          {workers.map((worker) => (
            <li
              key={worker.id}
              className="flex items-center justify-between gap-3 rounded-2xl bg-white/50 dark:bg-slate-800/40 px-4 py-3 ring-1 ring-black/5 dark:ring-white/5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                  {worker.online ? (
                    <Wifi size={15} className="text-emerald-500" aria-hidden />
                  ) : (
                    <WifiOff size={15} className="text-red-500" aria-hidden />
                  )}
                  <span className="truncate font-mono text-xs">{worker.id}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {worker.kind ? `kind: ${worker.kind} · ` : ''}
                  最后心跳：{worker.last_seen_at ? formatRelativeTime(worker.last_seen_at) : '从未'}
                </div>
              </div>
              <Badge variant={worker.online ? 'success' : 'destructive'} className="shrink-0">
                {worker.online ? '在线' : '陈旧'}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {staleAfterMs != null && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500">
          超过 {Math.round(staleAfterMs / 1000)}s 未上报即判定为「陈旧」。
        </p>
      )}
    </section>
  );
}
