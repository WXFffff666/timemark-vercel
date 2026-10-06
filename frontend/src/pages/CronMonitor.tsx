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
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.get<{ recent: CronLog[] }>('/cron-monitor')
      .then((d) => {
        setRecent(d.recent || []);
      })
      .catch(() => {
        setRecent([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="min-h-screen p-6 max-w-4xl mx-auto">
      <PageHeader title="Cron 监控" onRefresh={load} refreshing={loading} className="mb-6" />
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
