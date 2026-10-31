import { ListChecks } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { useTimezone } from '@/components/RealtimeClock';
import { useEventStore } from '@/stores/event.store';
import { CardShell } from './CardShell';
import { useCardData } from './useCardData';
import { daysUntilEvent, eventTypeLabel, resolveNextOccurrenceDate, todoCompletionKey } from '@/lib/calendar-utils';

interface TodoCompletion {
  eventId: number;
  occurrenceDate: string;
}

export function OverdueTodosCard() {
  const { timezone } = useTimezone();
  // v2.44 R30：events 改用共享 event store（与 TodayEventsCard 同源，in-flight
  // 去重）——此前本卡独立再拉一次 /events，Today 页首屏同一请求发两遍。
  const { events: allEvents, fetchEvents } = useEventStore();
  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);
  const { data: completionsData, loading, error, reload } = useCardData(
    () => api.get<TodoCompletion[]>('/todos/completions'),
    [timezone],
  );

  const now = new Date();
  const completions = completionsData ?? [];
  const completed = new Set(completions.map((completion) => todoCompletionKey(completion.eventId, completion.occurrenceDate)));
  const overdue = allEvents.filter((event) => {
    if (event.reminderConfig?.enabled === false) return false;
    if (daysUntilEvent(event.date, now, timezone) >= 0) return false;
    // A recurring event whose next occurrence is still ahead is not overdue.
    if (event.recurringConfig?.enabled && daysUntilEvent(resolveNextOccurrenceDate(event, now, timezone), now, timezone) >= 0) {
      return false;
    }
    return !completed.has(todoCompletionKey(event.id, event.date));
  });

  return (
    <CardShell
      title="逾期待办"
      icon={<ListChecks size={16} aria-hidden />}
      href="/todos"
      loading={loading}
      error={error}
      isEmpty={overdue.length === 0}
      emptyText="没有逾期的待办"
      onRetry={reload}
    >
      <ul className="space-y-2">
        {overdue.slice(0, 5).map((event) => (
          <li key={event.id} className="flex items-center justify-between gap-2">
            <span className="truncate text-sm text-slate-700 dark:text-slate-200">{event.name}</span>
            <span className="shrink-0 text-xs text-destructive">
              {event.date.slice(0, 10)} · {eventTypeLabel(event.type)}
            </span>
          </li>
        ))}
      </ul>
      {overdue.length > 5 && <p className="mt-2 text-xs text-hint">还有 {overdue.length - 5} 项…</p>}
    </CardShell>
  );
}
