import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

/**
 * v2.27 F45：操作审计卡片（安全页）。
 *
 * 消费 GET /api/audit（后端已支持 from/to/limit/offset），此前该端点没有任何
 * UI 入口。只读展示最近操作（summary + 时间 + 来源），支持日期范围筛选。
 */

interface AuditItem {
  id: number;
  action: string;
  entityKind: string;
  summary: string;
  createdAt?: string;
  actor?: { via?: string };
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN');
}

export function AuditTrailCard() {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = async () => {
    setFailed(false);
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (/^\d{4}-\d{2}-\d{2}$/.test(from)) params.set('from', from);
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) params.set('to', to);
      const res = await api.get<{ items: AuditItem[]; total: number }>(`/audit?${params.toString()}`);
      setItems(Array.isArray(res?.items) ? res.items : []);
    } catch {
      setFailed(true);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="glass-panel rounded-[2.5rem] p-6 ring-1 ring-black/5 dark:ring-white/10 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">操作审计</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            破坏性操作（删除/批量/覆盖）的不可篡改记录，可在撤销窗口内 Undo
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
            aria-label="起始日期"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
            aria-label="结束日期"
          />
          <Button variant="secondary" size="sm" className="rounded-full min-h-10" onClick={() => void load()}>
            筛选
          </Button>
        </div>
      </div>

      {failed && <p className="text-sm text-red-500">审计记录加载失败，请稍后重试</p>}
      {items !== null && !failed && items.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400">暂无审计记录</p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="space-y-2 max-h-72 overflow-y-auto overscroll-contain pr-1">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 px-3 py-2 text-xs flex items-start justify-between gap-3"
            >
              <span className="min-w-0">
                <span className="font-medium text-slate-700 dark:text-slate-200">{item.summary}</span>
                <span className="ml-2 text-slate-400">
                  {item.action} · {item.entityKind}
                </span>
              </span>
              <span className="shrink-0 text-slate-400">
                {formatDate(item.createdAt)}
                {item.actor?.via && item.actor.via !== 'api' ? ` · ${item.actor.via}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
