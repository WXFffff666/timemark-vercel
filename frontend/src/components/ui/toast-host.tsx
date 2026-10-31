import { useEffect, useState } from 'react';
import { CheckCircle2, Info, XCircle, X } from 'lucide-react';
import { subscribeToasts, toast, type ToastItem } from '@/lib/toast';

/**
 * v2.41 R20：toast 渲染宿主——App 根部挂一次。
 * 顶部居中（不与底部导航/悬浮球/助手 dock 抢空间），z-[70] 高于调色板。
 * 错误 role=alert（即时播报），其余 role=status（礼貌播报）。
 */

const KIND_STYLE: Record<ToastItem['kind'], { icon: typeof CheckCircle2; ring: string; iconColor: string }> = {
  success: { icon: CheckCircle2, ring: 'border-emerald-200/70 dark:border-emerald-800/50', iconColor: 'text-emerald-500' },
  error: { icon: XCircle, ring: 'border-red-200/70 dark:border-red-800/50', iconColor: 'text-red-500' },
  info: { icon: Info, ring: 'border-blue-200/70 dark:border-blue-800/50', iconColor: 'text-blue-500' },
};

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setItems), []);

  if (items.length === 0) return null;

  return (
    <div
      className="fixed left-1/2 top-4 z-[70] flex w-[min(92vw,26rem)] -translate-x-1/2 flex-col gap-2"
      data-testid="toast-host"
    >
      {items.map((t) => {
        const s = KIND_STYLE[t.kind];
        const Icon = s.icon;
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            data-testid={`toast-${t.kind}`}
            className={`glass-panel flex items-start gap-2.5 rounded-2xl border px-4 py-3 shadow-lg ${s.ring} toast-slide-in`}
          >
            <Icon size={18} className={`mt-0.5 shrink-0 ${s.iconColor}`} aria-hidden />
            <p className="flex-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">{t.text}</p>
            {t.action && (
              <button
                type="button"
                data-testid="toast-action"
                className="shrink-0 rounded-full px-3 py-1 text-xs font-bold text-primary-600 transition hover:bg-primary-500/10 dark:text-primary-400"
                onClick={() => {
                  t.action?.onClick();
                  toast.dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="关闭通知"
              className="shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              onClick={() => toast.dismiss(t.id)}
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
