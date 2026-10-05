import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Bell, CheckCircle2, AlertCircle, Clock, RefreshCw, SkipForward } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format-time';
import { readDelivery, realChannelIds, type DeliveryOutcome } from '@timemark/shared';

/**
 * 「事件提醒」投递记录列表（GET /events/reminder-logs）。
 *
 * v2.26 C：原 /reminders 独立页与 /trigger-logs 展示的是同一类数据（事件提醒投递
 * 历史），且共用 readDelivery / OUTCOME_STYLE / 空态文案 —— 页面整体并入
 * TriggerLogs 的第二个 tab，本组件是被复用的列表主体（不含页面外壳）。
 */

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } as const } };

interface ReminderLog {
  id: number;
  event_id: number;
  event_name: string;
  /** 落库只记 success/failed/skipped；部分失败记 success，真实结果看 channel_results */
  status: 'success' | 'failed' | 'skipped';
  error_message: string | null;
  channel_results: object | string | null;
  created_at: string;
}

const OUTCOME_STYLE: Record<DeliveryOutcome, { label: string; badge: 'success' | 'destructive' | 'secondary'; icon: typeof CheckCircle2; box: string; text: string }> = {
  delivered: {
    label: '成功',
    badge: 'success',
    icon: CheckCircle2,
    box: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 border-emerald-100 dark:border-emerald-800/50',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  // 部分失败以前显示绿色"成功"并把错误藏起来：3 个渠道到了、1 个没到，用户完全看不到
  partial: {
    label: '部分失败',
    badge: 'secondary',
    icon: AlertCircle,
    box: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 border-amber-100 dark:border-amber-800/50',
    text: 'text-amber-600 dark:text-amber-400',
  },
  failed: {
    label: '失败',
    badge: 'destructive',
    icon: AlertCircle,
    box: 'bg-red-50 dark:bg-red-900/30 text-red-600 border-red-100 dark:border-red-800/50',
    text: 'text-red-500 dark:text-red-400',
  },
  skipped: {
    label: '已跳过',
    badge: 'secondary',
    icon: SkipForward,
    box: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
    text: 'text-slate-500 dark:text-slate-400',
  },
};

export function EventReminderLogs() {
  const [reminders, setReminders] = useState<ReminderLog[]>([]);
  const [loading, setLoading] = useState(true);
  // v2.27 E-12：本地状态筛选 chips（成功/部分失败/失败/已跳过）
  const [outcomeFilter, setOutcomeFilter] = useState<'' | 'delivered' | 'partial' | 'failed' | 'skipped'>('');

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

  useEffect(() => {
    fetchReminders();
  }, []);

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

  // JSONB 列在网络上是已解析对象，历史 TEXT 列是 JSON 字符串，两种都交给 realChannelIds
  // 处理（畸形值返回空列表而不是崩掉）。它同时剔除了 _quiet_hours / _skipped 这类内部
  // 标记键 —— 把它们当渠道列出来，用户会以为真有这么个通知渠道。
  const formatChannels = (channelResults?: object | string | null) =>
    realChannelIds(channelResults).map(getChannelName).join('、');

  const filtered = outcomeFilter
    ? reminders.filter((r) => {
        const d = readDelivery({ status: r.status, channelResults: r.channel_results, errorMessage: r.error_message });
        return d.outcome === outcomeFilter;
      })
    : reminders;

  const FILTERS: Array<['' | 'delivered' | 'partial' | 'failed' | 'skipped', string]> = [
    ['', '全部'], ['delivered', '成功'], ['partial', '部分失败'], ['failed', '失败'], ['skipped', '已跳过'],
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map(([value, label]) => (
            <button
              key={value || 'all'}
              type="button"
              aria-pressed={outcomeFilter === value}
              onClick={() => setOutcomeFilter(value)}
              className={`text-xs px-3 py-1.5 rounded-full border transition ${
                outcomeFilter === value
                  ? 'bg-primary-500 text-white border-primary-500'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="rounded-full min-h-11" onClick={fetchReminders} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          刷新
        </Button>
      </div>
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
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 glass-panel rounded-[2.5rem] ring-1 ring-black/5 dark:ring-white/10">
          <Bell size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-4" />
          <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">暂无提醒记录</h3>
          <p className="text-slate-500 dark:text-slate-400">您的提醒发送历史将在此处显示</p>
        </div>
      ) : (
        <motion.div variants={containerVariants} initial="hidden" animate="visible" className="space-y-4">
          {filtered.map((r) => {
            const delivery = readDelivery({
              status: r.status,
              channelResults: r.channel_results,
              errorMessage: r.error_message,
            });
            const style = OUTCOME_STYLE[delivery.outcome];
            const Icon = style.icon;
            // 落库的 error_message 是权威的人读信息（可能比逐渠道原因更完整），
            // 只有它缺失时才用推导出的逐渠道原因兜底。
            const detail = r.error_message ?? delivery.reason;
            return (
              <motion.div key={r.id} variants={itemVariants} className="glass-panel rounded-[2.5rem] p-6 flex items-center justify-between hover:shadow-xl transition-all ring-1 ring-black/5 dark:ring-white/10">
                <div className="flex items-center gap-5">
                  <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-inner border ${style.box}`}>
                    <Icon size={26} />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-3">
                      {r.event_name}
                      <Badge variant={style.badge} className="scale-90">
                        {style.label}
                      </Badge>
                    </h3>
                    <div className="flex items-center gap-3 mt-1.5 text-sm font-medium text-slate-500 dark:text-slate-400">
                      <span className="flex items-center gap-1.5"><Clock size={14} /> {formatRelativeTime(r.created_at)}</span>
                      <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-600"></span>
                      <span>渠道: {formatChannels(r.channel_results)}</span>
                    </div>
                    {/* 部分失败也要说清楚：旧代码只在 status==='failed' 时显示错误，
                        于是"3 个到了 1 个没到"既显示成功又看不到原因。 */}
                    {delivery.outcome === 'partial' && delivery.delivered.length > 0 && (
                      <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                        已送达 {delivery.delivered.length} 个，未送达 {delivery.failed.length} 个
                      </div>
                    )}
                    {detail && delivery.outcome !== 'delivered' && (
                      <div className={`mt-1 text-sm ${style.text}`}>{detail}</div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}
