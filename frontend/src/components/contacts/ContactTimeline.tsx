import { Gift, History, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { TimelineEntry } from '@timemark/shared';
import {
  formatTimelineAt,
  promiseStatusText,
  timelineEntryBody,
  timelineEntryTitle,
} from '@/lib/contact-crm-utils';

interface ContactTimelineProps {
  entries: TimelineEntry[];
  loading: boolean;
  error?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onRetry?: () => void;
}

/** 按条目类型给时间轴圆点一个固定的语义色（与徽章的 emerald/amber 用法一致）。 */
const DOT_CLASS: Record<TimelineEntry['type'], string> = {
  interaction: 'bg-primary-500',
  promise: 'bg-amber-500',
  gift: 'bg-emerald-500',
};

function EntryMeta({ entry }: { entry: TimelineEntry }) {
  const status = promiseStatusText(entry);
  return (
    <div className="flex flex-wrap items-center gap-2 mt-1">
      <span className="text-xs text-hint" data-testid={`timeline-time-${entry.type}-${entry.id}`}>
        {formatTimelineAt(entry.at)}
      </span>
      {entry.type === 'promise' && (
        <Badge variant="outline" className="text-[10px] normal-case">
          {entry.done_at ? '已完成' : '进行中'}
        </Badge>
      )}
      {status && <span className="text-xs text-hint">{status}</span>}
    </div>
  );
}

/**
 * 垂直时间线（互动 / 约定 / 礼物）。纯展示组件：
 * - 加载中 → 明确的 loading 节点（带 spinner）
 * - 加载失败 → 错误 + 重试
 * - 空列表 → 独立空状态（不是 spinner，不许崩）
 *
 * 约定（promise）只读渲染：后端当前没有完成接口（POST only），
 * 因此这里不提供任何完成操作，只展示 done_at 状态。
 */
export function ContactTimeline({
  entries,
  loading,
  error,
  hasMore,
  loadingMore,
  onLoadMore,
  onRetry,
}: ContactTimelineProps) {
  if (loading) {
    return (
      <div
        data-testid="contact-timeline-loading"
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-2 py-10 text-sm text-hint"
      >
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
        正在加载互动记录…
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="contact-timeline-error"
        role="alert"
        className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-6 text-center"
      >
        <p className="text-sm text-destructive">{error}</p>
        {onRetry && (
          <Button variant="outline" size="sm" className="mt-3 min-h-11" onClick={onRetry}>
            <RefreshCw className="w-4 h-4 mr-1" aria-hidden />
            重试
          </Button>
        )}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div data-testid="contact-timeline-empty" className="text-center py-12 rounded-2xl ring-1 ring-black/5 dark:ring-white/10">
        <History className="w-10 h-10 mx-auto mb-2 text-slate-300 dark:text-slate-600" aria-hidden />
        <p className="font-semibold text-slate-700 dark:text-slate-200">还没有互动记录</p>
        <p className="text-sm text-hint mt-1">用上方的「记录联系」记下第一次通话或见面</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ol data-testid="contact-timeline" className="relative space-y-4 pl-6">
        {/* 贯穿的竖线：时间轴的骨架 */}
        <span
          aria-hidden
          className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-200 dark:bg-white/10"
        />
        {entries.map((entry) => (
          <li
            key={`${entry.type}-${entry.id}`}
            data-testid={`timeline-entry-${entry.type}-${entry.id}`}
            data-type={entry.type}
            className="relative"
          >
            <span
              aria-hidden
              className={`absolute -left-[22px] top-1.5 h-3.5 w-3.5 rounded-full ring-2 ring-white dark:ring-zinc-900 ${DOT_CLASS[entry.type]}`}
            />
            <div className="rounded-2xl px-3 py-2.5 bg-white/70 dark:bg-slate-900/60 ring-1 ring-black/5 dark:ring-white/10">
              <div className="flex items-center gap-2 flex-wrap">
                {entry.type === 'gift' && <Gift className="w-3.5 h-3.5 text-emerald-500" aria-hidden />}
                <span className="font-semibold text-sm">{timelineEntryTitle(entry)}</span>
              </div>
              <p className="text-sm text-slate-700 dark:text-slate-200 mt-1 break-words [overflow-wrap:anywhere] whitespace-pre-wrap">
                {timelineEntryBody(entry)}
              </p>
              <EntryMeta entry={entry} />
            </div>
          </li>
        ))}
      </ol>
      {hasMore && (
        <Button
          variant="outline"
          className="w-full min-h-11"
          disabled={loadingMore}
          onClick={onLoadMore}
          aria-label="加载更早的记录"
        >
          {loadingMore ? <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden /> : null}
          {loadingMore ? '加载中…' : '加载更早的记录'}
        </Button>
      )}
    </div>
  );
}
