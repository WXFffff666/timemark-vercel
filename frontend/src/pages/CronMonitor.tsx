import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ArrowLeft, RefreshCw } from 'lucide-react';

interface CronLog {
  job_name: string;
  status: string;
  duration_ms: number;
  result_summary: string;
  error_message: string;
  executed_at: string;
}

export default function CronMonitor() {
  const navigate = useNavigate();
  const [recent, setRecent] = useState<CronLog[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.get<{ recent: CronLog[] }>('/cron-monitor')
      .then((d) => setRecent(d.recent || []))
      .catch(() => setRecent([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="min-h-screen p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <Button variant="ghost" onClick={() => navigate(-1)}><ArrowLeft className="mr-2" size={18} />返回</Button>
        <Button variant="outline" onClick={load} disabled={loading}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></Button>
      </div>
      <h1 className="text-2xl font-bold mb-4">Cron 监控</h1>
      <div className="space-y-3">
        {recent.map((log, i) => (
          <div key={i} className="glass-panel p-4 rounded-xl flex justify-between gap-4">
            <div>
              <div className="font-medium">{log.job_name}</div>
              <div className="text-xs text-slate-500">{log.executed_at}</div>
              <div className="text-sm mt-1">{log.result_summary || log.error_message || '—'}</div>
            </div>
            <span className={`text-sm font-medium ${log.status === 'success' ? 'text-green-600' : 'text-red-500'}`}>{log.status}</span>
          </div>
        ))}
        {!loading && recent.length === 0 && <p className="text-slate-500">暂无 Cron 执行记录</p>}
      </div>
    </div>
  );
}
