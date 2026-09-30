/**
 * Task 120: the AI admin control-plane console's LOCAL data layer.
 *
 * Reads the shipped admin control-plane API (task 119, `/api/admin/agent/*`) plus the
 * agent health route (`/api/agent/health`, task 130). It deliberately lives beside the
 * page instead of in `lib/api.ts`, which is frozen for this lane.
 *
 * Read endpoints used:
 *   GET /api/admin/agent/stats    -> counts by status/kind, throughput, failureRate, tokens, suppressed
 *   GET /api/admin/agent/workers  -> workers with online/stale derived from last_seen_at
 *   GET /api/admin/agent/routines -> the schedulers (enable, cron, tier, budget)
 *   GET /api/admin/agent/runs     -> unified run history (routine link + token cost)
 *   GET /api/admin/agent/jobs/:id -> one run's bounded event timeline
 * Write endpoints used:
 *   POST  /api/admin/agent/routines/:id/run-now   -> enqueue exactly one job (202; 409 when disabled)
 *   PATCH /api/admin/agent/routines/:id           -> enabled / cron_expr / tier / budget_per_day
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { AgentHealthView } from '@/hooks/useAiDegradedState';

export const AGENT_JOB_STATUSES = [
  'queued',
  'leased',
  'running',
  'succeeded',
  'failed',
  'dead_letter',
  'cancelled',
] as const;
export type AgentJobStatus = (typeof AGENT_JOB_STATUSES)[number];

export const AGENT_STATUS_LABELS: Record<AgentJobStatus, string> = {
  queued: '排队',
  leased: '已认领',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  dead_letter: '死信',
  cancelled: '已取消',
};

export type AgentRoutineTier = 'lite' | 'medium' | 'high';
export const AGENT_ROUTINE_TIERS: AgentRoutineTier[] = ['lite', 'medium', 'high'];

export const AGENT_TIER_LABELS: Record<AgentRoutineTier, string> = {
  lite: 'lite（轻量）',
  medium: 'medium（标准）',
  high: 'high（高级）',
};

export interface AgentStats {
  generated_at: string;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  throughput: {
    finishedLast24h: number;
    succeededLast24h: number;
    failedLast24h: number;
    deadLetterLast24h: number;
    finishedLastHour: number;
  };
  failureRate: number;
  tokens: { spentTotal: number; spentLast24h: number };
  suppressed: { total: number; last24h: number };
}

export interface AgentWorker {
  id: string;
  kind: string | null;
  last_seen_at: string | null;
  lastSeenAgoMs: number | null;
  online: boolean;
  status: 'online' | 'stale';
  meta: unknown;
}

export interface AgentRoutine {
  id: string;
  user_id: number;
  name: string;
  cron_expr: string | null;
  kind: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  tier: AgentRoutineTier | null;
  budget_per_day: number | null;
  config: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  kind: string;
  status: string;
  attempt: number;
  max_attempts: number;
  costTokens: number;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  routine_id: string | null;
  routine_name: string | null;
  durationMs: number | null;
}

export interface AgentJobEvent {
  id: number;
  job_id: string;
  at: string | null;
  status: string | null;
  detail: unknown;
}

export interface AgentJobDetail {
  job: AgentRun & { error_message?: string | null };
  events: AgentJobEvent[];
  eventsLimit: number;
  eventsHasMore: boolean;
  eventsTotal: number;
}

export interface RoutinePatch {
  enabled?: boolean;
  cron_expr?: string | null;
  tier?: AgentRoutineTier | null;
  budget_per_day?: number | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function fetchAgentStats(): Promise<AgentStats> {
  return api.get<AgentStats>('/admin/agent/stats');
}

export function fetchAgentWorkers(limit = 50): Promise<AgentWorker[]> {
  return api.get<AgentWorker[]>(`/admin/agent/workers?limit=${limit}`);
}

export function fetchAgentRoutines(limit = 100): Promise<AgentRoutine[]> {
  return api.get<AgentRoutine[]>(`/admin/agent/routines?limit=${limit}`);
}

export function fetchAgentRuns(limit = 50): Promise<AgentRun[]> {
  return api.get<AgentRun[]>(`/admin/agent/runs?limit=${limit}`);
}

export function fetchAgentJobDetail(id: string, eventsLimit = 100): Promise<AgentJobDetail> {
  return api.get<AgentJobDetail>(`/admin/agent/jobs/${encodeURIComponent(id)}?events_limit=${eventsLimit}`);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function runRoutineNow(id: string): Promise<{ job_id: string; created: boolean }> {
  return api.post<{ job_id: string; created: boolean }>(
    `/admin/agent/routines/${encodeURIComponent(id)}/run-now`,
    {},
  );
}

export function updateAgentRoutine(id: string, patch: RoutinePatch): Promise<AgentRoutine> {
  return api.patch<AgentRoutine>(`/admin/agent/routines/${encodeURIComponent(id)}`, patch);
}

// ---------------------------------------------------------------------------
// The console read hook - failure-tolerant: one dead endpoint never blanks the rest.
// ---------------------------------------------------------------------------

export interface AgentConsoleErrors {
  stats?: string;
  workers?: string;
  routines?: string;
  runs?: string;
}

export interface AgentConsoleData {
  stats: AgentStats | null;
  workers: AgentWorker[];
  routines: AgentRoutine[];
  runs: AgentRun[];
  loading: boolean;
  errors: AgentConsoleErrors;
  lastUpdated: number | null;
  refresh: () => void;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export const DEFAULT_CONSOLE_POLL_MS = 20_000;

export function useAgentConsoleData(pollMs = DEFAULT_CONSOLE_POLL_MS): AgentConsoleData {
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [workers, setWorkers] = useState<AgentWorker[]>([]);
  const [routines, setRoutines] = useState<AgentRoutine[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [errors, setErrors] = useState<AgentConsoleErrors>({});
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    void Promise.allSettled([
      fetchAgentStats(),
      fetchAgentWorkers(),
      fetchAgentRoutines(),
      fetchAgentRuns(),
    ]).then(([statsResult, workersResult, routinesResult, runsResult]) => {
      if (!mounted.current) return;
      const nextErrors: AgentConsoleErrors = {};
      if (statsResult.status === 'fulfilled') setStats(statsResult.value);
      else nextErrors.stats = messageOf(statsResult.reason);

      if (workersResult.status === 'fulfilled') setWorkers(workersResult.value);
      else nextErrors.workers = messageOf(workersResult.reason);

      if (routinesResult.status === 'fulfilled') setRoutines(routinesResult.value);
      else nextErrors.routines = messageOf(routinesResult.reason);

      if (runsResult.status === 'fulfilled') setRuns(runsResult.value);
      else nextErrors.runs = messageOf(runsResult.reason);

      setErrors(nextErrors);
      setLastUpdated(Date.now());
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = window.setInterval(refresh, Math.max(5_000, pollMs));
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [pollMs, refresh]);

  return { stats, workers, routines, runs, loading, errors, lastUpdated, refresh };
}

// ---------------------------------------------------------------------------
// The agent health route (task 130) - the console needs the RAW payload for the budget
// buckets (`budget.tokens` / `budget.calls`), the worker stale threshold and the queue
// depth, which the shared degraded-state hook deliberately flattens into a snapshot.
// ---------------------------------------------------------------------------

export function fetchAgentHealth(): Promise<AgentHealthView> {
  return api.get<AgentHealthView>('/agent/health');
}

export interface AgentHealthData {
  health: AgentHealthView | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAgentHealth(pollMs = DEFAULT_CONSOLE_POLL_MS): AgentHealthData {
  const [health, setHealth] = useState<AgentHealthView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    fetchAgentHealth()
      .then((value) => {
        if (!mounted.current) return;
        setHealth(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(messageOf(cause));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = window.setInterval(refresh, Math.max(5_000, pollMs));
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [pollMs, refresh]);

  return { health, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// The kill switch.
//
// There is NO runtime HTTP endpoint that flips the deployment-level env kill switch
// (`AGENT_TOOLS_ENABLED` / `AGENT_JOBS_ENABLED`); it is read-only at runtime. What the
// console CAN do through the shipped API is stop the producers: disable every enabled
// routine so no scheduled work is enqueued. The set is remembered in localStorage so a
// reload can restore exactly the routines that were paused.
// ---------------------------------------------------------------------------

const PAUSED_KEY = 'agent-console:paused-routine-ids';

export function readPausedRoutineIds(): string[] {
  try {
    const raw = localStorage.getItem(PAUSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function writePausedRoutineIds(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(PAUSED_KEY);
    else localStorage.setItem(PAUSED_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable (private mode): the pause still applies for this session.
  }
}

/** True when the console considers the background AI paused (no routine can schedule). */
export function isPausedGlobally(routines: AgentRoutine[]): boolean {
  return routines.length > 0 && routines.every((routine) => !routine.enabled);
}

export interface BulkToggleResult {
  changed: string[];
  failures: string[];
}

function partition(
  targets: AgentRoutine[],
  settled: PromiseSettledResult<AgentRoutine>[],
): BulkToggleResult {
  const changed: string[] = [];
  const failures: string[] = [];
  settled.forEach((result, index) => {
    const target = targets[index];
    if (target === undefined) return;
    (result.status === 'fulfilled' ? changed : failures).push(target.id);
  });
  return { changed, failures };
}

/**
 * Kill switch: disable every currently-enabled routine. The ids are recorded BEFORE the
 * PATCHes so a partial failure still lets `resumeAllRoutines` restore the exact prior set.
 */
export async function pauseAllRoutines(routines: AgentRoutine[]): Promise<BulkToggleResult> {
  const targets = routines.filter((routine) => routine.enabled);
  writePausedRoutineIds(targets.map((routine) => routine.id));
  const settled = await Promise.allSettled(
    targets.map((routine) => updateAgentRoutine(routine.id, { enabled: false })),
  );
  return partition(targets, settled);
}

/**
 * Resume: re-enable the remembered set. With nothing remembered (e.g. paused in a prior
 * session, storage cleared) it re-enables every currently-disabled routine.
 */
export async function resumeAllRoutines(routines: AgentRoutine[]): Promise<BulkToggleResult> {
  const stored = readPausedRoutineIds();
  const targets =
    stored.length > 0 ? routines.filter((routine) => stored.includes(routine.id)) : routines.filter((routine) => !routine.enabled);
  const settled = await Promise.allSettled(
    targets.map((routine) => updateAgentRoutine(routine.id, { enabled: true })),
  );
  const result = partition(targets, settled);
  writePausedRoutineIds(result.failures);
  return result;
}

// ---------------------------------------------------------------------------
// Small pure helpers shared by the panels
// ---------------------------------------------------------------------------

export type AgentStatusTone = 'success' | 'destructive' | 'default' | 'secondary' | 'outline';

export function statusTone(status: string): AgentStatusTone {
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'dead_letter') return 'destructive';
  if (status === 'running' || status === 'leased') return 'default';
  if (status === 'cancelled') return 'outline';
  return 'secondary';
}

export function statusLabel(status: string): string {
  return (AGENT_STATUS_LABELS as Record<string, string>)[status] ?? status;
}
