import { useEffect, useMemo, useState, createContext, useContext } from 'react';
import { Lunar, Solar } from 'lunar-javascript';

// 时区上下文
interface TimezoneContextType {
  timezone: string;
  setTimezone: (tz: string) => void;
}

const TimezoneContext = createContext<TimezoneContextType>({
  timezone: 'Asia/Shanghai',
  setTimezone: () => {},
});

export const useTimezone = () => useContext(TimezoneContext);

// 可选的时区列表
export const TIMEZONES = [
  { value: 'Asia/Shanghai', label: '北京时间 (UTC+8)' },
  { value: 'Asia/Hong_Kong', label: '香港时间 (UTC+8)' },
  { value: 'Asia/Taipei', label: '台北时间 (UTC+8)' },
  { value: 'Asia/Singapore', label: '新加坡时间 (UTC+8)' },
  { value: 'Asia/Tokyo', label: '东京时间 (UTC+9)' },
  { value: 'Asia/Seoul', label: '首尔时间 (UTC+9)' },
  { value: 'America/New_York', label: '纽约时间 (UTC-5)' },
  { value: 'America/Los_Angeles', label: '洛杉矶时间 (UTC-8)' },
  { value: 'Europe/London', label: '伦敦时间 (UTC+0)' },
  { value: 'Europe/Paris', label: '巴黎时间 (UTC+1)' },
];

function getFestivalLabel(date: Date): string {
  const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const solarFestivals = solar.getFestivals() || [];
  if (solarFestivals.length > 0) {
    return solarFestivals.join(' / ');
  }

  const lunar = Lunar.fromDate(date);
  const lunarFestivals = lunar.getFestivals() || [];
  if (lunarFestivals.length > 0) {
    return lunarFestivals.join(' / ');
  }

  return '无';
}

function formatTime(now: Date, timezone: string) {
  try {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));

    return {
      date: `${map.year}-${map.month}-${map.day}`,
      weekday: map.weekday,
      time: `${map.hour}:${map.minute}:${map.second}`,
      festival: getFestivalLabel(new Date(Number(map.year), Number(map.month) - 1, Number(map.day))),
      timezoneLabel: TIMEZONES.find(tz => tz.value === timezone)?.label || timezone,
    };
  } catch (error) {
    // 如果时区无效，回退到系统默认
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));

    return {
      date: `${map.year}-${map.month}-${map.day}`,
      weekday: map.weekday,
      time: `${map.hour}:${map.minute}:${map.second}`,
      festival: '无',
      timezoneLabel: '系统默认',
    };
  }
}

export function TimezoneProvider({ children }: { children: React.ReactNode }) {
  const [timezone, setTimezoneState] = useState<string>(() => {
    // 从 localStorage 读取或默认北京时间
    return localStorage.getItem('timemark_timezone') || 'Asia/Shanghai';
  });

  const setTimezone = (tz: string) => {
    localStorage.setItem('timemark_timezone', tz);
    setTimezoneState(tz);
  };

  return (
    <TimezoneContext.Provider value={{ timezone, setTimezone }}>
      {children}
    </TimezoneContext.Provider>
  );
}

export function RealtimeClock() {
  const { timezone } = useTimezone();
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const display = useMemo(() => formatTime(now, timezone), [now, timezone]);

  return (
    <div className="text-right hidden md:block">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {display.date} {display.weekday} · {display.festival}
      </p>
      <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
        {display.time}
      </p>
    </div>
  );
}
