import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';

export default function DockerMigration() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen p-6 max-w-2xl mx-auto">
      <Button variant="ghost" onClick={() => navigate(-1)}><ArrowLeft className="mr-2" size={18} />返回</Button>
      <h1 className="text-2xl font-bold mt-4 mb-4">Docker → Vercel 迁移向导</h1>
      <ol className="list-decimal list-inside space-y-3 text-sm text-slate-700 dark:text-slate-300">
        <li>在 Docker 实例导出 JSON 备份（设置 → 数据备份）</li>
        <li>在 Vercel 部署 TimeMark 并配置 DATABASE_URL、JWT_SECRET、MASTER_KEY、CRON_SECRET</li>
        <li>登录 Vercel 实例，导入备份 JSON</li>
        <li>在部署向导中确认 schema v25+ 与 pooler 连接串</li>
        <li>配置外部 Cron 调用 /api/cron/reminder-check（每分钟）</li>
        <li>重新配置通知渠道 API Key（加密密钥可能不同需重填）</li>
      </ol>
    </div>
  );
}
