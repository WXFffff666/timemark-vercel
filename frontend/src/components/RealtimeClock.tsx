import { useEffect, useMemo, useState } from 'react';
import { Lunar, Solar } from 'lunar-javascript';

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

function formatBeijingTime(now: Date) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
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
  };
}

export function RealtimeClock() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const display = useMemo(() => formatBeijingTime(now), [now]);

  return (
    <div className="text-right hidden md:block">
      <p className="text-xs text-gray-500 dark:text-gray-400">{display.date} {display.weekday} · {display.festival}</p>
      <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{display.time}</p>
    </div>
  );
}
