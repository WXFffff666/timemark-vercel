import { AlarmClock } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { CardShell } from './CardShell';
import { useCardData } from './useCardData';

interface ExpiringItem {
  id: number;
  title: string;
  kind: string;
  next_due_date: string;
}

function daysUntil(ymd: string): number | null {
  const date = new Date(`${ymd.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((date.getTime() - today.getTime()) / 86_400_000);
}

export function ExpiringCard() {
  const { data, loading, error, reload } = useCardData(() => api.get<ExpiringItem[]>('/expiry/upcoming?days=30'));
  const items = data ?? [];

  return (
    <CardShell
      title="即将到期"
      icon={<AlarmClock size={16} aria-hidden />}
      href="/expiry"
      loading={loading}
      error={error}
      isEmpty={items.length === 0}
      emptyText="30 天内没有到期项"
      onRetry={reload}
    >
      <ul className="space-y-2">
        {items.slice(0, 5).map((item) => {
          const days = daysUntil(item.next_due_date);
          return (
            <li key={item.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-sm text-slate-700 dark:text-slate-200">{item.title}</span>
              <Badge variant={days !== null && days <= 3 ? 'destructive' : 'secondary'} className="text-[10px]">
                {days === null ? item.next_due_date : days <= 0 ? '已到期' : `${days} 天后`}
              </Badge>
            </li>
          );
        })}
      </ul>
      {items.length > 5 && <p className="mt-2 text-xs text-hint">还有 {items.length - 5} 项…</p>}
    </CardShell>
  );
}
