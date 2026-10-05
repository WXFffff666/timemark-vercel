import { useEffect, useState } from 'react';
import { ArrowRight, Bell, CheckCircle2, AlertCircle, SkipForward, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { readDelivery, type DeliveryOutcome } from '@timemark/shared';

/**
 * v2.27 遗留2：通知时间线卡（Dashboard）。
 *
 * 复用 /trigger-logs 接口（user 维度投递记录），只读展示最近 6 条的真实投递
 * 结果（readDelivery 判定与提醒日志页同源——部分失败不会画成绿色对勾），
 * 「查看全部」深链到合并后的 /trigger-logs。拉取失败静默隐藏整卡。
 */

interface TimelineLog {
  id: number;
  event_name?: string;
  event_id: number;
  status: string;
  channel_results?: object | string | null;
  error_message?: string;
  created_at: string;
}

const OUTCOME_ICON: Record<DeliveryOutcome, typeof CheckCircle2> = {
  delivered: CheckCircle2,
  partial: AlertCircle,
  failed: AlertCircle,
  skipped: SkipForward,
};

const OUTCOME_CLASS: Record<DeliveryOutcome, string> = {
  delivered: 'text-emerald-500',
  partial: 'text-amber-500',
  failed: 'text-red-500',
  skipped: 'text-slate-400',
};

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function RecentNotificationsCard() {
  const navigate = useNavigate();
  const [logs, setLogs] = useState<TimelineLog[] | null>(null);

  useEffect(() => {
    api.get<TimelineLog[]>('/trigger-logs?limit=6')
      .then((data) => setLogs(Array.isArray(data) ? data : []))
      .catch(() => setLogs(null));
  }, []);

  if (logs === null || logs.length === 0) return null;

  return (
    <div className="mb-6 glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
          <Bell size={14} className="text-indigo-500" /> 近期通知
        </p>
        <Button variant="ghost" size="sm" className="rounded-full text-xs" onClick={() => navigate('/trigger-logs')}>
          查看全部 <ArrowRight size={12} className="ml-0.5" />
        </Button>
      </div>
      {logs === undefined ? (
        <Loader2 size={14} className="animate-spin text-slate-400" />
      ) : (
        <ul className="space-y-2">
          {logs.map((log) => {
            const delivery = readDelivery({
              status: log.status,
              channelResults: log.channel_results,
              errorMessage: log.error_message,
            });
            const Icon = OUTCOME_ICON[delivery.outcome];
            return (
              <li key={log.id} className="flex items-center gap-2.5 text-xs">
                <Icon size={14} className={`shrink-0 ${OUTCOME_CLASS[delivery.outcome]}`} />
                <span className="min-w-0 flex-1 truncate font-medium text-slate-700 dark:text-slate-300">
                  {log.event_name || `事件 #${log.event_id}`}
                </span>
                <span className="shrink-0 text-slate-400">{relativeTime(log.created_at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
