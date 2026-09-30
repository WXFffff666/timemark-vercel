import { Repeat } from 'lucide-react';
import { dateStringInTimeZone, isHabitScheduledOn, type HabitWithStreak } from '@timemark/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { CardShell } from './CardShell';
import { useCardData } from './useCardData';

export function HabitsDueCard() {
  const { data, loading, error, reload } = useCardData(() => api.get<HabitWithStreak[]>('/habits?active=true'));
  const habits = data ?? [];
  const today = habits.find((habit) => habit.streak?.today)?.streak.today
    ?? dateStringInTimeZone(new Date(), 'Asia/Shanghai');
  const due = habits.filter((habit) => isHabitScheduledOn(today, habit.schedule_days) && !habit.streak.targetMet);

  return (
    <CardShell
      title="今日习惯"
      icon={<Repeat size={16} aria-hidden />}
      href="/habits"
      loading={loading}
      error={error}
      isEmpty={habits.length === 0}
      emptyText="还没有习惯"
      onRetry={reload}
    >
      {due.length === 0 ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">今日习惯已全部达标 🎉</p>
      ) : (
        <ul className="space-y-2">
          {due.slice(0, 5).map((habit) => (
            <li key={habit.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-sm text-slate-700 dark:text-slate-200">
                {habit.icon ? `${habit.icon} ` : ''}
                {habit.name}
              </span>
              <Badge variant="secondary" className="text-[10px]">
                {habit.streak.todayCount}/{habit.target_per_period}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}
