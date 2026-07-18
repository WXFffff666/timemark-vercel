import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  diffToCountdownParts,
  getEventCountdownTarget,
  resolveNextOccurrenceDate,
} from '@/lib/calendar-utils';

export default function CountdownWidget() {
  const { token } = useParams();
  const [event, setEvent] = useState<{ name: string; date: string; type: string; reminderConfig?: { reminderTimes?: string[] } } | null>(null);
  const [parts, setParts] = useState<{ days: number; hours: number } | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/features/share/${token}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setEvent(d.data); })
      .catch(() => setEvent(null));
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

  if (!event) {
    return <div className="min-h-screen flex items-center justify-center text-slate-500">加载中…</div>;
  }

  const nextDate = resolveNextOccurrenceDate({
    date: event.date,
    type: event.type as 'birthday',
  } as Parameters<typeof resolveNextOccurrenceDate>[0]);
  const days = parts?.days ?? 0;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-700 text-white p-6">
      <div className="text-center">
        <div className="text-6xl font-bold mb-2">{days <= 0 && !parts ? '今天' : days}</div>
        <div className="text-xl opacity-90">{days <= 0 && !parts ? '' : '天后'}</div>
        <h1 className="text-2xl font-semibold mt-6">{event.name}</h1>
        <p className="opacity-80 mt-2">{nextDate}</p>
      </div>
    </div>
  );
}
