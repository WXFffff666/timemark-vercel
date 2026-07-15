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

interface EnvCheck {
  id: string;
  label: string;
  ok: boolean;
  hint: string;
}

interface DeployInfo {
  envChecks?: EnvCheck[];
  channelNote?: string;
  schemaVersion?: number;
  expectedSchemaVersion?: number;
}

export default function DeployWizard() {
  const navigate = useNavigate();
  const [checks, setChecks] = useState<EnvCheck[]>([]);
  const [channelNote, setChannelNote] = useState('');
  const [cronBase, setCronBase] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/health');
        const data = await res.json();

        try {
          const deploy = await api.get<DeployInfo>('/security/deploy-info');
          if (deploy.envChecks?.length) {
            setChecks(deploy.envChecks);
          } else {
            setChecks([
              {
                id: 'database',
                label: '数据库连接',
                ok: !!data.checks?.database,
                hint: data.checks?.database ? 'PostgreSQL 连接正常' : 'DATABASE_URL 未配置或连接失败',
              },
              {
                id: 'turnstile',
                label: 'Cloudflare Turnstile',
                ok: !!data.checks?.turnstile,
                hint: data.checks?.turnstile ? '已配置' : '可选，未配置不影响核心功能',
              },
            ]);
          }
          setChannelNote(deploy.channelNote || '');
        } catch {
          setChecks([
            {
              id: 'database',
              label: '数据库连接',
              ok: !!data.checks?.database,
              hint: data.checks?.database ? 'PostgreSQL 连接正常' : 'DATABASE_URL 未配置或连接失败',
            },
            {
              id: 'turnstile',
              label: 'Cloudflare Turnstile',
              ok: !!data.checks?.turnstile,
              hint: data.checks?.turnstile ? '已配置' : '可选',
            },
          ]);
        }

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

  const allOk = checks.length > 0 && checks.every((c) => c.ok);

  return (
    <div className="min-h-screen p-4 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">部署向导</h1>
        <Button variant="outline" size="sm" onClick={() => navigate('/settings')}>返回设置</Button>
      </div>

      {loading ? <p>检查中...</p> : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              系统自检
              {allOk ? (
                <span className="text-xs font-normal text-green-600">全部通过</span>
              ) : (
                <span className="text-xs font-normal text-amber-600">存在待处理项</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {checks.map((item) => (
              <div key={item.id} className="flex gap-2 text-sm">
                {item.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                )}
                <div>
                  <p className="font-medium">{item.label}</p>
                  <p className="text-xs text-slate-500">{item.hint}</p>
                </div>
              </div>
            ))}
            {channelNote && (
              <p className="text-xs text-slate-500 border-t border-slate-200 dark:border-slate-700 pt-3">
                {channelNote}
              </p>
            )}
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
