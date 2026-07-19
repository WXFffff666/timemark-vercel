import { motion } from 'framer-motion';
import { Clock, Calendar, Edit2, Trash2, Send, CheckCircle2, Circle, Heart, GraduationCap, PartyPopper, Sparkles, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useEffect, useState } from 'react';
import type { Event, EventType } from '@timemark/shared';
import {
  diffToCountdownParts,
  getEventCountdownTarget,
  isEventCountdownPast,
  resolveNextOccurrenceDate,
} from '@/lib/calendar-utils';

interface EventCardProps {
  event: Event;
  onEdit: (e: Event) => void;
  onDelete: (id: string) => void;
  onTestSend?: (id: string) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelectToggle?: (id: string, c: boolean) => void;
}

// Helper to safely parse dates (append T00:00:00 to ensure local timezone interpretation)
const safeParseDate = (dateString: string | undefined): Date | null => {
  if (!dateString) return null;
  const ymd = dateString.slice(0, 10);
  const date = new Date(`${ymd}T00:00:00`);
  return isNaN(date.getTime()) ? null : date;
};

const getEventTypeIcon = (type: EventType) => {
  switch (type) {
    case 'birthday':
      return <Heart size={18} />;
    case 'exam':
      return <GraduationCap size={18} />;
    case 'anniversary':
      return <Heart size={18} />;
    case 'holiday':
      return <PartyPopper size={18} />;
    default:
      return <Sparkles size={18} />;
  }
};

const getEventTypeColor = (type: EventType): string => {
  switch (type) {
    case 'birthday':
      return 'bg-pink-500';
    case 'exam':
      return 'bg-blue-500';
    case 'anniversary':
      return 'bg-rose-500';
    case 'holiday':
      return 'bg-yellow-500';
    default:
      return 'bg-purple-500';
  }
};

const getEventTypeLabel = (type: EventType): string => {
  const labels: Record<string, string> = {
    birthday: '生日',
    exam: '考试',
    anniversary: '纪念日',
    holiday: '节日',
    meeting: '会议',
    deadline: '截止日期',
    travel: '旅行',
    graduation: '毕业',
    wedding: '婚礼',
    medical: '医疗',
    other: '其他',
  };
  return labels[type] || '其他';
};

export function EventCard({ event, onEdit, onDelete, onTestSend, selectable, selected, onSelectToggle }: EventCardProps) {
  const [timeLeft, setTimeLeft] = useState<{ days: number; hours: number; minutes: number; seconds: number } | null>(null);
  const [isPast, setIsPast] = useState(false);

  const nextOccurrenceDate = resolveNextOccurrenceDate(event);
  const targetDate = safeParseDate(nextOccurrenceDate);
  const formattedDate = targetDate ? targetDate.toLocaleDateString('zh-CN') : '无效日期';
  const displayDate = formattedDate;

  useEffect(() => {
    const calculateTimeLeft = () => {
      const target = getEventCountdownTarget(event);
      if (!target) {
        setTimeLeft(null);
        setIsPast(true);
        return;
      }

      if (isEventCountdownPast(event)) {
        setTimeLeft(null);
        setIsPast(true);
        return;
      }

      const parts = diffToCountdownParts(target);
      if (parts) {
        setTimeLeft(parts);
        setIsPast(false);
      } else {
        setTimeLeft(null);
        setIsPast(true);
      }
    };
    calculateTimeLeft();
    const timer = setInterval(calculateTimeLeft, 1000);
    return () => clearInterval(timer);
  }, [event.date, event.nextOccurrence, event.type, event.recurringConfig, event.reminderConfig]);

  return (
    <div className={`relative group glass-panel rounded-[2.5rem] p-6 overflow-hidden h-full ${selected ? 'ring-2 ring-primary-500 shadow-xl shadow-primary-500/20' : 'ring-1 ring-black/5 dark:ring-white/10'}`} onClick={() => selectable && onSelectToggle && onSelectToggle(event.id, !selected)}>
      <div className="absolute -right-16 -bottom-16 w-48 h-48 bg-gradient-to-br from-primary-500/20 to-purple-500/20 rounded-full blur-3xl group-hover:scale-150 transition-transform duration-700 pointer-events-none"></div>
      
      {/* Header with event type */}
      <div className="flex justify-between items-start mb-4 relative z-10">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            {selectable && (
              <motion.div initial={false} animate={{ scale: selected ? 1.1 : 1 }} className="cursor-pointer">
                {selected ? <CheckCircle2 className="text-primary-500 drop-shadow-md" size={24} /> : <Circle className="text-slate-400 dark:text-slate-500" size={24} />}
              </motion.div>
            )}
            <div className={`w-8 h-8 rounded-xl ${getEventTypeColor(event.type)} flex items-center justify-center text-white shadow-md`}>
              {getEventTypeIcon(event.type)}
            </div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight line-clamp-1">{event.name}</h3>
          </div>
          <div className="flex items-center gap-2 mt-2 text-sm text-slate-500 dark:text-slate-400 font-medium">
            <Calendar size={14} /> 
            <span>{displayDate}</span>
            <Badge variant="secondary" className="px-2 py-0.5 text-[10px]">{event.calendarType === 'lunar' ? '农历' : event.calendarType === 'both' ? '双历' : '公历'}</Badge>
          </div>
        </div>
      </div>
      
      {/* Person name if exists */}
      {event.personName && (
        <div className="text-sm text-slate-600 dark:text-slate-400 mb-4 flex items-center gap-2 relative z-10">
          <CalendarDays size={14} className="text-primary-500" />
          <span>关联: {event.personName}</span>
        </div>
      )}
      
      {/* Custom message */}
      {event.reminderConfig?.customMessage && (
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-4 line-clamp-2 relative z-10">{event.reminderConfig.customMessage}</p>
      )}
      
      {/* Countdown or past indicator */}
      <div className="mb-4 relative z-10">
        {isPast ? (
          <div className="flex items-center justify-center py-4 bg-red-50/80 dark:bg-red-900/20 rounded-2xl border border-red-100 dark:border-red-500/20 backdrop-blur-sm">
            <span className="text-lg font-bold text-red-600 dark:text-red-400 flex items-center gap-2"><Clock size={20} /> 目标时间已过</span>
          </div>
        ) : timeLeft ? (
          <div className="grid grid-cols-4 gap-2">
            {[{ l: '天', v: timeLeft.days }, { l: '时', v: timeLeft.hours }, { l: '分', v: timeLeft.minutes }, { l: '秒', v: timeLeft.seconds }].map((item, idx) => (
              <div key={idx} className="flex flex-col items-center justify-center py-3 px-1 rounded-[1.25rem] bg-white/60 dark:bg-black/30 shadow-[inset_0_2px_4px_rgba(255,255,255,0.4)] dark:shadow-inner border border-white/80 dark:border-white/5">
                <span className="text-2xl font-bold text-slate-800 dark:text-white tabular-nums tracking-tighter">{item.v.toString().padStart(2, '0')}</span>
                <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 mt-1 uppercase">{item.l}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      
      {/* Reminder status */}
      {event.reminderConfig?.enabled && (
        <div className="mb-4 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2 relative z-10">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
          <span>已启用提醒</span>
          {event.reminderConfig.daysBeforeList && event.reminderConfig.daysBeforeList.length > 0 && (
            <span className="text-slate-400">• 提前 {event.reminderConfig.daysBeforeList.join(', ')} 天</span>
          )}
        </div>
      )}

      {/* Reminder times */}
      {event.reminderConfig?.reminderTimes && event.reminderConfig.reminderTimes.length > 0 && (
        <div className="mb-4 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2 relative z-10">
          <Clock size={12} />
          <span>提醒时间: {event.reminderConfig.reminderTimes.join(', ')}</span>
        </div>
      )}

      {!selectable && (
        <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-200/60 dark:border-slate-700/50 relative z-10">
          {onTestSend && (
            <Button variant="ghost" size="sm" className="h-9 px-3 hover:bg-primary-50 dark:hover:bg-primary-900/30 text-slate-600 hover:text-primary-600 dark:text-slate-300 rounded-xl" onClick={(e) => { e.stopPropagation(); onTestSend(event.id); }}><Send size={14} className="mr-1.5" /> 测试</Button>
          )}
          <Button variant="ghost" size="sm" className="h-9 px-3 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-slate-600 hover:text-blue-600 dark:text-slate-300 rounded-xl" onClick={(e) => { e.stopPropagation(); onEdit(event); }}><Edit2 size={14} className="mr-1.5" /> 编辑</Button>
          <Button variant="ghost" size="sm" className="h-9 px-3 hover:bg-red-50 dark:hover:bg-red-900/30 text-slate-600 hover:text-red-600 dark:text-slate-300 rounded-xl" onClick={(e) => { e.stopPropagation(); onDelete(event.id); }}><Trash2 size={14} className="mr-1.5" /> 删除</Button>
        </div>
      )}
    </div>
  );
}