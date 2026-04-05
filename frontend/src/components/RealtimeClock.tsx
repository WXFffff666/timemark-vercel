import { useState, useEffect, createContext, useContext, ReactNode } from 'react';

interface TimezoneContextType { timezone: string; setTimezone: (tz: string) => void; }
const TimezoneContext = createContext<TimezoneContextType>({ timezone: 'Asia/Shanghai', setTimezone: () => {} });

export function TimezoneProvider({ children }: { children: ReactNode }) {
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  return <TimezoneContext.Provider value={{ timezone, setTimezone }}>{children}</TimezoneContext.Provider>;
}

export const useTimezone = () => useContext(TimezoneContext);

export function RealtimeClock() {
  const [time, setTime] = useState(new Date());
  const { timezone } = useTimezone();

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  },[]);

  const formattedTime = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time);

  return (
    <div className="flex items-center justify-center px-3 py-1 bg-white/40 dark:bg-black/30 rounded-xl border border-white/20 dark:border-white/5 shadow-inner backdrop-blur-md">
      <span className="font-mono text-lg font-extrabold tracking-wider bg-clip-text text-transparent bg-gradient-to-b from-primary-500 to-purple-600 dark:from-primary-400 dark:to-purple-400 tabular-nums drop-shadow-sm">
        {formattedTime}
      </span>
    </div>
  );
}
