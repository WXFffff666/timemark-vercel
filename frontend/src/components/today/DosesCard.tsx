import { Pill } from 'lucide-react';
import type { TodayDose } from '@timemark/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { CardShell } from './CardShell';
import { useCardData } from './useCardData';

function formatDoseTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function DosesCard() {
  const { data, loading, error, reload } = useCardData(() => api.get<TodayDose[]>('/medications/today'));
  const doses = data ?? [];
  const pending = doses.filter((dose) => dose.status === 'pending');

  return (
    <CardShell
      title="今日用药"
      icon={<Pill size={16} aria-hidden />}
      href="/medications"
      loading={loading}
      error={error}
      isEmpty={doses.length === 0}
      emptyText="今天没有用药计划"
      onRetry={reload}
    >
      <p className="mb-2 text-sm text-slate-700 dark:text-slate-200">
        待服用 <span className="font-bold">{pending.length}</span> / 共 {doses.length} 剂
      </p>
      <ul className="space-y-2">
        {doses.slice(0, 4).map((dose) => (
          <li key={dose.id} className="flex items-center justify-between gap-2">
            <span className="truncate text-sm text-slate-700 dark:text-slate-200">
              {formatDoseTime(dose.scheduled_for)} {dose.medication.name}
            </span>
            <Badge
              variant={dose.status === 'taken' ? 'success' : dose.status === 'pending' ? 'secondary' : 'destructive'}
              className="text-[10px]"
            >
              {dose.status === 'taken' ? '已服' : dose.status === 'skipped' ? '跳过' : dose.status === 'missed' ? '漏服' : '待服'}
            </Badge>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}
