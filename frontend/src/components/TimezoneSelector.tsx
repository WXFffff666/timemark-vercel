import { useTimezone } from './RealtimeClock';
import { QUICK_TIMEZONE_OPTIONS } from '@/lib/timezone-utils';
import { Globe, ChevronDown } from 'lucide-react';

export function TimezoneSelector() {
  const { timezone, setTimezone } = useTimezone();

  return (
    <div className="relative group flex items-center">
      <Globe className="absolute left-3 w-4 h-4 text-slate-400 group-hover:text-primary-500 transition-colors pointer-events-none z-10" />
      <select
        value={timezone}
        onChange={(e) => {
          void setTimezone(e.target.value);
        }}
        className="appearance-none bg-white/40 dark:bg-black/30 hover:bg-white/60 dark:hover:bg-black/50 text-sm font-semibold text-slate-700 dark:text-slate-300 pl-9 pr-8 py-2 rounded-xl border border-white/20 dark:border-white/5 shadow-inner backdrop-blur-md transition-all duration-300 cursor-pointer outline-none focus:ring-2 focus:ring-primary-500/50 active:scale-95"
        aria-label="系统时区"
      >
        {QUICK_TIMEZONE_OPTIONS.map((tz) => (
          <option key={tz.value} value={tz.value}>
            {tz.label}
          </option>
        ))}
      </select>
      <div className="absolute right-3 pointer-events-none">
        <ChevronDown className="w-4 h-4 text-slate-400 group-hover:text-primary-500 transition-colors" />
      </div>
    </div>
  );
}
