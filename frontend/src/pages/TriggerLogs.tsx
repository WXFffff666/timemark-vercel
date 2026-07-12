import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Bell, ArrowLeft, Trash2, RefreshCw, CheckCircle2, XCircle, Clock, Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } } };

interface ChannelResult {
  success: boolean;
  error?: string;
}

interface TriggerLog {
  id: number;
  event_id: number;
  event_name?: string;
  event_type?: string;
  trigger_type: string;
  trigger_date: string;
  status: string;
  channels?: string;
  channel_results?: string;
  error_message?: string;
  created_at: string;
}

interface TriggerLogsResponse {
  data: TriggerLog[];
  pagination: { total: number; limit: number; offset: number };
}

const getStatusIcon = (status: string) => {
  if (status === 'success') return CheckCircle2;
  if (status === 'failed') return XCircle;
  return Clock;
};

const getEventTypeLabel = (type?: string): string => {
  const labels: Record<string, string> = {
    birthday: '🎂 生日',
    anniversary: '💍 纪念日',
    exam: '📝 考试',
    holiday: '🎉 节日',
    other: '📌 其他',
  };
  return type ? (labels[type] || type) : '未知';
};

const formatTime = (timeStr: string) => {
  if (!timeStr) return '';
  const match = timeStr.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/);
  if (!match) return timeStr;

  const year = parseInt(match[1]);
  const month = parseInt(match[2]);
  const day = parseInt(match[3]);
  const hour = match[4] ? parseInt(match[4]) : 0;
  const minute = match[5] ? parseInt(match[5]) : 0;

  const targetTime = new Date(year, month - 1, day, hour, minute).getTime();
  const now = Date.now();
  const diff = now - targetTime;

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 172800000) return '昨天';

  return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

export default function TriggerLogs() {
  const navigate = useNavigate();
  const [logs, setLogs] = useState<TriggerLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    fetchLogs();
  }, []);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const res = await api.getRaw<TriggerLog[]>('/trigger-logs?limit=100');
      setLogs(res.data || []);
      setTotal((res.pagination?.total as number) || 0);
    } catch (error) {
      console.error('Failed to fetch trigger logs:', error);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  };

  const clearLogs = async () => {
    if (!confirm('确定清空所有提醒日志？此操作不可恢复。')) return;

    setClearing(true);
    try {
      await api.delete('/trigger-logs');
      setLogs([]);
      setTotal(0);
    } catch (error) {
      console.error('Failed to clear trigger logs:', error);
    } finally {
      setClearing(false);
    }
  };

  const parseChannels = (channelsStr?: string): string[] => {
    if (!channelsStr) return [];
    try {
      const parsed = typeof channelsStr === 'string' ? JSON.parse(channelsStr) : channelsStr;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const parseChannelResults = (resultsStr?: string): Record<string, ChannelResult> => {
    if (!resultsStr) return {};
    try {
      const parsed = typeof resultsStr === 'string' ? JSON.parse(resultsStr) : resultsStr;
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch {
      return {};
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-4xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">提醒日志</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">共 {total} 条提醒记录</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={fetchLogs} disabled={loading}>
              <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
            </Button>
            <Button variant="ghost" size="sm" className="rounded-full text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30" onClick={clearLogs} disabled={clearing || logs.length === 0}>
              <Trash2 size={16} className="mr-1" />
              清空
            </Button>
          </div>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-10 mt-2">
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="glass-panel rounded-[2.5rem] p-6 animate-pulse">
                <div className="flex gap-6">
                  <div className="w-16 h-16 rounded-[1.5rem] bg-slate-200/60 dark:bg-slate-700/50"></div>
                  <div className="flex-1">
                    <div className="h-5 bg-slate-200/60 dark:bg-slate-700/50 rounded-full w-1/3 mb-3"></div>
                    <div className="h-4 bg-slate-200/60 dark:bg-slate-700/50 rounded-full w-1/2"></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-16 glass-panel rounded-[2.5rem] ring-1 ring-black/5 dark:ring-white/10">
            <Bell size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-4" />
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">暂无提醒记录</h3>
            <p className="text-slate-500 dark:text-slate-400">事件提醒触发后将在此处显示</p>
          </div>
        ) : (
          <motion.div variants={containerVariants} initial="hidden" animate="visible" className="relative">
            <div className="absolute left-[2.25rem] top-8 bottom-8 w-px bg-gradient-to-b from-primary-500/40 via-slate-200 dark:via-slate-700 to-transparent z-0"></div>
            <div className="space-y-6 relative z-10">
              {logs.map((log) => {
                const StatusIcon = getStatusIcon(log.status);
                const channels = parseChannels(log.channels);
                const channelResults = parseChannelResults(log.channel_results);
                const isSuccess = log.status === 'success';

                return (
                  <motion.div key={log.id} variants={itemVariants} className="flex gap-6 items-center">
                    <div className={`w-16 h-16 rounded-[1.5rem] shrink-0 flex items-center justify-center shadow-md border backdrop-blur-md ${isSuccess ? 'bg-white/90 dark:bg-slate-800/90 text-emerald-500 border-white/60 dark:border-white/10' : 'bg-red-50/90 dark:bg-red-900/40 text-red-600 border-red-100 dark:border-red-800/50'}`}>
                      <StatusIcon size={26} />
                    </div>
                    <div className="glass-panel rounded-[2.5rem] p-6 flex-1 hover:shadow-xl transition-all ring-1 ring-black/5 dark:ring-white/10">
                      <div className="flex flex-col sm:flex-row justify-between sm:items-start gap-3">
                        <div>
                          <div className="flex items-center gap-3">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight">
                              {log.event_name || `事件 #${log.event_id}`}
                            </h3>
                            <Badge variant={isSuccess ? 'success' : 'destructive'} className="scale-90">
                              {isSuccess ? '成功' : '失败'}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2 text-sm font-medium text-slate-500 dark:text-slate-400">
                            <span className="flex items-center gap-1.5">
                              <Calendar size={14} /> {log.trigger_date}
                            </span>
                            <span>{getEventTypeLabel(log.event_type)}</span>
                            {channelResults ? (
                              <span className="flex items-center gap-1.5 flex-wrap">
                                <Bell size={14} />
                                {Object.entries(channelResults).map(([ch, result]) => (
                                  <span
                                    key={ch}
                                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                                      result.success
                                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                        : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                                    }`}
                                    title={result.error || ''}
                                  >
                                    {result.success ? '✓' : '✗'} {ch}
                                  </span>
                                ))}
                              </span>
                            ) : channels.length > 0 ? (
                              <span className="flex items-center gap-1.5">
                                <Bell size={14} /> {channels.join(', ')}
                              </span>
                            ) : null}
                            {!isSuccess && log.error_message && !channelResults && (
                              <span className="text-red-500 text-xs">{log.error_message}</span>
                            )}
                          </div>
                        </div>
                        <div className="text-sm font-bold text-slate-400 whitespace-nowrap bg-slate-100/50 dark:bg-slate-800/50 px-3 py-1 rounded-lg">
                          {formatTime(log.created_at)}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </main>
    </motion.div>
  );
}
