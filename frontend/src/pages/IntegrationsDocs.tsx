import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowLeft, Copy, Send, Smartphone } from 'lucide-react';
import { api } from '@/lib/api';

const SITE = typeof window !== 'undefined' ? window.location.origin : 'https://your-timemark.vercel.app';

export default function IntegrationsDocs() {
  const navigate = useNavigate();
  const [webhookUrl, setWebhookUrl] = useState('');
  const [ntfyServer, setNtfyServer] = useState('https://ntfy.sh');
  const [ntfyTopic, setNtfyTopic] = useState('');
  const [ntfyTesting, setNtfyTesting] = useState(false);
  const [ntfyResult, setNtfyResult] = useState('');

  useEffect(() => {
    api.get<{ webhookUrl?: string | null }>('/calendar/integrations')
      .then((d) => { if (d?.webhookUrl) setWebhookUrl(d.webhookUrl); })
      .catch(() => {});
  }, []);

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      alert(`${label}已复制`);
    } catch {
      alert('复制失败');
    }
  };

  const testNtfy = async () => {
    if (!ntfyTopic.trim()) {
      alert('请填写 ntfy Topic');
      return;
    }
    setNtfyTesting(true);
    setNtfyResult('');
    try {
      const res = await fetch(`${ntfyServer.replace(/\/$/, '')}/${encodeURIComponent(ntfyTopic.trim())}`, {
        method: 'POST',
        headers: { Title: 'TimeMark 测试', Tags: 'bell' },
        body: '这是一条来自 TimeMark 集成文档的测试通知',
      });
      setNtfyResult(res.ok ? '测试消息已发送，请查看 ntfy 客户端' : `发送失败 HTTP ${res.status}`);
    } catch (e) {
      setNtfyResult(e instanceof Error ? e.message : '发送失败');
    } finally {
      setNtfyTesting(false);
    }
  };

  const createEventCurl = `curl -X POST "${webhookUrl || `${SITE}/api/webhook/receive/{token}`}" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"快捷指令事件","date":"2026-12-25","type":"other","daysBefore":[1,3]}'`;

  const listEventsCurl = `curl "${SITE}/api/events" \\
  -H "X-API-Key: YOUR_API_KEY"`;

  const testNotifyCurl = `curl -X POST "${SITE}/api/events/{eventId}/test-send" \\
  -H "Authorization: Bearer YOUR_JWT_TOKEN"`;

  return (
    <div className="min-h-screen p-6 max-w-3xl mx-auto pb-24">
      <Button variant="ghost" onClick={() => navigate(-1)} aria-label="返回"><ArrowLeft className="mr-2" size={18} aria-hidden />返回</Button>
      <h1 id="main-content" className="text-2xl font-bold mt-4 mb-2" tabIndex={-1}>集成与自动化文档</h1>
      <p className="text-sm text-slate-500 mb-8">iOS 快捷指令、ntfy 推送、Zapier 与 Webhook 模板</p>

      <section className="mb-8 glass-panel p-6 rounded-2xl" aria-labelledby="ios-shortcuts-heading">
        <h2 id="ios-shortcuts-heading" className="text-lg font-semibold mb-2 flex items-center gap-2">
          <Smartphone size={20} aria-hidden /> iOS 快捷指令
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
          在 iPhone「快捷指令」App 中创建自动化，通过 Webhook 或 API Key 与 TimeMark 交互。
        </p>

        <h3 className="text-sm font-bold mb-2">步骤 1：获取 Webhook URL</h3>
        <p className="text-xs text-slate-500 mb-2">在「设置 → 集成」复制 Webhook 入站 URL，或下方只读字段：</p>
        <Input readOnly value={webhookUrl || '加载中...'} className="font-mono text-xs mb-2" aria-label="Webhook 入站 URL" />
        {webhookUrl && (
          <Button variant="outline" size="sm" className="min-h-11 mb-4" onClick={() => copyText(webhookUrl, 'Webhook URL')}>
            <Copy size={14} className="mr-1" aria-hidden /> 复制 Webhook
          </Button>
        )}

        <h3 className="text-sm font-bold mb-2">步骤 2：创建「新建事件」快捷指令</h3>
        <ol className="text-sm text-slate-600 dark:text-slate-400 list-decimal list-inside space-y-1 mb-3">
          <li>添加操作「询问输入」→ 事件名称</li>
          <li>添加「当前日期」格式化为 yyyy-MM-dd</li>
          <li>添加「获取 URL 内容」→ 方法 POST → JSON 请求体</li>
          <li>URL 填上方 Webhook；Body 示例见下方 curl</li>
        </ol>
        <pre className="text-xs bg-slate-100 dark:bg-slate-800 p-3 rounded overflow-x-auto mb-4" tabIndex={0}>{createEventCurl}</pre>
        <Button variant="outline" size="sm" className="min-h-11 mb-6" onClick={() => copyText(createEventCurl, '创建事件 curl')}>
          <Copy size={14} className="mr-1" aria-hidden /> 复制 curl
        </Button>

        <h3 className="text-sm font-bold mb-2">步骤 3：列出事件 / 测试通知</h3>
        <p className="text-xs text-slate-500 mb-2">API Key 可在「设置 → 安全与数据」生成；列出事件：</p>
        <pre className="text-xs bg-slate-100 dark:bg-slate-800 p-3 rounded overflow-x-auto mb-2" tabIndex={0}>{listEventsCurl}</pre>
        <pre className="text-xs bg-slate-100 dark:bg-slate-800 p-3 rounded overflow-x-auto mb-2" tabIndex={0}>{testNotifyCurl}</pre>
        <p className="text-xs text-slate-400">
          快捷指令 URL Scheme 示例（需替换 token）：
          <code className="block mt-1 break-all">shortcuts://run-shortcut?name=TimeMarkCreateEvent</code>
        </p>
      </section>

      <section className="mb-8 glass-panel p-6 rounded-2xl" aria-labelledby="ntfy-heading">
        <h2 id="ntfy-heading" className="text-lg font-semibold mb-2">ntfy 推送教程</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
          ntfy 是轻量自托管推送服务。TimeMark 在「通知渠道」添加 ntfy 账号后，事件提醒会 POST 到您的 Topic。
        </p>

        <h3 className="text-sm font-bold mb-2">1. 服务器与 Topic 命名</h3>
        <ul className="text-sm text-slate-600 dark:text-slate-400 list-disc list-inside space-y-1 mb-4">
          <li>公共实例：<code>https://ntfy.sh</code>（测试用，Topic 请用随机长字符串）</li>
          <li>自托管：<code>docker run -p 80:80 binwiederhier/ntfy serve</code></li>
          <li>Topic 命名建议：<code>timemark-{`{username}`}-alerts</code> 或 UUID，避免被他人订阅</li>
        </ul>

        <h3 className="text-sm font-bold mb-2">2. 在 TimeMark 配置</h3>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-2">
          「通知渠道 → 添加 ntfy」：服务器 URL 填下方地址，Token/Topic 填 Topic 名称。保存后点击「测试连接」。
        </p>
        <Button variant="outline" size="sm" className="min-h-11 mb-4" onClick={() => navigate('/channels')}>
          前往通知渠道配置
        </Button>

        <h3 className="text-sm font-bold mb-2">3. 移动端订阅</h3>
        <ol className="text-sm text-slate-600 dark:text-slate-400 list-decimal list-inside space-y-1 mb-4">
          <li>安装 ntfy App（iOS / Android）</li>
          <li>添加订阅 → 输入服务器与 Topic</li>
          <li>下方发送测试消息验证</li>
        </ol>

        <div className="flex flex-wrap gap-2 items-end mb-2">
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-slate-500 block mb-1">服务器</label>
            <Input value={ntfyServer} onChange={(e) => setNtfyServer(e.target.value)} aria-label="ntfy 服务器地址" />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-slate-500 block mb-1">Topic</label>
            <Input value={ntfyTopic} onChange={(e) => setNtfyTopic(e.target.value)} placeholder="my-secret-topic" aria-label="ntfy Topic" />
          </div>
          <Button onClick={testNtfy} disabled={ntfyTesting} className="min-h-11">
            <Send size={14} className="mr-1" aria-hidden />
            {ntfyTesting ? '发送中...' : '发送测试'}
          </Button>
        </div>
        {ntfyResult && <p className="text-sm text-slate-600 dark:text-slate-400" role="status">{ntfyResult}</p>}
      </section>

      <section id="google-oauth" className="mb-8 glass-panel p-6 rounded-2xl" aria-labelledby="google-oauth-heading">
        <h2 id="google-oauth-heading" className="text-lg font-semibold mb-2">Google 日历 OAuth（可选）</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
          默认不启用。不配环境变量时不影响 Webhook、ICS 订阅等。仅需从 Google 主日历自动导入时，由管理员配置 OAuth 后 redeploy。
        </p>
        <ol className="text-sm text-slate-600 dark:text-slate-400 list-decimal list-inside space-y-2 mb-3">
          <li>Google Cloud：启用 Calendar API，创建 Web OAuth 客户端，重定向 URI 为 <code className="text-xs">{SITE}/api/calendar/google-oauth/callback</code></li>
          <li>Vercel 环境变量：<code className="text-xs">GOOGLE_OAUTH_CLIENT_ID</code>、<code className="text-xs">GOOGLE_OAUTH_CLIENT_SECRET</code>（可选 <code className="text-xs">GOOGLE_OAUTH_REDIRECT_URI</code>）</li>
          <li>Redeploy 后，在「设置 → 集成」点击「连接 Google 日历」</li>
          <li>确认部署向导中数据库结构为 v27+</li>
        </ol>
        <p className="text-xs text-slate-500">
          不想配 OAuth？在 Google 日历复制 ICS 秘密地址，粘贴到「外部 ICS 订阅 URL」即可。完整说明见仓库 <code className="text-xs">docs/GOOGLE_CALENDAR_OAUTH.md</code>。
        </p>
      </section>

      <section className="mb-8 glass-panel p-6 rounded-2xl" aria-labelledby="zapier-heading">
        <h2 id="zapier-heading" className="text-lg font-semibold mb-2">Zapier / Make 模板</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">使用入站 Webhook 创建事件：</p>
        <pre className="text-xs bg-slate-100 dark:bg-slate-800 p-3 rounded overflow-x-auto" tabIndex={0}>{`POST ${webhookUrl || '{your-site}/api/webhook/receive/{token}'}
Content-Type: application/json

{"name":"会议","date":"2026-08-01","type":"meeting","daysBefore":[1]}`}</pre>
      </section>

      <section className="glass-panel p-6 rounded-2xl" aria-labelledby="bookmarklet-heading">
        <h2 id="bookmarklet-heading" className="text-lg font-semibold mb-2">书签小工具 (Bookmarklet)</h2>
        <p className="text-sm mb-2">将以下链接拖到书签栏，在任意页面点击可快速记录今日事项：</p>
        <code className="text-xs break-all block bg-slate-100 dark:bg-slate-800 p-3 rounded">
          {'javascript:(function(){var n=prompt(\'事件名称\');if(!n)return;var d=new Date().toISOString().slice(0,10);window.open(\'/dashboard?quick=\'+encodeURIComponent(n+\'|\'+d));})();'}
        </code>
      </section>
    </div>
  );
}
