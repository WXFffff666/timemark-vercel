import { Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CardShell } from './CardShell';
import { buildAiDegradedLabels, useAiDegradedState } from '@/hooks/useAiDegradedState';

/**
 * Task 136: a compact one-line AI / agent-queue status. Reuses the shipped
 * `useAiDegradedState` hook (polls `/ai/status` + `/agent/health`) and the shared
 * label builder, so this card and the degraded banner can never disagree.
 */
export function AiQueueStatusCard() {
  const snapshot = useAiDegradedState({ pollMs: 60_000 });
  const labels = buildAiDegradedLabels(snapshot, 'zh');
  const healthy = snapshot.aiStatusKnown && snapshot.aiEnabled && labels.length === 0;

  return (
    <CardShell
      title="AI / 队列状态"
      icon={<Sparkles size={16} aria-hidden />}
      href="/agent-console"
      loading={snapshot.loading}
      error={snapshot.error}
      onRetry={snapshot.refresh}
    >
      <div className="flex items-center gap-2">
        <Badge variant={healthy ? 'success' : labels.length > 0 ? 'destructive' : 'secondary'} className="text-[10px]">
          {healthy ? '正常' : labels.length > 0 ? '降级' : '未知'}
        </Badge>
        <span className="text-sm text-slate-700 dark:text-slate-200">
          {snapshot.aiStatusKnown
            ? snapshot.aiEnabled
              ? `供应商 ${snapshot.providerName ?? '未知'}`
              : 'AI 未启用'
            : 'AI 状态未知'}
        </span>
        {snapshot.healthKnown && (
          <span className="ml-auto text-xs text-hint">
            队列 {snapshot.queueDepth}
            {snapshot.workerOnline === false ? ' · worker 离线' : ''}
          </span>
        )}
      </div>
      {labels.length > 0 && (
        <p className="mt-2 truncate text-xs text-amber-600 dark:text-amber-400">{labels[0].text}</p>
      )}
    </CardShell>
  );
}
