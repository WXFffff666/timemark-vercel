import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  daysUntilEvent,
  resolveNextOccurrenceDate,
} from '@/lib/calendar-utils';
import {
  applyEventOgMeta,
  clearEventOgMeta,
  eventTypeLabel,
  formatCountdownDays,
} from '@/lib/og-meta';

interface ShareData {
  name: string;
  type: string;
  date: string;
  calendar_type: string;
  person_name?: string | null;
}

/** Days until the next occurrence, mirroring the embed widget's rolling logic. */
function countdownDays(data: ShareData): number {
  const next = resolveNextOccurrenceDate({
    date: data.date,
    type: data.type,
    calendarType: (data.calendar_type as 'gregorian') ?? 'gregorian',
    nextOccurrence: null,
  } as Parameters<typeof resolveNextOccurrenceDate>[0]);
  return daysUntilEvent(next);
}

export default function ShareEvent() {
  const { token } = useParams();
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    let active = true;
    fetch(`/api/features/share/${token}`)
      .then((r) => r.json())
      .then((json) => {
        if (!active) return;
        if (json.success) setData(json.data as ShareData);
        else setError(json.error || '无法加载');
      })
      .catch(() => {
        if (active) setError('加载失败');
      });
    return () => {
      active = false;
    };
  }, [token]);

  // Client-injected OG/Twitter tags. Crawler-readable tags are served by `/api/og/share/:token`
  // (see the evidence file); this keeps the JS-rendered page accurate for social scrapers that
  // do execute scripts and for view-source inspection.
  useEffect(() => {
    if (!data || !token) return;
    const days = countdownDays(data);
    applyEventOgMeta({
      name: data.name,
      description: `${formatCountdownDays(days)} · ${eventTypeLabel(data.type)}`,
      imageUrl: `${window.location.origin}/api/og/image/${token}`,
      url: `${window.location.origin}/share/${token}`,
    });
    return () => clearEventOgMeta();
  }, [data, token]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="glass-panel w-full max-w-md rounded-[2.5rem] p-10 text-center" data-testid="share-event-error">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-500/10 text-xl font-extrabold text-slate-500 dark:text-slate-300">
            !
          </span>
          <p className="text-slate-700 dark:text-slate-200">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="min-h-screen flex items-center justify-center text-hint">加载中…</div>;
  }

  const days = countdownDays(data);
  const isToday = days === 0;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <article
        className="glass-panel w-full max-w-md rounded-[2.5rem] p-8 shadow-xl animate-fade-in"
        data-testid="share-event-card"
      >
        <header className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-lg font-extrabold text-white shadow-lg">
            T
          </span>
          <div>
            <p className="text-sm font-bold text-slate-900 dark:text-white">TimeMark</p>
            <p className="text-xs text-hint">事件分享</p>
          </div>
        </header>

        <span className="inline-flex rounded-full bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-600 dark:bg-indigo-400/15 dark:text-indigo-300">
          {eventTypeLabel(data.type)}
        </span>

        <h1 className="mt-4 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 dark:text-white">
          {data.name}
        </h1>

        <p
          className={
            isToday
              ? 'mt-6 text-4xl font-extrabold text-indigo-600 dark:text-indigo-400'
              : 'mt-6 text-5xl font-extrabold text-indigo-600 dark:text-indigo-400'
          }
          data-testid="share-countdown"
        >
          {formatCountdownDays(days)}
        </p>

        <p className="mt-3 text-sm text-hint">{data.date}</p>
        {data.person_name && <p className="mt-1 text-sm text-hint">相关人：{data.person_name}</p>}

        <div className="mt-8 border-t border-slate-200/70 pt-4 dark:border-white/10">
          <p className="text-xs text-hint">由 TimeMark 智能事件提醒生成</p>
        </div>
      </article>
    </div>
  );
}
