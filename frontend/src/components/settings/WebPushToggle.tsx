import { useCallback, useEffect, useState } from 'react';
import { BellRing, Monitor, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import {
  getWebPushState,
  sendTestWebPush,
  subscribeWebPush,
  unsubscribeWebPush,
  type WebPushState,
} from '@/lib/push';

/** v2.27 遗留3：设备列表条目（GET /api/push/subscriptions） */
interface PushDevice {
  id: number;
  endpointHost: string;
  createdAt: string;
}

/**
 * Settings → 浏览器推送（Web Push, checkbox 84）.
 *
 * Self-contained section: toggle (permission request via lib/push.ts) + a test
 * push button. Kept in its own component so the Settings.tsx diff stays tiny.
 */
export function WebPushToggle() {
  const [state, setState] = useState<WebPushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [devices, setDevices] = useState<PushDevice[] | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const res = await api.get<{ devices: PushDevice[] }>('/push/subscriptions');
      setDevices(res.devices);
    } catch {
      setDevices(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getWebPushState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setState('unsubscribed');
      });
    void loadDevices();
    return () => {
      cancelled = true;
    };
  }, [loadDevices]);

  const handleToggle = async (enabled: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      if (enabled) {
        const result = await subscribeWebPush();
        if (result === 'granted') {
          setState('subscribed');
          setMessage('已开启浏览器推送');
        } else if (result === 'denied') {
          setState('denied');
          setMessage('浏览器通知权限被拒绝，请在浏览器设置中允许通知后重试');
        } else {
          setState('unsupported');
          setMessage('当前浏览器不支持 Web Push');
        }
      } else {
        await unsubscribeWebPush();
        setState('unsubscribed');
        setMessage('已关闭浏览器推送');
      }
      void loadDevices();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    setMessage('');
    try {
      const result = await sendTestWebPush();
      const removed = result.removed > 0 ? `，已清理 ${result.removed} 个失效订阅` : '';
      setMessage(`测试通知已发送（${result.sent} 成功${removed}）`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '测试推送发送失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider flex items-center gap-2">
        <BellRing className="w-4 h-4" /> 浏览器推送
      </h2>
      <div className="glass-panel rounded-[2.5rem] p-6 space-y-4 ring-1 ring-black/5 dark:ring-white/10">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-2xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 flex items-center justify-center shadow-inner border border-indigo-100 dark:border-indigo-800/50">
              <BellRing size={22} />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">浏览器通知</h3>
              <p className="text-xs text-slate-500">不打开网页也能收到提醒（Web Push / VAPID）</p>
            </div>
          </div>
          <Switch
            checked={state === 'subscribed'}
            disabled={busy || state === 'loading' || state === 'unsupported'}
            onCheckedChange={handleToggle}
            aria-label="浏览器推送"
          />
        </div>
        {state === 'subscribed' && (
          <Button variant="outline" size="sm" onClick={handleTest} disabled={busy}>
            {busy ? '发送中...' : '发送测试通知'}
          </Button>
        )}
        {devices && devices.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase mb-2">
              已订阅设备（{devices.length}）
            </p>
            <ul className="space-y-1.5 max-h-48 overflow-y-auto overscroll-contain pr-1">
              {devices.map((d) => (
                <li key={d.id} className="flex items-center justify-between rounded-xl border border-slate-200/70 dark:border-slate-700/50 px-3 py-2 text-xs">
                  <span className="flex items-center gap-2 min-w-0">
                    <Monitor size={13} className="shrink-0 text-slate-400" />
                    <span className="truncate text-slate-700 dark:text-slate-300" title={d.endpointHost}>
                      {d.endpointHost}
                    </span>
                    <span className="shrink-0 text-slate-400">
                      {Number.isNaN(new Date(d.createdAt).getTime()) ? '' : new Date(d.createdAt).toLocaleDateString('zh-CN')}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label="删除该设备订阅"
                    className="shrink-0 text-slate-400 hover:text-red-500 transition disabled:opacity-50"
                    disabled={busy}
                    onClick={async () => {
                      if (!confirm('移除该设备的推送订阅？')) return;
                      setBusy(true);
                      try {
                        await api.delete(`/push/subscriptions/${d.id}`);
                        await loadDevices();
                      } catch (e) {
                        setMessage(e instanceof Error ? e.message : '删除失败');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {message && <p className="text-xs text-slate-500 dark:text-slate-400">{message}</p>}
      </div>
    </section>
  );
}
