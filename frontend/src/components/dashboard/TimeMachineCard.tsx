import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import { api } from '@/lib/api';

/**
 * 时光回顾 / 「N 年前的今天」（plan todo 82）。
 *
 * 只读消费 `GET /api/stats/on-this-day`：该接口按 user_id 限定，返回同一公历日
 * ≥1 年前发生的事件与互动，每条带一个指向其来源页面的链接。
 *
 * 空历史 = 什么都不渲染：数据到达前、请求失败、或 `items` 为空时组件都返回 null，
 * 绝不留下空壳或永久骨架屏。
 */

interface OnThisDayItem {
  kind: 'event' | 'interaction';
  id: number;
  title: string;
  detail: string | null;
  occurredOn: string;
  yearsAgo: number;
  sourcePath: string;
  sourceLabel: string;
}

export function TimeMachineCard() {
  const [items, setItems] = useState<OnThisDayItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ date: string; items: OnThisDayItem[] }>('/stats/on-this-day')
      .then((data) => {
        if (cancelled) return;
        setItems(Array.isArray(data?.items) ? data.items : []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // No history (or not loaded yet): render nothing at all - not an empty shell.
  if (!items || items.length === 0) return null;

  return (
    <section
      className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10"
      data-testid="time-machine-card"
      aria-label="时光回顾"
    >
      <div className="flex items-center gap-2">
        <History className="w-4 h-4 text-primary-600 dark:text-primary-400" aria-hidden />
        <h2 className="text-sm font-bold text-slate-700 dark:text-slate-200">时光回顾</h2>
        <span className="text-[10px] text-slate-400">N 年前的今天</span>
      </div>

      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li
            key={`${item.kind}-${item.id}`}
            data-testid={`memory-item-${item.kind}-${item.id}`}
            data-years-ago={item.yearsAgo}
            className="flex items-start justify-between gap-3 rounded-xl bg-white/50 dark:bg-white/5 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate" title={item.title}>
                {item.title}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {item.yearsAgo} 年前的今天 · {item.occurredOn}
                {item.detail ? ` · ${item.detail}` : ''}
              </p>
            </div>
            <Link
              to={item.sourcePath}
              data-testid={`memory-link-${item.kind}-${item.id}`}
              className="shrink-0 self-center text-xs font-semibold text-primary-600 dark:text-primary-400 hover:underline"
            >
              {item.sourceLabel}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
