import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';

const PRESETS = ['春节', '端午', '中秋', '元旦', '国庆'];

export default function LunarHolidays() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const importPresets = async () => {
    setLoading(true);
    setMsg('');
    try {
      await api.post('/data/import-lunar-holidays', { presets: PRESETS });
      setMsg(`已导入 ${PRESETS.length} 个农历节日预设`);
    } catch {
      setMsg('导入失败，请确认后端 lunar-holidays 服务可用');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen p-6 max-w-xl mx-auto">
      <Button variant="ghost" onClick={() => navigate(-1)}><ArrowLeft className="mr-2" size={18} />返回</Button>
      <h1 className="text-2xl font-bold mt-4 mb-4">农历节日预设</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">一键导入常见农历节日提醒事件。</p>
      <ul className="mb-4 list-disc list-inside text-sm">{PRESETS.map((p) => <li key={p}>{p}</li>)}</ul>
      <Button onClick={importPresets} disabled={loading}>{loading ? '导入中…' : '导入预设'}</Button>
      {msg && <p className="mt-3 text-sm text-green-600">{msg}</p>}
    </div>
  );
}
