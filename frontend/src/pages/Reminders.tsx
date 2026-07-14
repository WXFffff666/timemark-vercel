import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Bell, CheckCircle2, AlertCircle, Clock, ArrowLeft, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } } };

interface ReminderLog {
  id: number;
  event_id: number;
  event_name: string;
  channel: string;
  status: 'success' | 'failed';
  message?: string;
  sent_at: string;
}

export default function Reminders() {
  const navigate = useNavigate();
  const [reminders, setReminders] = useState<ReminderLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchReminders();
  }, []);

  const fetchReminders = async () => {
    setLoading(true);
    try {
      const data = await api.get<ReminderLog[]>('/events/reminder-logs');
      setReminders(data);
    } catch (error) {
      console.error('Failed to fetch reminders:', error);
      setReminders([]);
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (timeStr: string) => {
    const date = new Date(timeStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 172800000) return '昨天';
    return date.toLocaleString('zh-CN');
  };

  const getChannelName = (channel: string) => {
    const channelMap: Record<string, string> = {
      'email': '邮件',
      'feishu': '飞书',
      'dingtalk': '钉钉',
      'wecom': '企业微信',
      'telegram': 'Telegram',
      'slack': 'Slack',
      'discord': 'Discord',
      'wechat': '微信公众号',
      'webhook': 'Webhook',
    };
    return channelMap[channel] || channel;
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-4xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">提醒记录</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">查看历史提醒发送记录</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="rounded-full" onClick={fetchReminders} disabled={loading}>
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-10 mt-2">
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="glass-panel rounded-[2.5rem] p-6 animate-pulse">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-slate-200/60 dark:bg-slate-700/50"></div>
                  <div className="flex-1">
                    <div className="h-5 bg-slate-200/60 dark:bg-slate-700/50 rounded-full w-1/3 mb-3"></div>
                    <div className="h-4 bg-slate-200/60 dark:bg-slate-700/50 rounded-full w-1/2"></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : reminders.length === 0 ? (
          <div className="text-center py-16 glass-panel rounded-[2.5rem] ring-1 ring-black/5 dark:ring-white/10">
            <Bell size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-4" />
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">暂无提醒记录</h3>
            <p className="text-slate-500 dark:text-slate-400">您的提醒发送历史将在此处显示</p>
          </div>
        ) : (
          <motion.div variants={containerVariants} initial="hidden" animate="visible" className="space-y-4">
            {reminders.map((r) => (
              <motion.div key={r.id} variants={itemVariants} className="glass-panel rounded-[2.5rem] p-6 flex items-center justify-between hover:shadow-xl transition-all ring-1 ring-black/5 dark:ring-white/10">
                <div className="flex items-center gap-5">
                  <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-inner border ${r.status === 'success' ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 border-emerald-100 dark:border-emerald-800/50' : 'bg-red-50 dark:bg-red-900/30 text-red-600 border-red-100 dark:border-red-800/50'}`}>
                    {r.status === 'success' ? <CheckCircle2 size={26} /> : <AlertCircle size={26} />}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-3">
                      {r.event_name} 
                      <Badge variant={r.status === 'success' ? 'success' : 'destructive'} className="scale-90">
                        {r.status === 'success' ? '成功' : '失败'}
                      </Badge>
                    </h3>
                    <div className="flex items-center gap-3 mt-1.5 text-sm font-medium text-slate-500 dark:text-slate-400">
                      <span className="flex items-center gap-1.5"><Clock size={14} /> {formatTime(r.sent_at)}</span>
                      <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-600"></span>
                      <span>渠道: {getChannelName(r.channel)}</span>
                    </div>
                    {r.message && r.status === 'failed' && (
                      <div className="mt-2 text-sm text-red-500 dark:text-red-400">{r.message}</div>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </main>
    </motion.div>
  );
}