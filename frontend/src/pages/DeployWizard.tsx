import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, XCircle, ExternalLink } from 'lucide-react';

export default function DeployWizard() {
  const navigate = useNavigate();
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [cronUrl, setCronUrl] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const health = await api.get<any>('/health'.replace('/health', '/health'));
      } catch { /* ignore */ }
      try {
        const res = await fetch('/api/health');
        const data = await res.json();
        setChecks({
          database: !!data.checks?.database,
          jwtSecret: !!data.checks?.jwtSecret,
          masterKey: !!data.checks?.masterKey,
          cronSecret: !!data.checks?.cronSecret,
          turnstile: !!data.checks?.turnstile,
        });
        const host = window.location.host;
        const proto = window.location.protocol;
        setCronUrl(`${proto}//${host}/api/cron/reminder-check`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const cronCurl = `curl -H "Authorization: Bearer YOUR_CRON_SECRET" "${cronUrl}"`;

  return (
    <div className="min-h-screen p-4 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">部署向导</h1>
        <Button variant="outline" size="sm" onClick={() => navigate('/settings')}>返回设置</Button>
      </div>

      {loading ? <p>检查中...</p> : (
        <Card>
          <CardHeader><CardTitle className="text-base">环境变量检查</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(checks).map(([key, ok]) => (
              <div key={key} className="flex items-center gap-2 text-sm">
                {ok ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-red-500" />}
                <span>{key}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">外部 Cron 配置（cron-job.org 免费）</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Hobby 计划需用外部服务每分钟调用提醒检查：</p>
          <p className="font-mono text-xs break-all bg-slate-100 dark:bg-slate-800 p-2 rounded">{cronUrl}</p>
          <p className="font-mono text-xs break-all bg-slate-100 dark:bg-slate-800 p-2 rounded">{cronCurl}</p>
          <a href="https://cron-job.org" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600">
            打开 cron-job.org <ExternalLink className="w-3 h-3" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
