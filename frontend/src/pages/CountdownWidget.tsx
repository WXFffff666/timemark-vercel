import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  daysUntilEvent,
  diffToCountdownParts,
  getEventCountdownTarget,
  resolveNextOccurrenceDate,
} from '@/lib/calendar-utils';
import {
  applyEventOgMeta,
  clearEventOgMeta,
  eventTypeLabel,
  formatCountdownDays,
} from '@/lib/og-meta';

interface WidgetEvent {
  name: string;
  date: string;
  type: string;
  reminderConfig?: { reminderTimes?: string[] };
}

export default function CountdownWidget() {
  const { token } = useParams();
  const [event, setEvent] = useState<WidgetEvent | null>(null);
  const [parts, setParts] = useState<{ days: number; hours: number } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    fetch(`/api/features/share/${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        if (d.success) setEvent(d.data as WidgetEvent);
        else setError(true);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (!event) return;
    const tick = () => {
      const target = getEventCountdownTarget({
        date: event.date,
        type: event.type as 'birthday',
        reminderConfig: event.reminderConfig,
      } as Parameters<typeof getEventCountdownTarget>[0]);
      const p = target ? diffToCountdownParts(target) : null;
      setParts(p ? { days: p.days, hours: p.hours } : null);
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [event]);

  // Client-injected OG/Twitter tags for the embeddable widget (see ShareEvent for the rationale).
  useEffect(() => {
    if (!event || !token) return;
    const next = resolveNextOccurrenceDate({
      date: event.date,
      type: event.type,
      nextOccurrence: null,
    } as Parameters<typeof resolveNextOccurrenceDate>[0]);
    const days = daysUntilEvent(next);
    applyEventOgMeta({
      name: event.name,
      description: `${formatCountdownDays(days)} · ${eventTypeLabel(event.type)}`,
      imageUrl: `${window.location.origin}/api/og/image/${token}`,
      url: `${window.location.origin}/embed/${token}`,
    });
    return () => clearEventOgMeta();
  }, [event, token]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-700 p-6 text-white">
        <p className="rounded-3xl border border-white/20 bg-white/10 px-6 py-4 text-sm backdrop-blur-3xl" data-testid="embed-error">
          链接无效或已失效
        </p>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-700 text-white/80">
        加载中…
      </div>
    );
  }

  const nextDate = resolveNextOccurrenceDate({
    date: event.date,
    type: event.type as 'birthday',
  } as Parameters<typeof resolveNextOccurrenceDate>[0]);
  const days = parts?.days ?? 0;
  const isToday = days <= 0 && !parts;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-700 p-6 text-white">
      <div
        className="w-full max-w-sm rounded-[2.5rem] border border-white/20 bg-white/10 p-8 text-center shadow-2xl backdrop-blur-3xl animate-fade-in"
        data-testid="countdown-widget"
      >
        <header className="mb-6 flex items-center justify-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20 text-sm font-extrabold">T</span>
          <span className="text-sm font-bold tracking-wide">TimeMark</span>
        </header>

        <span className="inline-flex rounded-full bg-white/15 px-3 py-1 text-xs font-semibold">
          {eventTypeLabel(event.type)}
        </span>

        <div className="mt-5" data-testid="embed-countdown">
          <span className="text-6xl font-extrabold">{isToday ? '今天' : days}</span>
          {!isToday && <span className="ml-1 text-xl opacity-90">天后</span>}
        </div>

        <h1 className="mt-6 text-2xl font-semibold leading-snug">{event.name}</h1>
        <p className="mt-2 text-sm opacity-80">{nextDate}</p>
      </div>
    </div>
  );
}
