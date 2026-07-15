import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { useEventStore } from '@/stores/event.store';
import type { Event } from '@timemark/shared';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function dateKey(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function Calendar() {
  const navigate = useNavigate();
  const { events, fetchEvents } = useEventStore();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  useEffect(() => {
    if (events.length === 0) fetchEvents();
  }, [events.length, fetchEvents]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of events) {
      const key = e.date.slice(0, 10);
      const list = map.get(key) || [];
      list.push(e);
      map.set(key, list);
    }
    return map;
  }, [events]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  const monthLabel = `${year}年${month + 1}月`;
  const todayKey = dateKey(new Date());

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-4 z-40 px-4 max-w-4xl mx-auto">
        <div className="glass-panel rounded-full px-4 py-3 flex items-center justify-between ring-1 ring-black/5 dark:ring-white/10">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}>
              <ArrowLeft size={20} />
            </Button>
            <h1 className="text-lg font-bold">日历视图</h1>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => setCursor(new Date(year, month - 1, 1))}>
              <ChevronLeft size={18} />
            </Button>
            <span className="text-sm font-semibold min-w-[7rem] text-center">{monthLabel}</span>
            <Button variant="ghost" size="icon" onClick={() => setCursor(new Date(year, month + 1, 1))}>
              <ChevronRight size={18} />
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="glass-panel rounded-3xl p-4 ring-1 ring-black/5 dark:ring-white/10">
          <div className="grid grid-cols-7 gap-1 mb-2 text-center text-xs font-semibold text-slate-500">
            {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((day, idx) => {
              if (!day) return <div key={`empty-${idx}`} className="min-h-[4.5rem]" />;
              const key = dateKey(day);
              const dayEvents = eventsByDate.get(key) || [];
              const isToday = key === todayKey;
              return (
                <div
                  key={key}
                  className={`min-h-[4.5rem] rounded-xl p-1.5 border text-xs ${
                    isToday
                      ? 'border-primary-500 bg-primary-50/80 dark:bg-primary-900/20'
                      : 'border-transparent bg-slate-50/50 dark:bg-slate-800/30'
                  }`}
                >
                  <div className={`font-bold mb-0.5 ${isToday ? 'text-primary-600' : ''}`}>{day.getDate()}</div>
                  {dayEvents.slice(0, 2).map((e) => (
                    <div key={e.id} className="truncate text-[10px] px-1 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-200">
                      {e.name}
                    </div>
                  ))}
                  {dayEvents.length > 2 && (
                    <div className="text-[10px] text-slate-400">+{dayEvents.length - 2}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <section className="mt-6 space-y-2">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider px-1">本月事件</h2>
          {events.filter((e) => e.date.startsWith(`${year}-${pad(month + 1)}`)).length === 0 ? (
            <p className="text-sm text-slate-500 px-1">本月暂无事件</p>
          ) : (
            events
              .filter((e) => e.date.startsWith(`${year}-${pad(month + 1)}`))
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((e) => (
                <div key={e.id} className="glass-panel rounded-2xl px-4 py-3 flex justify-between items-center">
                  <div>
                    <p className="font-semibold">{e.name}</p>
                    <p className="text-xs text-slate-500">{e.date.slice(0, 10)} · {e.type}</p>
                  </div>
                  <span className="text-xs text-slate-400">{e.calendarType}</span>
                </div>
              ))
          )}
        </section>
      </main>
      <MobileBottomNav />
    </div>
  );
}
