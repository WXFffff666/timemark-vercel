import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';

export default function IntegrationsDocs() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen p-6 max-w-3xl mx-auto">
      <Button variant="ghost" onClick={() => navigate(-1)}><ArrowLeft className="mr-2" size={18} />返回</Button>
      <h1 className="text-2xl font-bold mt-4 mb-6">集成与自动化文档</h1>

      <section className="mb-8 glass-panel p-6 rounded-2xl">
        <h2 className="text-lg font-semibold mb-2">Zapier / Make 模板</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">使用入站 Webhook 创建事件：</p>
        <pre className="text-xs bg-slate-100 dark:bg-slate-800 p-3 rounded overflow-x-auto">{`POST {your-site}/api/webhook/receive/{token}
Content-Type: application/json

{"name":"会议","date":"2026-08-01","type":"meeting","daysBefore":[1]}`}</pre>
      </section>

      <section className="mb-8 glass-panel p-6 rounded-2xl">
        <h2 className="text-lg font-semibold mb-2">iOS 快捷指令</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">创建快捷指令 → 获取 URL 内容 → POST JSON 到上方 Webhook URL。</p>
      </section>

      <section className="glass-panel p-6 rounded-2xl">
        <h2 className="text-lg font-semibold mb-2">书签小工具 (Bookmarklet)</h2>
        <p className="text-sm mb-2">将以下链接拖到书签栏，在任意页面点击可快速记录今日事项：</p>
        <code className="text-xs break-all block bg-slate-100 dark:bg-slate-800 p-3 rounded">
          {'javascript:(function(){var n=prompt(\'事件名称\');if(!n)return;var d=new Date().toISOString().slice(0,10);window.open(\'/dashboard?quick=\'+encodeURIComponent(n+\'|\'+d));})();'}
        </code>
      </section>
    </div>
  );
}
