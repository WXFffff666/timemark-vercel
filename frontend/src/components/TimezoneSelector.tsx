import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from './ui/button';
import { useTimezone, TIMEZONES } from '../RealtimeClock';
import { Globe, X } from 'lucide-react';

export function TimezoneSelector() {
  const { timezone, setTimezone } = useTimezone();
  const [isOpen, setIsOpen] = useState(false);

  const currentTz = TIMEZONES.find(tz => tz.value === timezone);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400"
      >
        <Globe size={14} />
        <span className="hidden sm:inline">{currentTz?.label.split(' ')[0] || '时区'}</span>
      </Button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute right-0 top-full mt-2 w-64 glass rounded-lg shadow-lg z-50 overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
              <span className="text-sm font-medium">选择时区</span>
              <button onClick={() => setIsOpen(false)} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded">
                <X size={14} />
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto py-2">
              {TIMEZONES.map((tz) => (
                <button
                  key={tz.value}
                  onClick={() => {
                    setTimezone(tz.value);
                    setIsOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${
                    timezone === tz.value 
                      ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400' 
                      : 'text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {tz.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
