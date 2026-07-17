import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarClock, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { useEventStore } from '@/stores/event.store';
import {
  daysUntilEvent,
  eventTypeLabel,
  getTodoEvents,
} from '@/lib/calendar-utils';

export default function Todos() {
  const navigate = useNavigate();
  const { events, fetchEvents } = useEventStore();

  useEffect(() => {
    if (events.length === 0) fetchEvents();
  }, [events.length, fetchEvents]);

  const todos = useMemo(() => getTodoEvents(events), [events]);

  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);

  const dayLabel = (dateStr: string) => {
    const d = daysUntilEvent(dateStr, today);
    if (d === 0) return '今天';
    if (d === 1) return '明天';
    if (d > 1) return `${d} 天后`;
    return `已过期 ${Math.abs(d)} 天`;
  };

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-4 z-40 px-4 max-w-4xl mx-auto">
        <div className="glass-panel rounded-full px-4 py-3 flex items-center gap-3 ring-1 ring-black/5 dark:ring-white/10">
          <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </Button>
          <div>
            <h1 className="text-lg font-bold">近期待办</h1>
            <p className="text-xs text-slate-500">进入提醒窗口的事件（按「提前 N 天」配置自动出现）</p>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        <div className="glass-panel rounded-2xl p-4 text-sm text-slate-600 dark:text-slate-300 ring-1 ring-black/5 dark:ring-white/10">
          <p className="flex items-start gap-2">
            <CalendarClock className="w-4 h-4 shrink-0 mt-0.5 text-primary-500" />
            <span>
              与首页「本周待办」数字不同：这里列出<strong>已进入提醒周期</strong>的事件。
              例如提前 7 天提醒的生日，会在还剩 7 天时出现在此列表，直到当天结束。
            </span>
          </p>
        </div>

        {todos.length === 0 ? (
          <div className="text-center py-16 glass-panel rounded-3xl">
            <CheckCircle2 className="w-12 h-12 mx-auto text-slate-300 mb-3" />
            <p className="font-semibold text-slate-700 dark:text-slate-200">暂无待办</p>
            <p className="text-sm text-slate-500 mt-1">事件进入提醒窗口后会自动显示在这里</p>
            <Button className="mt-4 rounded-full" variant="outline" onClick={() => navigate('/calendar')}>
              打开日历
            </Button>
          </div>
        ) : (
          <section className="space-y-2">
            <h2 className="text-sm font-bold text-slate-500 px-1">共 {todos.length} 项</h2>
            {todos.map((e) => (
              <TodoRow key={e.id} event={e} dayLabel={dayLabel(e.date)} onOpen={() => navigate('/calendar')} />
            ))}
          </section>
        )}
      </main>
      <MobileBottomNav />
    </div>
  );
}

function TodoRow({
  event,
  dayLabel,
  onOpen,
}: {
  event: { id: string; name: string; date: string; type: string; reminderConfig?: { daysBeforeList?: number[] } };
  dayLabel: string;
  onOpen: () => void;
}) {
  const dateStr = event.date.slice(0, 10);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left glass-panel rounded-2xl px-4 py-3 flex justify-between items-center gap-3 hover:ring-2 hover:ring-primary-300/50 transition"
    >
      <div className="min-w-0">
        <p className="font-semibold truncate">{event.name}</p>
        <p className="text-xs text-slate-500 mt-0.5">
          {dateStr} · {eventTypeLabel(event.type)}
          {event.reminderConfig?.daysBeforeList?.length
            ? ` · 提前 ${[...event.reminderConfig.daysBeforeList].sort((a, b) => b - a).join('/')} 天提醒`
            : ''}
        </p>
      </div>
      <Badge variant={daysUntilEvent(event.date) === 0 ? 'default' : 'secondary'}>
        {dayLabel}
      </Badge>
    </button>
  );
}
