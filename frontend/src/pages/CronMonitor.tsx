import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Timer, Play, Loader2 } from 'lucide-react';

interface CronLog {
  job_name: string;
  status: string;
  duration_ms: number;
  result_summary: string;
  error_message: string;
  executed_at: string;
}

// v2.30：支持监控页"立即运行"的任务（后端白名单同名）
const RUNNABLE_JOBS = new Set(['reminder-check', 'retry-notifications']);

export default function CronMonitor() {
  const [recent, setRecent] = useState<CronLog[]>([]);
  // v2.28 C10：lastByJob（每 job 恒一行的最新状态，后端早已返回、前端从未渲染）
  const [lastByJob, setLastByJob] = useState<CronLog[]>([]);
  const [loading, setLoading] = useState(true);
  // v2.30：手动运行状态
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    setLoading(true);
    api.get<{ recent: CronLog[]; lastByJob: CronLog[] }>('/cron-monitor')
      .then((d) => {
        setRecent(d.recent || []);
        setLastByJob(d.lastByJob || []);
      })
      .catch(() => {
        setRecent([]);
        setLastByJob([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // v2.30：按任务聚合最近运行（健康分 + 迷你柱状历史）
  const jobStats = useMemo(() => {
    const byJob = new Map<string, CronLog[]>();
    for (const log of recent) {
      const list = byJob.get(log.job_name) ?? [];
      list.push(log);
      byJob.set(log.job_name, list);
    }
    return byJob;
  }, [recent]);

  const overallSuccess = useMemo(() => {
    if (recent.length === 0) return null;
    const ok = recent.filter((r) => r.status === 'success').length;
    return Math.round((ok / recent.length) * 100);
  }, [recent]);

  const runNow = async (job: string) => {
    if (!confirm(`立即运行任务 ${job}？`)) return;
    setRunningJob(job);
    setRunNotice(null);
    try {
      const res = await api.post<{ job: string; summary: string; durationMs: number }>(`/cron-monitor/run/${job}`, {});
      setRunNotice({ ok: true, text: `${job}：${res.summary}（${res.durationMs}ms）` });
      load();
    } catch (error) {
      setRunNotice({ ok: false, text: error instanceof Error ? error.message : '触发失败' });
    } finally {
      setRunningJob(null);
    }
  };

  return (
    <div className="min-h-screen p-6 max-w-4xl mx-auto">
      {/* 根容器自带 p-6，抵消 PageHeader 的 px-4 保持与卡片左缘对齐 */}
      <PageHeader
        title="Cron 监控"
        subtitle={overallSuccess !== null ? `近 ${recent.length} 次执行成功率 ${overallSuccess}%` : undefined}
        actions={
          overallSuccess !== null ? (
            <Badge variant={overallSuccess >= 90 ? 'default' : overallSuccess >= 60 ? 'secondary' : 'destructive'} className="scale-90">
              {overallSuccess >= 90 ? '运行健康' : overallSuccess >= 60 ? '有波动' : '需要关注'}
            </Badge>
          ) : undefined
        }
        onRefresh={load}
        refreshing={loading}
        className="mb-6 -mx-4"
      />
      {runNotice && (
        <div
          className={`mb-4 rounded-xl px-4 py-2 text-sm ${
            runNotice.ok
              ? 'border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-300'
              : 'border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/10 text-red-600 dark:text-red-300'
          }`}
        >
          {runNotice.text}
        </div>
      )}
      {lastByJob.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2 px-1">各任务最新状态</h2>
          <div className="glass-panel rounded-2xl p-3 grid gap-2 sm:grid-cols-2">
            {lastByJob.map((job) => {
              // v2.30：每任务健康分 + 最近 12 次迷你柱状图
              const history = (jobStats.get(job.job_name) ?? []).slice(0, 12).reverse();
              const okCount = history.filter((h) => h.status === 'success').length;
              const health = history.length > 0 ? Math.round((okCount / history.length) * 100) : null;
              const maxDuration = Math.max(...history.map((h) => h.duration_ms || 0), 1);
              const runnable = RUNNABLE_JOBS.has(job.job_name);
              return (
                <div key={job.job_name} className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 px-3 py-2 text-xs">
                  <div className="flex justify-between gap-2 items-center">
                    <span className="font-semibold text-slate-700 dark:text-slate-200 truncate">{job.job_name}</span>
                    <span className="flex items-center gap-2">
                      {health !== null && (
                        <span
                          title={`最近 ${history.length} 次成功率`}
                          className={health >= 90 ? 'text-emerald-600' : health >= 60 ? 'text-amber-500' : 'text-red-500'}
                        >
                          {health}%
                        </span>
                      )}
                      <span className={`inline-block w-2 h-2 rounded-full ${job.status === 'success' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      <span className={job.status === 'success' ? 'text-emerald-600' : 'text-red-500'}>{job.status}</span>
                    </span>
                  </div>
                  <div className="text-slate-400 mt-0.5">
                    {job.executed_at ? new Date(job.executed_at).toLocaleString('zh-CN') : ''}
                    {typeof job.duration_ms === 'number' ? ` · ${job.duration_ms}ms` : ''}
                  </div>
                  {history.length > 1 && (
                    <div className="flex items-end gap-0.5 h-6 mt-1.5" aria-label={`最近 ${history.length} 次执行耗时`}>
                      {history.map((h, i) => (
                        <div
                          key={i}
                          title={`${new Date(h.executed_at).toLocaleString('zh-CN')} · ${h.status} · ${h.duration_ms}ms`}
                          className={`flex-1 rounded-sm min-w-[3px] ${h.status === 'success' ? 'bg-emerald-500/70' : 'bg-red-500/80'}`}
                          style={{ height: `${Math.max(15, Math.round(((h.duration_ms || maxDuration) / maxDuration) * 100))}%` }}
                        />
                      ))}
                    </div>
                  )}
                  {(job.result_summary || job.error_message) && (
                    <p className={`mt-1 break-words ${job.status === 'success' ? 'text-slate-500 dark:text-slate-400' : 'text-red-500'}`}>
                      {job.result_summary || job.error_message}
                    </p>
                  )}
                  {runnable && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-full mt-2 h-7 text-xs"
                      disabled={runningJob !== null}
                      onClick={() => runNow(job.job_name)}
                    >
                      {runningJob === job.job_name ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Play size={12} className="mr-1" />}
                      立即运行
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
      <div className="space-y-3">
        {recent.map((log, i) => (
          <div key={i} className="glass-panel p-4 rounded-xl flex justify-between gap-4">
            <div>
              <div className="font-medium">{log.job_name}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{log.executed_at}</div>
              <div className={`text-sm mt-1 ${log.status === 'success' ? '' : 'text-red-500 break-words'}`}>
                {log.result_summary || log.error_message || '—'}
                {typeof log.duration_ms === 'number' && <span className="ml-2 text-xs text-slate-400">{log.duration_ms}ms</span>}
              </div>
            </div>
            <span className={`text-sm font-medium ${log.status === 'success' ? 'text-green-600' : 'text-red-500'}`}>{log.status}</span>
          </div>
        ))}
        {!loading && recent.length === 0 && <EmptyState icon={Timer} title="暂无 Cron 执行记录" />}
      </div>
    </div>
  );
}
