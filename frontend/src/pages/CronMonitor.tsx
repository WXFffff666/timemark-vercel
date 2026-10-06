import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Timer } from 'lucide-react';

interface CronLog {
  job_name: string;
  status: string;
  duration_ms: number;
  result_summary: string;
  error_message: string;
  executed_at: string;
}

export default function CronMonitor() {
  const [recent, setRecent] = useState<CronLog[]>([]);
  // v2.28 C10：lastByJob（每 job 恒一行的最新状态，后端早已返回、前端从未渲染）
  const [lastByJob, setLastByJob] = useState<CronLog[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="min-h-screen p-6 max-w-4xl mx-auto">
      {/* 根容器自带 p-6，抵消 PageHeader 的 px-4 保持与卡片左缘对齐 */}
      <PageHeader title="Cron 监控" onRefresh={load} refreshing={loading} className="mb-6 -mx-4" />
      {lastByJob.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2 px-1">各任务最新状态</h2>
          <div className="glass-panel rounded-2xl p-3 grid gap-2 sm:grid-cols-2">
            {lastByJob.map((job) => (
              <div key={job.job_name} className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 px-3 py-2 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="font-semibold text-slate-700 dark:text-slate-200 truncate">{job.job_name}</span>
                  <span className={job.status === 'success' ? 'text-emerald-600' : 'text-red-500'}>{job.status}</span>
                </div>
                <div className="text-slate-400 mt-0.5">
                  {job.executed_at ? new Date(job.executed_at).toLocaleString('zh-CN') : ''}
                  {typeof job.duration_ms === 'number' ? ` · ${job.duration_ms}ms` : ''}
                </div>
                {(job.result_summary || job.error_message) && (
                  <p className={`mt-1 break-words ${job.status === 'success' ? 'text-slate-500 dark:text-slate-400' : 'text-red-500'}`}>
                    {job.result_summary || job.error_message}
                  </p>
                )}
              </div>
            ))}
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
