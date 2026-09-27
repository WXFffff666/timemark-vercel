import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  getWebPushState,
  sendTestWebPush,
  subscribeWebPush,
  unsubscribeWebPush,
  type WebPushState,
} from '@/lib/push';

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

  useEffect(() => {
    let cancelled = false;
    getWebPushState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setState('unsubscribed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        {message && <p className="text-xs text-slate-500 dark:text-slate-400">{message}</p>}
      </div>
    </section>
  );
}
