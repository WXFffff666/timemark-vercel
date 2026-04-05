import { useTimezone } from './RealtimeClock';
import { Globe, ChevronDown } from 'lucide-react';

export function TimezoneSelector() {
  const { timezone, setTimezone } = useTimezone();
  return (
    <div className="relative group flex items-center">
      <Globe className="absolute left-3 w-4 h-4 text-gray-400 group-hover:text-primary-500 transition-colors pointer-events-none z-10" />
      <select
        value={timezone}
        onChange={(e) => setTimezone(e.target.value)}
        className="appearance-none bg-white/40 dark:bg-black/30 hover:bg-white/60 dark:hover:bg-black/50 text-sm font-semibold text-gray-700 dark:text-gray-300 pl-9 pr-8 py-2 rounded-xl border border-white/20 dark:border-white/5 shadow-inner backdrop-blur-md transition-all duration-300 cursor-pointer outline-none focus:ring-2 focus:ring-primary-500/50 active:scale-95"
      >
        <option value="Asia/Shanghai">北京时间 (UTC+8)</option>
        <option value="UTC">世界标准时间 (UTC)</option>
        <option value="America/New_York">纽约时间 (EST)</option>
        <option value="Europe/London">伦敦时间 (GMT)</option>
        <option value="Asia/Tokyo">东京时间 (UTC+9)</option>
      </select>
      <div className="absolute right-3 pointer-events-none">
        <ChevronDown className="w-4 h-4 text-gray-400 group-hover:text-primary-500 transition-colors" />
      </div>
    </div>
  );
}
