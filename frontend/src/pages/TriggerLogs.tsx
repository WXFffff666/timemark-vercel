import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Bell, ArrowLeft, Trash2, RefreshCw, CheckCircle2, XCircle, Calendar, AlertCircle, SkipForward } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { readDelivery, type DeliveryOutcome } from '@timemark/shared';
import { ChannelIcon } from '@/components/channels/ChannelIcon';
import { fetchChannelTemplates } from '@/lib/channel-templates';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } as const } };

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
  /** JSONB：线上是已解析对象，历史 TEXT 列才是 JSON 字符串 */
  channel_results?: object | string | null;
  error_message?: string;
  created_at: string;
}

/**
 * 真实投递结果 → 展示样式。
 *
 * 落库的 status 只有 success/failed/skipped，而「部分失败」（3 个渠道到了、1 个没到）
 * 被记成 success。只看 status 的话，这个页面会把部分失败画成绿色对勾，并且
 * **永远不渲染重试按钮** —— 后端已经放行的那条重试路径根本走不到。
 * 所以这里和提醒记录页共用同一个 readDelivery 判定。
 */
const OUTCOME_STYLE: Record<DeliveryOutcome, {
  label: string;
  badge: 'success' | 'destructive' | 'secondary';
  Icon: typeof CheckCircle2;
  box: string;
}> = {
  delivered: {
    label: '成功', badge: 'success', Icon: CheckCircle2,
    box: 'bg-white/90 dark:bg-slate-800/90 text-emerald-500 border-white/60 dark:border-white/10',
  },
  partial: {
    label: '部分失败', badge: 'secondary', Icon: AlertCircle,
    box: 'bg-amber-50/90 dark:bg-amber-900/40 text-amber-600 border-amber-100 dark:border-amber-800/50',
  },
  failed: {
    label: '失败', badge: 'destructive', Icon: XCircle,
    box: 'bg-red-50/90 dark:bg-red-900/40 text-red-600 border-red-100 dark:border-red-800/50',
  },
  skipped: {
    label: '已跳过', badge: 'secondary', Icon: SkipForward,
    box: 'bg-slate-50/90 dark:bg-slate-800/90 text-slate-500 border-slate-200 dark:border-white/10',
  },
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

import { formatRelativeTime } from '@/lib/format-time';

export default function TriggerLogs() {
  const navigate = useNavigate();
  // v2.25: 渠道徽章显示图标（模板 id → icon 名）
  const [templateIcons, setTemplateIcons] = useState<Record<string, string>>({});

  const [logs, setLogs] = useState<TriggerLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      // 状态下拉选的是「真实投递结果」（outcome）而不是裸 status：部分失败落库时
      // status='success'，按 status 筛会把绿色标签混进"成功"、且"失败"里漏掉它。
      if (statusFilter) params.set('outcome', statusFilter);
      if (channelFilter) params.set('channel', channelFilter);
      const res = await api.getRaw<TriggerLog[]>(`/trigger-logs?${params.toString()}`);
      setLogs(res.data || []);
      setTotal((res.pagination?.total as number) || 0);
    } catch (error) {
      console.error('Failed to fetch trigger logs:', error);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [statusFilter, channelFilter]);

  // v2.25: 渠道徽章图标（模板目录是单飞缓存，会话内只拉一次）
  useEffect(() => {
    fetchChannelTemplates()
      .then((templates) => {
        setTemplateIcons(Object.fromEntries(templates.map((t) => [t.id, t.icon])));
      })
      .catch(() => undefined);
  }, []);

  const exportCsv = async () => {
    const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken');
    const response = await fetch('/api/trigger-logs/export.csv', {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) return alert('导出失败');
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trigger-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
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

  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);

  const retryLog = async (logId: number) => {
    setRetryingId(logId);
    try {
      await api.post(`/trigger-logs/${logId}/retry`, {});
      await fetchLogs();
      alert('已重新发送，请查看更新后的状态');
    } catch (error) {
      alert(error instanceof Error ? error.message : '重试失败');
    } finally {
      setRetryingId(null);
    }
  };

  // v79 批量重试：把近 7 天真实失败（含部分失败）的提醒一次性逐条补发（后端单次上限 10 条）
  const retryAllFailed = async () => {
    if (!confirm('将把近 7 天内失败/部分失败的提醒逐条重新发送（单次最多 10 条），继续？')) return;
    setRetryingAll(true);
    try {
      const res = await api.post<{ attempted: number; retried: number; failed: number; candidates: number }>(
        '/trigger-logs/retry-failed',
        {},
      );
      await fetchLogs();
      alert(`批量重试完成：成功 ${res.retried} 条，仍失败 ${res.failed} 条（候选 ${res.candidates} 条）`);
    } catch (error) {
      alert(error instanceof Error ? error.message : '批量重试失败');
    } finally {
      setRetryingAll(false);
    }
  };

  // `channel_results` 是 JSONB：线上是已解析对象，历史 TEXT 列才是 JSON 字符串，两种都要认。
  const parseChannelResults = (results?: object | string | null): Record<string, ChannelResult> => {
    if (!results) return {};
    try {
      const parsed = typeof results === 'string' ? JSON.parse(results) : results;
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? (parsed as Record<string, ChannelResult>)
        : {};
    } catch {
      return {};
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-4xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center ring-1 ring-black/5 dark:ring-white/10 shadow-xs">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">提醒日志</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">共 {total} 条提醒记录</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="rounded-full min-h-11" onClick={retryAllFailed} disabled={retryingAll}>
              {retryingAll ? <RefreshCw size={16} className="mr-1 animate-spin" /> : null}
              {retryingAll ? '重试中' : '重试全部失败'}
            </Button>
            <Button variant="ghost" size="sm" className="rounded-full min-h-11" onClick={exportCsv}>
              导出 CSV
            </Button>
            <Button variant="ghost" size="icon" className="rounded-full min-h-11 min-w-11" onClick={fetchLogs} disabled={loading}>
              <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
            </Button>
            <Button variant="ghost" size="sm" className="rounded-full text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30" onClick={clearLogs} disabled={clearing || logs.length === 0}>
              <Trash2 size={16} className="mr-1" />
              清空
            </Button>
          </div>
        </div>
      </header>
      <div className="max-w-4xl mx-auto px-6 mt-3 flex flex-wrap gap-2">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-11 px-3 rounded-xl border text-sm" aria-label="状态筛选">
          <option value="">全部状态</option>
          <option value="delivered">成功</option>
          <option value="partial">部分失败</option>
          <option value="failed">失败</option>
          <option value="skipped">跳过</option>
        </select>
        <input
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
          placeholder="渠道筛选"
          className="h-11 px-3 rounded-xl border text-sm"
          aria-label="渠道筛选"
        />
      </div>
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
                const channels = parseChannels(log.channels);
                const channelResults = parseChannelResults(log.channel_results);
                // 部分失败落库就是 status='success'，只看 status 会把它画成绿色对勾，
                // 而且重试按钮永远不出现 —— 后端放行的重试路径根本走不到。
                const delivery = readDelivery({
                  status: log.status,
                  channelResults: log.channel_results,
                  errorMessage: log.error_message,
                });
                const style = OUTCOME_STYLE[delivery.outcome];
                const StatusIcon = style.Icon;
                const isSuccess = delivery.outcome === 'delivered';

                return (
                  <motion.div key={log.id} variants={itemVariants} className="flex gap-6 items-center">
                    <div className={`w-16 h-16 rounded-[1.5rem] shrink-0 flex items-center justify-center shadow-md border backdrop-blur-md ${style.box}`}>
                      <StatusIcon size={26} />
                    </div>
                    <div className="glass-panel rounded-[2.5rem] p-6 flex-1 hover:shadow-xl transition-all ring-1 ring-black/5 dark:ring-white/10">
                      <div className="flex flex-col sm:flex-row justify-between sm:items-start gap-3">
                        <div>
                          <div className="flex items-center gap-3">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight">
                              {log.event_name || `事件 #${log.event_id}`}
                            </h3>
                            <Badge variant={style.badge} className="scale-90">
                              {style.label}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2 text-sm font-medium text-slate-500 dark:text-slate-400">
                            <span className="flex items-center gap-1.5">
                              <Calendar size={14} /> {log.trigger_date}
                            </span>
                            <span>{getEventTypeLabel(log.event_type)}</span>
                            {delivery.delivered.length > 0 || delivery.failed.length > 0 ? (
                              <span className="flex items-center gap-1.5 flex-wrap">
                                <Bell size={14} />
                                {/* 只列真实渠道：_quiet_hours / _skipped 是内部标记，
                                    当成渠道显示会让人以为存在这样的通知渠道 */}
                                {delivery.delivered.map((ch) => (
                                  <span
                                    key={ch}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                                    title={channelResults[ch]?.error || ''}
                                  >
                                    <ChannelIcon name={templateIcons[ch]} size={12} />
                                    ✓ {ch}
                                  </span>
                                ))}
                                {delivery.failed.map((ch) => (
                                  <span
                                    key={ch}
                                    className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                                    title={channelResults[ch]?.error || ''}
                                  >
                                    ✗ {ch}
                                  </span>
                                ))}
                              </span>
                            ) : channels.length > 0 ? (
                              <span className="flex items-center gap-1.5">
                                <Bell size={14} /> {channels.join(', ')}
                              </span>
                            ) : null}
                            {/* 没有 channel_results 的行（投递后异常、农历换算失败、测试发送抛异常）只有
                                error_message 能说明原因；旧写法 `!channelResults` 里
                                parseChannelResults(null) 返回 {}，恒为真，所以这句话从来没显示过。 */}
                            {!isSuccess && log.error_message && !log.channel_results && (
                              <span className="text-red-500 text-xs">{log.error_message}</span>
                            )}
                            {delivery.outcome === 'partial' && (
                              <span className="text-xs text-amber-600 dark:text-amber-400">
                                已送达 {delivery.delivered.length} 个，未送达 {delivery.failed.length} 个
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                        <div className="text-sm font-bold text-slate-400 whitespace-nowrap bg-slate-100/50 dark:bg-slate-800/50 px-3 py-1 rounded-lg">
                          {formatRelativeTime(log.created_at)}
                        </div>
                        {/* 与后端同一个闸门（trigger-logs.ts 对 outcome==='delivered' 直接 400）。
                            不能顺手加上 `failed.length > 0`：历史失败行没有 channel_results
                            （异常路径与测试发送失败都只写 error_message），那种行 failed 是空数组，
                            加了就等于把它们的重试按钮一起弄没了。 */}
                        {delivery.outcome !== 'delivered' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-full text-xs"
                            disabled={retryingId === log.id}
                            onClick={() => retryLog(log.id)}
                          >
                            {retryingId === log.id ? '重试中...' : '手动重试'}
                          </Button>
                        )}
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
