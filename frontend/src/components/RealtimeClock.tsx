import { useState, useEffect, type ReactNode } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { useTimezoneStore } from '@/stores/timezone.store';
import { getSyncedClientNow } from '@/lib/time-sync';

const timeFormatterCache = new Map<string, Intl.DateTimeFormat>();
function getTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = timeFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    timeFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}


export function TimezoneProvider({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const load = useTimezoneStore((s) => s.load);

  useEffect(() => {
    if (isAuthenticated) {
      void load();
    }
  }, [isAuthenticated, load]);

  return <>{children}</>;
}

export function useTimezone() {
  const timezone = useTimezoneStore((s) => s.timezone);
  const setTimezone = useTimezoneStore((s) => s.setTimezone);
  return { timezone, setTimezone };
}

export function RealtimeClock() {
  const [time, setTime] = useState(new Date());
  const { timezone } = useTimezone();

  useEffect(() => {
    const timer = setInterval(() => setTime(getSyncedClientNow()), 1000);
    return () => clearInterval(timer);
  }, []);

  // v2.27 B-2：formatter 按 timezone 缓存（模块级 Map）——此前每秒重建一个
  // Intl.DateTimeFormat，构造成本高且 timezone 不变。
  const formattedTime = getTimeFormatter(timezone).format(time);

  return (
    <div className="flex items-center justify-center px-3 py-1 bg-white/40 dark:bg-black/30 rounded-xl border border-white/20 dark:border-white/5 shadow-inner backdrop-blur-md">
      <span className="font-mono text-lg font-extrabold tracking-wider bg-clip-text text-transparent bg-gradient-to-b from-primary-500 to-purple-600 dark:from-primary-400 dark:to-purple-400 tabular-nums drop-shadow-xs">
        {formattedTime}
      </span>
    </div>
  );
}
