import { CalendarDays } from 'lucide-react';
import type { Event } from '@timemark/shared';
import { api } from '@/lib/api';
import { useTimezone } from '@/components/RealtimeClock';
import { Badge } from '@/components/ui/badge';
import { CardShell } from './CardShell';
import { useCardData } from './useCardData';
import { eventTypeLabel, isEventToday } from '@/lib/calendar-utils';

export function TodayEventsCard() {
  const { timezone } = useTimezone();
  const { data, loading, error, reload } = useCardData(() => api.get<Event[]>('/events'), [timezone]);
  const events = (data ?? []).filter((event) => isEventToday(event, new Date(), timezone));

  return (
    <CardShell
      title="今日事件"
      icon={<CalendarDays size={16} aria-hidden />}
      href="/calendar"
      loading={loading}
      error={error}
      isEmpty={events.length === 0}
      emptyText="今天没有事件"
      onRetry={reload}
    >
      <ul className="space-y-2">
        {events.slice(0, 5).map((event) => (
          <li key={event.id} className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{event.name}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {event.reminderConfig?.reminderTimes?.[0] && (
                <span className="text-xs text-hint">{event.reminderConfig.reminderTimes[0]}</span>
              )}
              <Badge variant="secondary" className="text-[10px]">
                {eventTypeLabel(event.type)}
              </Badge>
            </span>
          </li>
        ))}
      </ul>
      {events.length > 5 && <p className="mt-2 text-xs text-hint">还有 {events.length - 5} 个事件…</p>}
    </CardShell>
  );
}
