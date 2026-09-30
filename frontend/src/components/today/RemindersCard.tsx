import { Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { CardShell } from './CardShell';
import { useCardData } from './useCardData';

interface ReminderLog {
  id: number;
  event_name: string;
  status: 'success' | 'failed';
  created_at: string;
}

function isToday(value: string): boolean {
  const date = new Date(value);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function RemindersCard() {
  const { data, loading, error, reload } = useCardData(() => api.get<ReminderLog[]>('/events/reminder-logs'));
  const logs = data ?? [];
  const todayCount = logs.filter((log) => isToday(log.created_at)).length;
  const recent = logs.slice(0, 3);

  return (
    <CardShell
      title="提醒记录"
      icon={<Bell size={16} aria-hidden />}
      href="/trigger-logs"
      loading={loading}
      error={error}
      isEmpty={logs.length === 0}
      emptyText="暂无提醒记录"
      onRetry={reload}
    >
      <p className="mb-2 text-sm text-slate-700 dark:text-slate-200">
        今日已发送 <span className="font-bold">{todayCount}</span> 条
      </p>
      <ul className="space-y-2">
        {recent.map((log) => (
          <li key={log.id} className="flex items-center justify-between gap-2">
            <span className="truncate text-sm text-slate-700 dark:text-slate-200">{log.event_name}</span>
            <Badge variant={log.status === 'success' ? 'success' : 'destructive'} className="text-[10px]">
              {log.status === 'success' ? '成功' : '失败'}
            </Badge>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}
