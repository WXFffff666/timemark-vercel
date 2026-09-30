import { Coins, ShieldOff } from 'lucide-react';
import { Skeleton } from '@/components/agent-console/Skeleton';
import type { AgentStats } from '@/pages/agent-console/agent-console-api';

export interface BudgetBucket {
  limit: number | null;
  used: number;
  remaining: number | null;
}

export interface BudgetMeterProps {
  stats: AgentStats | null;
  tokens: BudgetBucket | null;
  calls: BudgetBucket | null;
  month: string | null;
  loading: boolean;
  error?: string;
}

function bucketPct(bucket: BudgetBucket | null): number | null {
  if (!bucket || bucket.limit === null || bucket.limit <= 0) return null;
  return Math.min(100, Math.round((bucket.used / bucket.limit) * 100));
}

export function BudgetMeter({ stats, tokens, calls, month, loading, error }: BudgetMeterProps) {
  const suppressedToday = stats?.suppressed.last24h ?? 0;
  const suppressedTotal = stats?.suppressed.total ?? 0;
  const tokenPct = bucketPct(tokens);
  const tokenExhausted =
    tokens !== null && tokens.limit !== null && (tokens.remaining === 0 || tokens.used >= tokens.limit);

  return (
    <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10 flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Coins size={20} className="text-amber-600 dark:text-amber-400" aria-hidden />
          <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">预算与抑制</h2>
        </div>
        {month && <span className="text-xs font-medium text-slate-400 dark:text-slate-500">{month}</span>}
      </header>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">统计接口不可用：{error}</p>
      ) : loading && !stats ? (
        <Skeleton className="h-24 rounded-2xl" />
      ) : (
        <>
          <div
            data-testid="suppressed-today"
            className="flex items-center justify-between rounded-2xl bg-amber-50/70 dark:bg-amber-500/10 px-4 py-3 ring-1 ring-amber-200/70 dark:ring-amber-500/30"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
              <ShieldOff size={16} aria-hidden /> 今天已抑制
            </span>
            <span className="text-2xl font-extrabold tabular-nums text-amber-700 dark:text-amber-300">
              {suppressedToday} 条
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2.5 text-center">
            <div className="rounded-2xl bg-white/50 dark:bg-slate-800/40 px-3 py-3 ring-1 ring-black/5 dark:ring-white/5">
              <div className="text-xl font-extrabold tabular-nums text-slate-900 dark:text-white">
                {stats?.tokens.spentLast24h ?? 0}
              </div>
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                近 24h Tokens
              </div>
            </div>
            <div className="rounded-2xl bg-white/50 dark:bg-slate-800/40 px-3 py-3 ring-1 ring-black/5 dark:ring-white/5">
              <div className="text-xl font-extrabold tabular-nums text-slate-900 dark:text-white">
                {stats?.tokens.spentTotal ?? 0}
              </div>
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                累计 Tokens
              </div>
            </div>
          </div>

          {tokens && tokens.limit !== null && (
            <div>
              <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                <span>月度 Token 预算</span>
                <span className="tabular-nums">
                  {tokens.used} / {tokens.limit}
                  {tokens.remaining !== null ? ` · 余 ${tokens.remaining}` : ''}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200/70 dark:bg-slate-700/60">
                <div
                  className={`h-full rounded-full transition-all ${
                    tokenExhausted ? 'bg-red-500' : (tokenPct ?? 0) >= 80 ? 'bg-amber-500' : 'bg-emerald-500'
                  }`}
                  style={{ width: `${tokenPct ?? 0}%` }}
                />
              </div>
              {tokenExhausted && (
                <p className="mt-2 text-xs font-semibold text-red-600 dark:text-red-400" data-testid="budget-exhausted">
                  预算已耗尽：主动通知已被抑制，直到下个周期重置。
                </p>
              )}
            </div>
          )}

          {calls && calls.limit !== null && (
            <div>
              <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                <span>月度调用次数</span>
                <span className="tabular-nums">
                  {calls.used} / {calls.limit}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200/70 dark:bg-slate-700/60">
                <div className={`h-full rounded-full ${(bucketPct(calls) ?? 0) >= 80 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${bucketPct(calls) ?? 0}%` }} />
              </div>
            </div>
          )}

          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            累计抑制 {suppressedTotal} 条（error_code = SUPPRESSED）。抑制来自通知预算层，属预期降级而非故障。
          </p>
        </>
      )}
    </section>
  );
}
