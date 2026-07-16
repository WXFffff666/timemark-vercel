import { useState, useEffect } from 'react';
import { ArrowLeft, Plus, Trash2, GitBranch } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useSmartBack } from '@/hooks/useSmartBack';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { NOTIFICATION_PRESET_LIST } from '@timemark/shared/notification-presets';

interface ConditionalRule {
  id: number;
  days_before: number;
  channels: string[] | string;
}

const CHANNEL_OPTIONS = [
  'email', 'resend', 'feishu', 'dingtalk', 'wecom', 'telegram', 'discord', 'slack', 'pushover', 'ntfy',
];

export default function NotificationRules() {
  const navigate = useNavigate();
  const goBack = useSmartBack('/settings');
  const [rules, setRules] = useState<ConditionalRule[]>([]);
  const [preset, setPreset] = useState('');
  const [presetSaving, setPresetSaving] = useState(false);
  const [daysBefore, setDaysBefore] = useState('7');
  const [selectedChannels, setSelectedChannels] = useState<string[]>(['email']);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [rulesRes, cfg] = await Promise.all([
        api.get<ConditionalRule[]>('/conditional-rules'),
        api.get<{ notification_preset?: string | null }>('/config/notification-advanced').catch(() => ({})),
      ]);
      setRules((rulesRes || []).map((r) => ({
        ...r,
        channels: typeof r.channels === 'string' ? JSON.parse(r.channels) : r.channels,
      })));
      setPreset(cfg?.notification_preset || '');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleChannel = (ch: string) => {
    setSelectedChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch],
    );
  };

  const addRule = async () => {
    const d = parseInt(daysBefore, 10);
    if (Number.isNaN(d) || d < 0) return;
    if (selectedChannels.length === 0) return;
    await api.post('/conditional-rules', { daysBefore: d, channels: selectedChannels });
    await load();
  };

  const removeRule = async (id: number) => {
    if (!confirm('删除该规则？')) return;
    await api.delete(`/conditional-rules/${id}`);
    await load();
  };

  const savePreset = async () => {
    setPresetSaving(true);
    try {
      await api.post('/config/notification-advanced', { notification_preset: preset || null });
    } finally {
      setPresetSaving(false);
    }
  };

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-3xl mx-auto pb-24">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={goBack} aria-label="返回">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitBranch className="w-6 h-6" /> 提醒规则
          </h1>
          <p className="text-sm text-slate-500">按提前天数指定渠道；规则优先于套餐预设</p>
        </div>
      </div>

      <section className="glass-panel rounded-2xl p-5 mb-6 space-y-3">
        <h2 className="font-semibold">通知套餐（分级告警）</h2>
        <p className="text-xs text-slate-500">无自定义规则时，按套餐在不同提前天数选用渠道</p>
        <div className="grid gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={!preset} onChange={() => setPreset('')} />
            不使用套餐（仅用事件渠道）
          </label>
          {NOTIFICATION_PRESET_LIST.map((p) => (
            <label key={p.id} className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="radio" checked={preset === p.id} onChange={() => setPreset(p.id)} className="mt-1" />
              <span>
                <span className="font-medium">{p.label}</span>
                <span className="block text-xs text-slate-500">{p.description}</span>
              </span>
            </label>
          ))}
        </div>
        <Button onClick={savePreset} disabled={presetSaving} className="min-h-11">
          {presetSaving ? '保存中...' : '保存套餐'}
        </Button>
      </section>

      <section className="glass-panel rounded-2xl p-5 mb-6 space-y-4">
        <h2 className="font-semibold">条件规则</h2>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="text-xs text-slate-500">提前天数</label>
            <Input
              type="number"
              min={0}
              value={daysBefore}
              onChange={(e) => setDaysBefore(e.target.value)}
              className="w-24 min-h-11"
              aria-label="提前天数"
            />
          </div>
          <div className="flex-1">
            <p className="text-xs text-slate-500 mb-1">渠道</p>
            <div className="flex flex-wrap gap-1">
              {CHANNEL_OPTIONS.map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => toggleChannel(ch)}
                  className={`px-3 py-2 rounded-lg text-xs min-h-11 ${
                    selectedChannels.includes(ch)
                      ? 'bg-primary-500 text-white'
                      : 'bg-slate-100 dark:bg-slate-800'
                  }`}
                  aria-pressed={selectedChannels.includes(ch)}
                >
                  {ch}
                </button>
              ))}
            </div>
          </div>
          <Button onClick={addRule} className="min-h-11">
            <Plus className="w-4 h-4 mr-1" /> 添加
          </Button>
        </div>
      </section>

      {loading ? (
        <p className="text-center text-slate-500">加载中...</p>
      ) : rules.length === 0 ? (
        <p className="text-center text-slate-500">暂无条件规则</p>
      ) : (
        <ul className="space-y-3">
          {rules.map((r) => {
            const chs = Array.isArray(r.channels) ? r.channels : [];
            return (
              <li key={r.id} className="glass-panel rounded-xl p-4 flex items-center justify-between gap-3">
                <div>
                  <span className="font-medium">提前 {r.days_before} 天</span>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {chs.map((c) => (
                      <Badge key={c} variant="secondary">{c}</Badge>
                    ))}
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => removeRule(r.id)} aria-label="删除规则" className="min-h-11 min-w-11">
                  <Trash2 className="w-4 h-4 text-red-500" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
