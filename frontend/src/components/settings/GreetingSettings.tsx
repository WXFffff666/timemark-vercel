import { useCallback, useEffect, useState } from 'react';
import { Cake, Loader2, RefreshCw, Send, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

type GreetingSettings = {
  greetingMode: 'auto' | 'draft';
  greetingAiEnabled: boolean;
  aiConfigured: boolean;
};

type PreviewRow = {
  contactId: number;
  name: string;
  daysUntil: number;
  dateLine: string;
  optedOut: boolean;
  preview?: { subject: string };
};

type HistoryRow = {
  id: number;
  contact_name: string | null;
  contact_id: number | null;
  status: string;
  channel: string;
  subject: string | null;
  body_preview: string | null;
  recipients: string | null;
  created_at: string;
};

/**
 * 生日祝福（v2.25）：模式开关（全自动/草稿确认）+ AI 生成开关 +
 * 未来 30 天预演（所见即所发：组合引擎确定性预览）+ 草稿发送/丢弃 + 历史。
 */
export function GreetingSettings() {
  const [settings, setSettings] = useState<GreetingSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [operating, setOperating] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p, h] = await Promise.all([
        api.get<GreetingSettings>('/greetings/settings'),
        api.get<{ rows: PreviewRow[] }>('/greetings/preview?days=30'),
        api.get<{ rows: HistoryRow[] }>('/greetings/history'),
      ]);
      setSettings(s);
      setRows(p?.rows ?? []);
      setHistory(h?.rows ?? []);
    } catch {
      setMessage('祝福设置加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const updateSettings = async (patch: Partial<GreetingSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaving(true);
    try {
      await api.post('/greetings/settings', {
        greetingMode: next.greetingMode,
        greetingAiEnabled: next.greetingAiEnabled,
      });
    } catch {
      setMessage('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const sendDraft = async (draftId: number) => {
    setOperating(`send-${draftId}`);
    try {
      const res = await api.post<{ recipients: string[]; failed: number }>('/greetings/send-draft', { draftId });
      setMessage(`已发送给 ${(res?.recipients ?? []).length} 个收件人`);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '发送失败');
    } finally {
      setOperating(null);
    }
  };

  const discardDraft = async (draftId: number) => {
    setOperating(`discard-${draftId}`);
    try {
      await api.post('/greetings/discard-draft', { draftId });
      await loadAll();
    } catch {
      setMessage('丢弃失败');
    } finally {
      setOperating(null);
    }
  };

  const drafts = history.filter((h) => h.status === 'draft');
  const sentCount = history.filter((h) => h.status === 'sent').length;

  return (
    <div className="glass-panel rounded-[2.5rem] p-6 space-y-4 ring-1 ring-black/5 dark:ring-white/10">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-600 dark:text-slate-300 flex items-center gap-2">
          <Cake className="w-4 h-4 text-pink-500" /> 生日祝福
        </h3>
        <Button variant="ghost" size="icon" className="rounded-full min-h-9 min-w-9" onClick={() => void loadAll()} aria-label="刷新祝福设置">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </Button>
      </div>

      {settings && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">发送模式</p>
              <p className="text-xs text-slate-400 mt-0.5">自动：当天生成并直接发送；草稿：进列表等你确认</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={settings.greetingMode === 'auto' ? 'default' : 'outline'}
                size="sm"
                className="rounded-full"
                onClick={() => void updateSettings({ greetingMode: 'auto' })}
                disabled={saving}
              >
                自动
              </Button>
              <Button
                variant={settings.greetingMode === 'draft' ? 'default' : 'outline'}
                size="sm"
                className="rounded-full"
                onClick={() => void updateSettings({ greetingMode: 'draft' })}
                disabled={saving}
              >
                草稿确认
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">AI 个性化生成</p>
              <p className="text-xs text-slate-400 mt-0.5">
                {settings.aiConfigured
                  ? '通过已配置的 AI 网关按联系人上下文生成；关闭或失败时用内置组合引擎'
                  : '未配置 AI 网关——将使用内置组合引擎（每人每年不同文）'}
              </p>
            </div>
            <Switch
              checked={settings.greetingAiEnabled}
              onCheckedChange={(v) => void updateSettings({ greetingAiEnabled: v })}
              disabled={saving}
              aria-label="AI 个性化生成开关"
            />
          </div>
        </div>
      )}

      {message && (
        <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-sm text-slate-600 dark:text-slate-300">
          {message}
        </div>
      )}

      {/* 未来 30 天预演 */}
      <div>
        <p className="text-xs font-semibold text-slate-500 mb-2">未来 30 天预演（{rows.length} 人）</p>
        {rows.length === 0 && <p className="text-xs text-slate-400">窗口内没有生日。</p>}
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={`p-${r.contactId}`} className="rounded-xl border border-slate-200/60 dark:border-slate-700/50 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                    {r.name}
                    <span className="ml-2 text-xs text-slate-400">
                      {r.daysUntil === 0 ? '今天' : `${r.daysUntil} 天后`} · {r.dateLine}
                    </span>
                  </p>
                  <p className="text-xs text-slate-400 truncate">{r.preview?.subject ?? ''}</p>
                </div>
                {r.optedOut && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">
                    已退订
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 草稿（draft 模式下生成） */}
      {drafts.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 mb-2">待确认草稿（{drafts.length}）</p>
          <div className="space-y-2">
            {drafts.map((d) => (
              <div key={`d-${d.id}`} className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-900/10 px-4 py-3">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{d.contact_name ?? `联系人 #${d.contact_id}`}</p>
                <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{d.subject}</p>
                <div className="flex gap-2 mt-2">
                  <Button size="sm" variant="secondary" className="rounded-full" onClick={() => void sendDraft(d.id)} disabled={operating === `send-${d.id}`}>
                    {operating === `send-${d.id}` ? <Loader2 size={13} className="mr-1 animate-spin" /> : <Send size={13} className="mr-1" />}
                    发送
                  </Button>
                  <Button size="sm" variant="ghost" className="rounded-full text-red-500" onClick={() => void discardDraft(d.id)} disabled={operating === `discard-${d.id}`}>
                    <Trash2 size={13} className="mr-1" /> 丢弃
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-slate-400">
        今年已发 {sentCount} 条祝福 · 收件人仅限你的联系人（发信白名单）· 联系人可单独退订
      </p>
    </div>
  );
}
