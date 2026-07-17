import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarClock, CheckCircle2, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { useEventStore } from '@/stores/event.store';
import { useTodoCompletions } from '@/hooks/useTodoCompletions';
import {
  daysUntilEvent,
  eventTypeLabel,
  getTodoEvents,
  isEventInTodoWindow,
  todoCompletionKey,
} from '@/lib/calendar-utils';
import type { Event } from '@timemark/shared';

export default function Todos() {
  const navigate = useNavigate();
  const { events, fetchEvents } = useEventStore();
  const { completedKeys, isCompleted, toggleComplete } = useTodoCompletions();

  useEffect(() => {
    if (events.length === 0) fetchEvents();
  }, [events.length, fetchEvents]);

  const allInWindow = useMemo(
    () => events.filter((e) => isEventInTodoWindow(e)),
    [events],
  );

  const pending = useMemo(() => getTodoEvents(events, new Date(), completedKeys), [events, completedKeys]);
  const completed = useMemo(
    () => allInWindow.filter((e) => completedKeys.has(todoCompletionKey(e.id, e.date))),
    [allInWindow, completedKeys],
  );

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
            <p className="text-xs text-slate-500">
              待办 {pending.length} · 已完成 {completed.length}
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        <div className="glass-panel rounded-2xl p-4 text-sm text-slate-600 dark:text-slate-300 ring-1 ring-black/5 dark:ring-white/10">
          <p className="flex items-start gap-2">
            <CalendarClock className="w-4 h-4 shrink-0 mt-0.5 text-primary-500" />
            <span>
              点击左侧圆圈<strong>打勾完成</strong>；完成后移入「已完成」，首页待办数字同步减少。
              进入提醒窗口的事件会自动出现在此列表。
            </span>
          </p>
        </div>

        {pending.length === 0 && completed.length === 0 ? (
          <div className="text-center py-16 glass-panel rounded-3xl">
            <CheckCircle2 className="w-12 h-12 mx-auto text-slate-300 mb-3" />
            <p className="font-semibold text-slate-700 dark:text-slate-200">暂无待办</p>
            <p className="text-sm text-slate-500 mt-1">事件进入提醒窗口后会自动显示在这里</p>
            <Button className="mt-4 rounded-full" variant="outline" onClick={() => navigate('/calendar')}>
              打开日历
            </Button>
          </div>
        ) : (
          <>
            {pending.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-bold text-slate-500 px-1">待处理 · {pending.length}</h2>
                {pending.map((e) => (
                  <TodoRow
                    key={e.id}
                    event={e}
                    dayLabel={dayLabel(e.date)}
                    completed={false}
                    onToggle={() => toggleComplete(e.id, e.date, isCompleted(e.id, e.date))}
                    onOpen={() => navigate('/calendar')}
                  />
                ))}
              </section>
            )}

            {completed.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-bold text-slate-400 px-1">已完成 · {completed.length}</h2>
                {completed.map((e) => (
                  <TodoRow
                    key={`done-${e.id}`}
                    event={e}
                    dayLabel={dayLabel(e.date)}
                    completed
                    onToggle={() => toggleComplete(e.id, e.date, true)}
                    onOpen={() => navigate('/calendar')}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </main>
      <MobileBottomNav />
    </div>
  );
}

function TodoRow({
  event,
  dayLabel,
  completed,
  onToggle,
  onOpen,
}: {
  event: Event;
  dayLabel: string;
  completed: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const dateStr = event.date.slice(0, 10);
  return (
    <div
      className={`glass-panel rounded-2xl px-3 py-3 flex items-center gap-3 transition ${
        completed ? 'opacity-60' : ''
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className={`shrink-0 p-1 rounded-full transition ${
          completed
            ? 'text-green-600 hover:text-green-700'
            : 'text-slate-400 hover:text-primary-500'
        }`}
        aria-label={completed ? '取消完成' : '标记完成'}
      >
        {completed ? <CheckCircle2 size={22} /> : <Circle size={22} />}
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="flex-1 min-w-0 text-left flex justify-between items-center gap-3 hover:opacity-80"
      >
        <div className="min-w-0">
          <p className={`font-semibold truncate ${completed ? 'line-through text-slate-500' : ''}`}>
            {event.name}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">
            {dateStr} · {eventTypeLabel(event.type)}
            {event.reminderConfig?.daysBeforeList?.length
              ? ` · 提前 ${[...event.reminderConfig.daysBeforeList].sort((a, b) => b - a).join('/')} 天`
              : ''}
          </p>
        </div>
        <Badge variant={completed ? 'outline' : daysUntilEvent(event.date) === 0 ? 'default' : 'secondary'}>
          {completed ? '已完成' : dayLabel}
        </Badge>
      </button>
    </div>
  );
}
