import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { CalendarIcon, TrashIcon, EditIcon, SendIcon } from '../icons';
import { calculateCountdown } from '@/lib/countdown';
import { formatLunarDate, getNextLunarOccurrence } from '@/lib/lunar';
import type { Event } from '@timemark/shared';

interface EventCardProps {
  event: Event;
  onEdit: (event: Event) => void;
  onDelete: (id: string) => void;
  onTestSend?: (id: string) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelectToggle?: (id: string, selected: boolean) => void;
}

export function EventCard({ event, onEdit, onDelete, onTestSend, selectable = false, selected = false, onSelectToggle }: EventCardProps) {
  const getTargetDate = () => {
    if (event.calendarType === 'lunar' && event.lunarDate) {
      return getNextLunarOccurrence(event.lunarDate);
    }
    // Parse date as UTC to avoid timezone issues
    const [year, month, day] = event.date.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  };
  
  const targetDate = getTargetDate();
  const [countdown, setCountdown] = useState(calculateCountdown(targetDate));

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(calculateCountdown(getTargetDate()));
    }, 60000);
    return () => clearInterval(timer);
  }, [event.date, event.calendarType, event.lunarDate]);

  const getTypeColor = (type: string) => {
    const colors = {
      birthday: 'bg-pink-500 text-white',
      exam: 'bg-blue-500 text-white',
      anniversary: 'bg-purple-500 text-white',
      holiday: 'bg-green-500 text-white',
      other: 'bg-gray-500 text-white',
    };
    return colors[type as keyof typeof colors] || colors.other;
  };

  return (
    <motion.div
      whileHover={{ y: -4, scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      style={{ willChange: 'transform' }}
    >
      <Card onClick={() => onEdit(event)} className="group glass rounded-2xl shadow-lg hover:shadow-2xl transition-all duration-300 cursor-pointer overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex justify-between items-start mb-2">
            <div className="flex items-center gap-2">
              {selectable && (
                <input
                  type="checkbox"
                  checked={selected}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onSelectToggle?.(event.id, e.target.checked)}
                  className="h-4 w-4"
                />
              )}
              <CardTitle className="text-lg font-semibold text-gray-900 dark:text-gray-100">{event.name}</CardTitle>
            </div>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {onTestSend && (
                <Button variant="ghost" onClick={(e) => { e.stopPropagation(); onTestSend(event.id); }} className="h-8 w-8 p-0 text-blue-500 hover:text-blue-600" title="测试发送">
                  <SendIcon size={16} />
                </Button>
              )}
              <Button variant="ghost" onClick={(e) => { e.stopPropagation(); onEdit(event); }} className="h-8 w-8 p-0">
                <EditIcon size={16} />
              </Button>
              <Button variant="ghost" onClick={(e) => { e.stopPropagation(); onDelete(event.id); }} className="h-8 w-8 p-0 text-red-500 hover:text-red-600">
                <TrashIcon size={16} />
              </Button>
            </div>
          </div>
          <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${getTypeColor(event.type)}`}>
            {event.type}
          </span>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <div className="w-8 h-8 rounded-lg bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                <CalendarIcon size={16} className="text-primary-600 dark:text-primary-400" />
              </div>
              <div className="flex flex-col">
                <span className="font-medium text-gray-900 dark:text-gray-100">{targetDate.toLocaleDateString('zh-CN')}</span>
                {event.calendarType === 'lunar' && event.lunarDate && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">{formatLunarDate(event.lunarDate)}</span>
                )}
              </div>
            </div>
            <div className="text-2xl font-semibold text-primary-600 dark:text-primary-400">
              {countdown.isPast ? '已过期' : `${countdown.days}天 ${countdown.hours}小时`}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
