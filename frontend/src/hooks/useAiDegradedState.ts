import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Checkbox 128 (with 130): the degraded/offline state of the background AI.
 *
 * Reads TWO endpoints:
 *  - `GET /api/ai/status`    - is any provider configured / reachable (`enabled` can
 *    be false: the app must then be fully usable with NO AI at all);
 *  - `GET /api/agent/health` - queue depth + oldest-queued age, worker liveness
 *    (derived from `last_seen_at`), budget remaining and the recent per-routine
 *    degraded reasons.
 *
 * Both reads are independent and failure-tolerant: losing one endpoint never blanks
 * the other, and no error is ever thrown into render. The hook only REPORTS state -
 * every AI-dependent surface must still offer a non-AI fallback path (documented in
 * `.omo/notepads/timemark-vercel-expansion/tables/128-130.md`).
 */

export interface AiProviderSlotView {
  configured: boolean;
  model: string | null;
  reachable: boolean | null;
}

export interface AiStatusView {
  enabled: boolean;
  provider: 'primary' | 'fallback' | 'local' | null;
  primary: AiProviderSlotView;
  fallback: AiProviderSlotView;
  local: AiProviderSlotView;
}

export interface AgentHealthView {
  generatedAt: string;
  stalled: boolean;
  queue: {
    depth: number;
    oldestQueuedAgeSeconds: number | null;
    oldestQueuedAt: string | null;
    stalled: boolean;
    stallThresholdSeconds: number;
  };
  worker: {
    online: boolean;
    staleAfterSeconds: number;
    lastSeenAt: string | null;
    lastSeenAgeSeconds: number | null;
    workers: Array<{ id: string; kind: string | null; lastSeenAt: string | null; ageSeconds: number | null }>;
  };
  lastSuccessfulRun: { jobId: string; kind: string; finishedAt: string | null; ageSeconds: number | null } | null;
  provider: {
    enabled: boolean;
    activeProvider: string | null;
    probeRan: boolean;
    primary: AiProviderSlotView;
    fallback: AiProviderSlotView;
    local: AiProviderSlotView;
  };
  budget: {
    month: string;
    tokens: { limit: number | null; used: number; remaining: number | null };
    calls: { limit: number | null; used: number; remaining: number | null };
  };
  degraded: {
    count24h: number;
    reasons: string[];
    routines: Array<{
      routineId: string | null;
      kind: string | null;
      name: string | null;
      reason: string;
      lastAt: string | null;
      count: number;
    }>;
  };
}

export interface DegradedRoutineView {
  routineId: string | null;
  kind: string | null;
  name: string | null;
  reason: string;
  lastAt: string | null;
  count: number;
}

export type DegradedLang = 'zh' | 'en';

export interface AiDegradedSnapshot {
  loading: boolean;
  error: string | null;
  /** `/api/ai/status` succeeded. */
  aiStatusKnown: boolean;
  aiEnabled: boolean;
  providerName: string | null;
  /** Reachability of the ACTIVE provider (probe result); null when unknown. */
  providerReachable: boolean | null;
  /** `/api/agent/health` succeeded. */
  healthKnown: boolean;
  queueDepth: number;
  queueOldestAgeSeconds: number | null;
  queueStalled: boolean;
  /** Queue depth at/over the UI threshold (or stalled). */
  queueBackedUp: boolean;
  workerOnline: boolean | null;
  workerLastSeenAt: string | null;
  budgetExhausted: boolean;
  degraded24h: number;
  degradedRoutines: DegradedRoutineView[];
}

export interface UseAiDegradedStateOptions {
  /** Poll cadence in ms; defaults to 60 s (never below 10 s). */
  pollMs?: number;
  /** Set false to pause polling entirely (e.g. hidden surfaces). */
  enabled?: boolean;
  /** Queue depth considered "backed up"; defaults to 5. */
  queueBackupDepth?: number;
}

export interface UseAiDegradedStateResult extends AiDegradedSnapshot {
  refresh: () => void;
}

export const DEFAULT_AI_DEGRADED_POLL_MS = 60_000;
export const DEFAULT_QUEUE_BACKUP_DEPTH = 5;

export function initialAiDegradedSnapshot(): AiDegradedSnapshot {
  return {
    loading: true,
    error: null,
    aiStatusKnown: false,
    aiEnabled: false,
    providerName: null,
    providerReachable: null,
    healthKnown: false,
    queueDepth: 0,
    queueOldestAgeSeconds: null,
    queueStalled: false,
    queueBackedUp: false,
    workerOnline: null,
    workerLastSeenAt: null,
    budgetExhausted: false,
    degraded24h: 0,
    degradedRoutines: [],
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isBudgetBucketExhausted(bucket: { limit: number | null; used: number; remaining: number | null }): boolean {
  return bucket.limit !== null && (bucket.remaining === 0 || bucket.used >= bucket.limit);
}

function snapshotFrom(ai: AiStatusView | null, health: AgentHealthView | null, queueBackupDepth: number): AiDegradedSnapshot {
  const base = initialAiDegradedSnapshot();
  base.loading = false;

  if (ai) {
    base.aiStatusKnown = true;
    base.aiEnabled = ai.enabled;
    base.providerName = ai.provider;
    const slot = ai.provider === 'primary' ? ai.primary : ai.provider === 'fallback' ? ai.fallback : ai.provider === 'local' ? ai.local : null;
    base.providerReachable = slot?.reachable ?? null;
  }

  if (health) {
    base.healthKnown = true;
    base.queueDepth = health.queue.depth;
    base.queueOldestAgeSeconds = health.queue.oldestQueuedAgeSeconds;
    base.queueStalled = health.queue.stalled;
    base.queueBackedUp = health.queue.stalled || health.queue.depth >= queueBackupDepth;
    base.workerOnline = health.worker.online;
    base.workerLastSeenAt = health.worker.lastSeenAt;
    base.budgetExhausted =
      isBudgetBucketExhausted(health.budget.tokens) || isBudgetBucketExhausted(health.budget.calls);
    base.degraded24h = health.degraded.count24h;
    base.degradedRoutines = health.degraded.routines;
  }

  return base;
}

/** Polls the AI status + agent health endpoints into one failure-tolerant snapshot. */
export function useAiDegradedState(options: UseAiDegradedStateOptions = {}): UseAiDegradedStateResult {
  const pollMs = Math.max(10_000, options.pollMs ?? DEFAULT_AI_DEGRADED_POLL_MS);
  const enabled = options.enabled ?? true;
  const queueBackupDepth = Math.max(1, options.queueBackupDepth ?? DEFAULT_QUEUE_BACKUP_DEPTH);
  const [snapshot, setSnapshot] = useState<AiDegradedSnapshot>(initialAiDegradedSnapshot);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    void Promise.allSettled([
      api.get<AiStatusView>('/ai/status'),
      api.get<AgentHealthView>('/agent/health'),
    ]).then(([aiResult, healthResult]) => {
      if (!mountedRef.current) return;
      const ai = aiResult.status === 'fulfilled' ? aiResult.value : null;
      const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
      const next = snapshotFrom(ai, health, queueBackupDepth);
      if (!ai && !health) {
        next.error = errorMessage(
          aiResult.status === 'rejected' ? aiResult.reason : healthResult.status === 'rejected' ? healthResult.reason : 'unavailable',
        );
      }
      setSnapshot(next);
    });
  }, [queueBackupDepth]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      return () => {
        mountedRef.current = false;
      };
    }
    refresh();
    const timer = window.setInterval(refresh, pollMs);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [enabled, pollMs, refresh]);

  return { ...snapshot, refresh };
}

// ---------------------------------------------------------------------------
// Label derivation (pure - shared by the banner and any per-routine surface)
// ---------------------------------------------------------------------------

export type AiDegradedLabelKind =
  | 'ai_disabled'
  | 'provider_unreachable'
  | 'queue_backed_up'
  | 'queue_stalled'
  | 'worker_offline'
  | 'budget_exhausted'
  | 'routine_degraded';

export interface AiDegradedLabel {
  key: string;
  kind: AiDegradedLabelKind;
  severity: 'info' | 'warning';
  /** Full display text (Chinese labels are the product's default). */
  text: string;
  /** The machine-readable specific reason, kept for tooltips/telemetry. */
  reason?: string;
}

const REASON_TEXT: Record<string, { zh: string; en: string }> = {
  QUOTA_EXHAUSTED: { zh: '额度不足', en: 'quota exhausted' },
  BUDGET_EXHAUSTED_TOKENS: { zh: '预算不足（token）', en: 'budget exhausted (tokens)' },
  BUDGET_EXHAUSTED_CALLS: { zh: '预算不足（调用次数）', en: 'budget exhausted (calls)' },
  PROVIDER_ERROR: { zh: '供应商错误', en: 'provider error' },
};

/** Human text for a degraded reason - unknown reasons are shown VERBATIM, never collapsed. */
export function degradedReasonText(reason: string, lang: DegradedLang = 'zh'): string {
  const entry = REASON_TEXT[reason];
  if (entry) return entry[lang];
  return reason;
}

function minutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/** Every degraded label for a snapshot, most severe first, specific reasons preserved. */
export function buildAiDegradedLabels(snapshot: AiDegradedSnapshot, lang: DegradedLang = 'zh'): AiDegradedLabel[] {
  const zh = lang === 'zh';
  const labels: AiDegradedLabel[] = [];

  if (snapshot.aiStatusKnown && !snapshot.aiEnabled) {
    labels.push({ key: 'ai_disabled', kind: 'ai_disabled', severity: 'info', text: zh ? 'AI 未启用' : 'AI disabled' });
  }
  if (snapshot.aiStatusKnown && snapshot.aiEnabled && snapshot.providerReachable === false) {
    labels.push({
      key: 'provider_unreachable',
      kind: 'provider_unreachable',
      severity: 'warning',
      text: zh
        ? `AI 供应商不可达（${snapshot.providerName ?? 'unknown'}），将自动使用非 AI 路径`
        : `AI provider unreachable (${snapshot.providerName ?? 'unknown'}); non-AI paths stay available`,
      reason: 'PROVIDER_ERROR',
    });
  }

  if (snapshot.healthKnown) {
    if (snapshot.workerOnline === false) {
      labels.push({ key: 'worker_offline', kind: 'worker_offline', severity: 'warning', text: 'worker 离线' });
    }
    if (snapshot.queueStalled) {
      const age = snapshot.queueOldestAgeSeconds === null ? null : minutes(snapshot.queueOldestAgeSeconds);
      labels.push({
        key: 'queue_stalled',
        kind: 'queue_stalled',
        severity: 'warning',
        text: zh
          ? `AI 队列停滞：${snapshot.queueDepth} 个任务等待${age === null ? '' : `，最早 ${age} 分钟`}`
          : `AI queue stalled: ${snapshot.queueDepth} queued${age === null ? '' : `, oldest ${age} min`}`,
      });
    } else if (snapshot.queueBackedUp) {
      labels.push({
        key: 'queue_backed_up',
        kind: 'queue_backed_up',
        severity: 'info',
        text: zh
          ? `AI 队列积压：${snapshot.queueDepth} 个任务等待`
          : `AI queue backing up: ${snapshot.queueDepth} queued`,
      });
    }
    if (snapshot.budgetExhausted) {
      labels.push({
        key: 'budget_exhausted',
        kind: 'budget_exhausted',
        severity: 'warning',
        text: zh ? '已降级: 预算不足' : 'degraded: budget exhausted',
        reason: 'BUDGET_EXHAUSTED_TOKENS',
      });
    }
    for (const routine of snapshot.degradedRoutines) {
      const name = routine.name ?? routine.kind ?? 'routine';
      labels.push({
        key: `routine_degraded:${routine.routineId ?? routine.kind ?? name}`,
        kind: 'routine_degraded',
        severity: 'warning',
        text: zh
          ? `${name} 已降级: ${degradedReasonText(routine.reason, lang)}`
          : `${name} degraded: ${degradedReasonText(routine.reason, lang)}`,
        reason: routine.reason,
      });
    }
  }

  return labels;
}
