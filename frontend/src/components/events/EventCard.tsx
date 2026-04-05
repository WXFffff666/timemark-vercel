import { motion } from 'framer-motion';
import { Clock, Calendar, Edit2, Trash2, Send, CheckCircle2, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useEffect, useState } from 'react';

interface Event { id: string; title: string; targetTime: string; description?: string; timezone?: string; status?: string; }
interface EventCardProps { event: Event; onEdit: (e: Event) => void; onDelete: (id: string) => void; onTestSend: (id: string) => void; selectable?: boolean; selected?: boolean; onSelectToggle?: (id: string, c: boolean) => void; }

export function EventCard({ event, onEdit, onDelete, onTestSend, selectable, selected, onSelectToggle }: EventCardProps) {
  const [timeLeft, setTimeLeft] = useState<{ days: number; hours: number; minutes: number; seconds: number } | null>(null);
  const [isPast, setIsPast] = useState(false);

  useEffect(() => {
    const calculateTimeLeft = () => {
      const difference = new Date(event.targetTime).getTime() - new Date().getTime();
      if (difference > 0) {
        setTimeLeft({
          days: Math.floor(difference / (1000 * 60 * 60 * 24)),
          hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
          minutes: Math.floor((difference / 1000 / 60) % 60),
          seconds: Math.floor((difference / 1000) % 60),
        });
        setIsPast(false);
      } else {
        setTimeLeft(null);
        setIsPast(true);
      }
    };
    calculateTimeLeft();
    const timer = setInterval(calculateTimeLeft, 1000);
    return () => clearInterval(timer);
  }, [event.targetTime]);

  return (
    <div className={`relative group glass-panel rounded-3xl p-6 transition-all duration-300 overflow-hidden ${selected ? 'ring-2 ring-primary-500 shadow-xl shadow-primary-500/20' : 'ring-1 ring-white/20 dark:ring-white/10 hover:shadow-2xl hover:border-white/40'}`} onClick={() => selectable && onSelectToggle && onSelectToggle(event.id, !selected)}>
      <div className="absolute -right-16 -bottom-16 w-48 h-48 bg-gradient-to-br from-primary-500/20 to-purple-500/20 rounded-full blur-3xl group-hover:scale-150 transition-transform duration-700 pointer-events-none"></div>
      <div className="flex justify-between items-start mb-4 relative z-10">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            {selectable && (
              <motion.div initial={false} animate={{ scale: selected ? 1.1 : 1 }} className="cursor-pointer">
                {selected ? <CheckCircle2 className="text-primary-500 drop-shadow-md" size={24} /> : <Circle className="text-slate-400 dark:text-slate-500" size={24} />}
              </motion.div>
            )}
            <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight line-clamp-1">{event.title}</h3>
          </div>
          <div className="flex items-center gap-2 mt-2 text-sm text-slate-500 dark:text-slate-400 font-medium">
            <Calendar size={14} /> <span>{new Date(event.targetTime).toLocaleString()}</span>
            {event.timezone && <Badge variant="secondary" className="px-2 py-0.5 text-[10px]">{event.timezone}</Badge>}
          </div>
        </div>
      </div>
      {event.description && <p className="text-sm text-slate-600 dark:text-slate-400 mb-6 line-clamp-2 relative z-10">{event.description}</p>}
      <div className="mb-8 relative z-10">
        {isPast ? (
          <div className="flex items-center justify-center py-6 bg-red-500/10 dark:bg-red-900/20 rounded-2xl border border-red-500/20 backdrop-blur-sm">
            <span className="text-xl font-bold text-red-600 dark:text-red-400 flex items-center gap-2"><Clock size={24} /> 目标时间已过</span>
          </div>
        ) : timeLeft ? (
          <div className="grid grid-cols-4 gap-3">
            {[{ l: '天', v: timeLeft.days }, { l: '时', v: timeLeft.hours }, { l: '分', v: timeLeft.minutes }, { l: '秒', v: timeLeft.seconds }].map((item, idx) => (
              <div key={idx} className="flex flex-col items-center justify-center p-3 rounded-2xl bg-white/50 dark:bg-black/30 shadow-inner border border-white/40 dark:border-white/5">
                <span className="text-2xl font-extrabold bg-clip-text text-transparent bg-gradient-to-b from-slate-900 to-slate-600 dark:from-white dark:to-slate-400 tabular-nums tracking-tighter">{item.v.toString().padStart(2, '0')}</span>
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-1">{item.l}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {!selectable && (
        <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-200/50 dark:border-slate-700/50 relative z-10">
          <Button variant="ghost" size="sm" className="hover:bg-primary-50 dark:hover:bg-primary-900/30 hover:text-primary-600 rounded-xl" onClick={(e) => { e.stopPropagation(); onTestSend(event.id); }}><Send size={16} className="mr-1.5" /> 测试发送</Button>
          <Button variant="ghost" size="sm" className="hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-600 rounded-xl" onClick={(e) => { e.stopPropagation(); onEdit(event); }}><Edit2 size={16} className="mr-1.5" /> 编辑</Button>
          <Button variant="ghost" size="sm" className="hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 rounded-xl" onClick={(e) => { e.stopPropagation(); onDelete(event.id); }}><Trash2 size={16} className="mr-1.5" /> 删除</Button>
        </div>
      )}
    </div>
  );
}
