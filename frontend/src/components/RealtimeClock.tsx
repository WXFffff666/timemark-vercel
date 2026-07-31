import { useState, useEffect, type ReactNode } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { useTimezoneStore } from '@/stores/timezone.store';

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
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formattedTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(time);

  return (
    <div className="flex items-center justify-center px-3 py-1 bg-white/40 dark:bg-black/30 rounded-xl border border-white/20 dark:border-white/5 shadow-inner backdrop-blur-md">
      <span className="font-mono text-lg font-extrabold tracking-wider bg-clip-text text-transparent bg-gradient-to-b from-primary-500 to-purple-600 dark:from-primary-400 dark:to-purple-400 tabular-nums drop-shadow-sm">
        {formattedTime}
      </span>
    </div>
  );
}
