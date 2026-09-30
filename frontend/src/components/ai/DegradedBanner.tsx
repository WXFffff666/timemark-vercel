import { AlertTriangle, Info, WifiOff } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  buildAiDegradedLabels,
  degradedReasonText,
  useAiDegradedState,
  type AiDegradedLabel,
  type AiDegradedSnapshot,
} from '@/hooks/useAiDegradedState';

/**
 * Checkbox 128: degraded/offline UX for the background AI.
 *
 * Presentational only: it never fetches when a `state` is provided, and it renders
 * NOTHING while every signal is healthy. The app must stay fully usable with no AI
 * at all - the banner explains the degraded state; the underlying surfaces each keep
 * a deterministic fallback path (see the notepad table 128-130).
 *
 * States covered, each with its SPECIFIC reason where known:
 *  - no provider configured -> `AI 未启用 - 查看文档` (links `docs/AI.md`),
 *  - provider configured but unreachable,
 *  - queue backed up beyond the depth threshold / queue stalled,
 *  - `worker 离线` derived from `last_seen_at` (via `/api/agent/health`),
 *  - per-routine `已降级: 额度不足 / 预算不足 / 供应商错误` labels.
 */

/** Where the `查看文档` link points by default (override via `docsHref`). */
export const AI_DOCS_HREF = 'https://github.com/WXFffff666/timemark-vercel/blob/main/docs/AI.md';

export interface DegradedBannerProps {
  /** Controlled snapshot (e.g. shared from a page). Omit to let the banner poll itself. */
  state?: AiDegradedSnapshot;
  /** Override the docs/AI.md target. */
  docsHref?: string;
  className?: string;
  /** Optional manual refresh affordance (only rendered when provided). */
  onRefresh?: () => void;
}

function LabelIcon({ kind }: { kind: AiDegradedLabel['kind'] }) {
  if (kind === 'worker_offline') {
    return <WifiOff size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />;
  }
  if (kind === 'ai_disabled') {
    return <Info size={16} className="mt-0.5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />;
  }
  return <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />;
}

export function DegradedBanner({ state, docsHref = AI_DOCS_HREF, className, onRefresh }: DegradedBannerProps) {
  const { lang } = useI18n();
  // Always called (hooks rule): polling pauses when a controlled snapshot is supplied.
  const live = useAiDegradedState({ enabled: state === undefined });
  const snapshot = state ?? live;
  const labels = buildAiDegradedLabels(snapshot, lang);

  if (labels.length === 0) return null;

  const hasWarning = labels.some((label) => label.severity === 'warning');
  return (
    <section
      role="status"
      aria-live="polite"
      data-testid="ai-degraded-banner"
      className={cn(
        'flex flex-col gap-2 rounded-2xl border p-3 text-sm',
        hasWarning
          ? 'border-amber-300 bg-amber-50/80 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
          : 'border-sky-200 bg-sky-50/80 text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200',
        className,
      )}
    >
      {labels.map((label) => (
        <div key={label.key} data-testid={`ai-degraded-${label.kind}`} className="flex items-start gap-2">
          <LabelIcon kind={label.kind} />
          <span className="flex-1">
            {label.text}
            {label.kind === 'ai_disabled' && (
              <>
                {' - '}
                <a
                  href={docsHref}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold underline underline-offset-2"
                >
                  {lang === 'zh' ? '查看文档' : 'View docs'}
                </a>
              </>
            )}
          </span>
        </div>
      ))}
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          className="self-start text-xs font-semibold underline underline-offset-2"
        >
          {lang === 'zh' ? '刷新' : 'Refresh'}
        </button>
      )}
    </section>
  );
}

export interface DegradedRoutineBadgeProps {
  /** Machine-readable reason (`BUDGET_EXHAUSTED_*`, `QUOTA_EXHAUSTED`, `PROVIDER_ERROR`, ...). */
  reason: string;
  /** Routine display name; falls back to nothing when absent. */
  name?: string | null;
  className?: string;
}

/** One explicit per-routine `已降级` label - the specific reason is always shown. */
export function DegradedRoutineBadge({ reason, name, className }: DegradedRoutineBadgeProps) {
  const { lang } = useI18n();
  const text = lang === 'zh'
    ? `${name ? `${name} ` : ''}已降级: ${degradedReasonText(reason, lang)}`
    : `${name ? `${name} ` : ''}degraded: ${degradedReasonText(reason, lang)}`;
  return (
    <span
      data-testid="ai-degraded-routine"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300',
        className,
      )}
    >
      <AlertTriangle size={12} aria-hidden />
      {text}
    </span>
  );
}

export interface DegradedRoutineLabelsProps {
  routines: AiDegradedSnapshot['degradedRoutines'];
  className?: string;
}

/** All per-routine `已降级` labels from a snapshot (renders nothing when healthy). */
export function DegradedRoutineLabels({ routines, className }: DegradedRoutineLabelsProps) {
  if (routines.length === 0) return null;
  return (
    <div data-testid="ai-degraded-routines" className={cn('flex flex-wrap gap-2', className)}>
      {routines.map((routine) => (
        <DegradedRoutineBadge
          key={routine.routineId ?? routine.kind ?? routine.reason}
          reason={routine.reason}
          name={routine.name ?? routine.kind}
        />
      ))}
    </div>
  );
}
