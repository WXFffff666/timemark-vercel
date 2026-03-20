import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { CalendarIcon, TrashIcon, EditIcon } from '../icons';
import { calculateCountdown } from '@/lib/countdown';
import { formatLunarDate, getNextLunarOccurrence } from '@/lib/lunar';
import type { Event } from '@timemark/shared';

interface EventCardProps {
  event: Event;
  onEdit: (event: Event) => void;
  onDelete: (id: string) => void;
}

export function EventCard({ event, onEdit, onDelete }: EventCardProps) {
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
      whileHover={{ y: -8 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
    >
      <Card onClick={() => onEdit(event)} className="group bg-white/80 backdrop-blur-sm shadow-card hover:shadow-card-hover rounded-card transition-shadow cursor-pointer">
        <CardHeader className="pb-3">
          <div className="flex justify-between items-start mb-2">
            <CardTitle className="text-lg font-semibold">{event.name}</CardTitle>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button variant="ghost" onClick={() => onEdit(event)} className="h-8 w-8 p-0">
                <EditIcon size={16} />
              </Button>
              <Button variant="ghost" onClick={() => onDelete(event.id)} className="h-8 w-8 p-0 text-destructive">
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
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center">
                <CalendarIcon size={16} />
              </div>
              <div className="flex flex-col">
                <span className="font-medium text-foreground">{targetDate.toLocaleDateString('zh-CN')}</span>
                {event.calendarType === 'lunar' && event.lunarDate && (
                  <span className="text-xs">{formatLunarDate(event.lunarDate)}</span>
                )}
              </div>
            </div>
            <div className="text-2xl font-semibold text-primary">
              {countdown.isPast ? '已过期' : `${countdown.days}天 ${countdown.hours}小时`}
            </div>
          </div>
        </CardContent>
        <div className="absolute inset-0 rounded-card opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-glow" />
      </Card>
    </motion.div>
  );
}
