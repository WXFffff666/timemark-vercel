import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, XCircle, ExternalLink } from 'lucide-react';

interface CronJob {
  path: string;
  schedule: string;
  description: string;
}

export default function DeployWizard() {
  const navigate = useNavigate();
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [cronBase, setCronBase] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/health');
        const data = await res.json();
        let secretChecks: Record<string, boolean> = {};
        try {
          const deploy = await api.get<{
            turnstileConfigured?: boolean;
            cronSecretConfigured?: boolean;
          }>('/security/deploy-info');
          secretChecks = {
            cronSecret: !!deploy.cronSecretConfigured,
            turnstile: !!deploy.turnstileConfigured,
          };
        } catch {
          secretChecks = { turnstile: !!data.checks?.turnstile };
        }
        setChecks({
          database: !!data.checks?.database,
          ...secretChecks,
        });
        const host = window.location.host;
        const proto = window.location.protocol;
        setCronBase(`${proto}//${host}/api/cron`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const cronJobs: CronJob[] = [
    {
      path: '/warmup',
      schedule: '每分钟（在 reminder-check 前 10 秒）',
      description: '预热数据库连接，减少冷启动延迟（可选）',
    },
    {
      path: '/reminder-check',
      schedule: '每分钟',
      description: '检查并发送事件提醒（必须）',
    },
    {
      path: '/retry-notifications',
      schedule: '每 5–15 分钟',
      description: '重试失败的通知队列条目',
    },
    {
      path: '/calendar-sync',
      schedule: '每 15 分钟',
      description: '从外部 ICS URL 同步日历事件',
    },
    {
      path: '/daily-maintenance',
      schedule: '每天 1 次（可用 Vercel 内置 Cron）',
      description: '清理会话、过期缓存、旧日志与通知队列',
    },
  ];

  const cronCurl = (path: string) =>
    `curl -H "Authorization: Bearer YOUR_CRON_SECRET" "${cronBase}${path}"`;

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
        <CardContent className="space-y-4 text-sm">
          <p>Hobby 计划需用外部服务定时调用以下端点。所有请求需携带 <code className="text-xs bg-slate-100 dark:bg-slate-800 px-1 rounded">Authorization: Bearer CRON_SECRET</code>。</p>

          {cronJobs.map((job) => (
            <div key={job.path} className="border border-slate-200 dark:border-slate-700 rounded-lg p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{job.path.replace('/', '')}</span>
                <span className="text-xs text-slate-500">{job.schedule}</span>
              </div>
              <p className="text-xs text-slate-500">{job.description}</p>
              <p className="font-mono text-xs break-all bg-slate-100 dark:bg-slate-800 p-2 rounded">{cronBase}{job.path}</p>
              <p className="font-mono text-xs break-all bg-slate-100 dark:bg-slate-800 p-2 rounded">{cronCurl(job.path)}</p>
            </div>
          ))}

          <a href="https://cron-job.org" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600">
            打开 cron-job.org <ExternalLink className="w-3 h-3" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
