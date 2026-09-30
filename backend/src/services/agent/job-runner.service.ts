import { createLogger } from '../../utils/logger.js';
import { query } from '../../db/index.js';
import {
  agentQueue,
  type AgentJobKind,
  type AgentQueue,
  type ClaimedJob,
} from './queue.service.js';
import {
  isAiModelTier,
  listConfiguredProviders,
  type AiChatResult,
  type AiEnv,
  type AiModelTier,
} from '../ai/gateway.js';
import {
  evaluateMonthlyBudget,
  getMonthlyUsage,
  readMonthlyBudget,
  type MonthlyUsage,
} from './budget.service.js';
import {
  degradedReasonForError,
  recordAgentRun,
  type AgentRunRecordInput,
} from './run-observability.service.js';

/**
 * Checkbox 117: the job executor that ENFORCES model tiering and the per-job cost
 * guard on the real drain path (the executor seam of `routes/agent-worker.ts`).
 *
 * Per claimed job:
 *
 *  1. Resolve the job's AI tier, in this precedence:
 *       payload.tier  >  agent_routines.tier (when the payload links a routine)
 *                     >  AGENT_JOB_TIER_BY_KIND[kind]
 *     A kind with no tier (e.g. `watchdog`) is DETERMINISTIC: it spends nothing and
 *     is never gated by the budget.
 *  2. Evaluate the monthly budget against the REAL recorded spend
 *     (`agent_jobs.cost_tokens`). Exhausted => lite jobs are skipped, medium jobs are
 *     deferred, high jobs drain (flagged over budget). AI OFF => always allowed, so
 *     the deterministic path is never blocked (plan criterion 14).
 *  3. Run the registered handler with the resolved tier; the handler routes its model
 *     call through the AI gateway (`chat(..., { tier })`) and returns `costTokens`
 *     from the provider usage, which the drain's `complete()` persists into
 *     `agent_jobs.cost_tokens`.
 *
 * Degradation is RECORDED twice: the job row receives the marker in `result` (the
 * drain completes with what the executor returns) and an `agent_job_events` row
 * carries `{action, actor, tier, reason, usage, budget}` so `GET /jobs/:id` shows why.
 *
 * Deferral does not burn attempts: the work is re-enqueued once per budget month
 * (idempotency key `budget-defer:<jobId>:<YYYY-MM>`) with `run_at` at the next UTC
 * month start, and the current row completes with `{degraded:'deferred', ...}`. A
 * budget reset therefore resumes the work, while a transient failure still uses the
 * queue's own retry/backoff contract (`fail(..., retryable)` via the drain route).
 */

const log = createLogger('agent-job-runner');

/** A routine id from an untrusted job payload must be uuid-shaped before any uuid comparison. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Default AI tier per job kind (the plan's mapping). `watchdog` is deliberately
 * absent: it is a deterministic health job and must never be gated or tier-routed.
 * A routine's configured `tier` (or an explicit `payload.tier`) overrides these.
 */
export const AGENT_JOB_TIER_BY_KIND: Partial<Record<AgentJobKind, AiModelTier>> = {
  hourly_triage: 'lite',
  morning_brief: 'medium',
  evening_review: 'medium',
  weekly_review: 'high',
};

/**
 * A routine's configured tier. `id::text = $1` (never `$1::uuid`): a malformed payload
 * id would make the uuid cast raise 22P02 and fail every such job.
 */
export const ROUTINE_TIER_SQL = `SELECT tier FROM agent_routines WHERE id::text = $1 AND user_id = $2`;

/** Same shape the admin route writes (`{action, actor, from}` convention). */
export const JOB_EVENT_INSERT_SQL = `INSERT INTO agent_job_events (job_id, status, detail) VALUES ($1, $2, $3::jsonb)`;

export interface AgentJobHandlerResult {
  result?: unknown;
  costTokens?: number;
}

export interface AgentJobHandlerContext {
  /** Resolved tier, or `null` for a deterministic kind (no AI routing). */
  tier: AiModelTier | null;
}

export type AgentJobHandler = (
  job: ClaimedJob,
  context: AgentJobHandlerContext,
) => Promise<AgentJobHandlerResult | void>;

export interface AgentJobRunnerDeps {
  /** Used for budget deferral re-enqueues; defaults to the process-wide queue. */
  enqueue?: AgentQueue['enqueue'];
  /** Handlers by kind; an absent handler fails the job with `NO_HANDLER`. */
  handlers?: Partial<Record<AgentJobKind, AgentJobHandler>>;
  /** Environment source for the gateway/budget config; defaults to `process.env`. */
  env?: AiEnv;
  /** Clock in epoch ms, injectable for deterministic month-boundary tests. */
  now?: () => number;
  /** Monthly spend reader; defaults to the shipped SQL. */
  readUsage?: (userId: number) => Promise<MonthlyUsage>;
  /** Routine-tier reader; defaults to the shipped SQL. */
  resolveRoutineTier?: (routineId: string, userId: number) => Promise<AiModelTier | null>;
  /** Job-event writer; defaults to the shipped INSERT. */
  recordEvent?: (jobId: string, status: string, detail: Record<string, unknown>) => Promise<void>;
  /**
   * Per-run observability writer (checkbox 130); defaults to the shipped recorder,
   * which is skipped under the test runner. Recording NEVER fails a job.
   */
  recordRun?: (record: AgentRunRecordInput) => Promise<unknown> | unknown;
}

/** Run recorder default: skipped under the test runner, otherwise best-effort. */
async function defaultRecordRun(record: AgentRunRecordInput): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  await recordAgentRun(record);
}

/** First string-valued `key` in the handler result (outer object, then nested `result`). */
function pickString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Best-effort model/provider names for the run record; never required for correctness. */
function extractRunMeta(value: AgentJobHandlerResult | void): { model: string | null; provider: string | null } {
  const outer: Record<string, unknown> =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const inner: Record<string, unknown> =
    typeof outer.result === 'object' && outer.result !== null ? (outer.result as Record<string, unknown>) : {};
  return {
    model: pickString(inner, 'model') ?? pickString(outer, 'model'),
    provider: pickString(inner, 'provider') ?? pickString(outer, 'provider'),
  };
}

/** The provider error code of a thrown value, or null for a non-provider failure. */
function runnerErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim() !== '') return code.slice(0, 64);
  }
  return null;
}

/** Raised when a claimed job has no registered handler - never silently completed. */
export class AgentJobHandlerMissingError extends Error {
  readonly code = 'NO_HANDLER';

  constructor(kind: string) {
    super(`no handler is registered for agent job kind "${kind}"`);
    this.name = 'AgentJobHandlerMissingError';
  }
}

/** Provider-reported token cost for one completed call; 0 when usage was omitted. */
export function chatCostTokens(result: AiChatResult): number {
  const total = result.usage?.totalTokens;
  return typeof total === 'number' && Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
}

function payloadOf(job: ClaimedJob): Record<string, unknown> {
  return typeof job.payload === 'object' && job.payload !== null
    ? (job.payload as Record<string, unknown>)
    : {};
}

async function defaultResolveRoutineTier(
  routineId: string,
  userId: number,
): Promise<AiModelTier | null> {
  const result = await query(ROUTINE_TIER_SQL, [routineId, userId]);
  const tier = result.rows[0]?.tier;
  return isAiModelTier(tier) ? tier : null;
}

async function defaultRecordEvent(
  jobId: string,
  status: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await query(JOB_EVENT_INSERT_SQL, [jobId, status, JSON.stringify(detail)]);
}

function nextMonthStart(nowMs: number): Date {
  const current = new Date(nowMs);
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
}

/** Stable per-month key for the deferral idempotency key (`YYYY-MM` of the UTC date). */
function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Build the job executor. Inject a fake queue/handlers/clock in tests; production
 * uses {@link agentJobExecutor} (the drain route's `execute` seam).
 */
export function createAgentJobExecutor(
  deps: AgentJobRunnerDeps = {},
): (job: ClaimedJob) => Promise<AgentJobHandlerResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const handlers = deps.handlers ?? {};
  const enqueue = deps.enqueue ?? ((kind, payload, options) => agentQueue.enqueue(kind, payload, options));
  const readUsage = deps.readUsage ?? getMonthlyUsage;
  const resolveRoutineTier = deps.resolveRoutineTier ?? defaultResolveRoutineTier;
  const recordEvent = deps.recordEvent ?? defaultRecordEvent;
  const recordRun = deps.recordRun ?? defaultRecordRun;

  async function resolveJobTier(job: ClaimedJob): Promise<AiModelTier | null> {
    const payload = payloadOf(job);
    if (isAiModelTier(payload.tier)) return payload.tier;
    const routineId = payload.routine_id;
    if (typeof routineId === 'string' && UUID_RE.test(routineId) && job.userId !== null) {
      const routineTier = await resolveRoutineTier(routineId, job.userId);
      if (routineTier !== null) return routineTier;
    }
    return AGENT_JOB_TIER_BY_KIND[job.kind] ?? null;
  }

  async function invokeHandler(
    job: ClaimedJob,
    tier: AiModelTier | null,
  ): Promise<AgentJobHandlerResult> {
    const handler = handlers[job.kind];
    if (!handler) throw new AgentJobHandlerMissingError(job.kind);
    return (await handler(job, { tier })) ?? {};
  }

  /** Best-effort run-record write; a recording failure never affects the job outcome. */
  async function recordRunSafe(record: AgentRunRecordInput): Promise<void> {
    try {
      await recordRun(record);
    } catch (error) {
      log.warn(
        { event: 'agent_job.run_record_failed', jobId: record.jobId, jobKind: record.kind, err: error },
        'Recording the agent run failed; the job result is unaffected',
      );
    }
  }

  /** Shared run-record identity for one claimed job. */
  function baseRecord(job: ClaimedJob): Pick<AgentRunRecordInput, 'jobId' | 'userId' | 'kind' | 'routineId'> {
    const routineId = payloadOf(job).routine_id;
    return {
      jobId: job.id,
      userId: job.userId,
      kind: job.kind,
      routineId: typeof routineId === 'string' && UUID_RE.test(routineId) ? routineId : null,
    };
  }

  /** Best-effort audit write: the job result already carries the reason on failure. */
  async function recordDecision(
    job: ClaimedJob,
    status: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await recordEvent(job.id, status, detail);
    } catch (error) {
      log.error(
        { event: 'agent_job.guard_event_failed', jobId: job.id, jobKind: job.kind, status, err: error },
        'Recording the cost-guard decision failed; the job result still carries the reason',
      );
    }
  }

  return async function execute(job: ClaimedJob): Promise<AgentJobHandlerResult> {
    const startedAt = now();
    const base = baseRecord(job);
    const tier = await resolveJobTier(job);
    if (tier === null) {
      // Deterministic job: no AI spend and no budget gate.
      try {
        const value = await invokeHandler(job, null);
        const meta = extractRunMeta(value);
        await recordRunSafe({
          ...base,
          tier: null,
          model: meta.model,
          provider: meta.provider,
          tokens: value?.costTokens ?? 0,
          durationMs: now() - startedAt,
          outcome: 'succeeded',
        });
        return value;
      } catch (error) {
        const code = runnerErrorCode(error);
        await recordRunSafe({
          ...base,
          tier: null,
          durationMs: now() - startedAt,
          outcome: 'failed',
          errorCode: code,
          degradedReason: degradedReasonForError(code),
        });
        throw error;
      }
    }

    const budget = readMonthlyBudget(env);
    const aiConfigured = listConfiguredProviders(env).length > 0;
    const hasBudget = budget.tokens !== null || budget.calls !== null;
    const usage =
      aiConfigured && hasBudget && job.userId !== null
        ? await readUsage(job.userId)
        : { tokens: 0, calls: 0 };
    const decision = evaluateMonthlyBudget({ tier, aiConfigured, budget, usage });

    if (decision.action === 'allow') {
      try {
        const value = await invokeHandler(job, tier);
        const meta = extractRunMeta(value);
        await recordRunSafe({
          ...base,
          tier,
          model: meta.model,
          provider: meta.provider,
          tokens: value?.costTokens ?? 0,
          durationMs: now() - startedAt,
          outcome: 'succeeded',
        });
        return value;
      } catch (error) {
        const code = runnerErrorCode(error);
        await recordRunSafe({
          ...base,
          tier,
          durationMs: now() - startedAt,
          outcome: 'failed',
          errorCode: code,
          degradedReason: degradedReasonForError(code),
        });
        throw error;
      }
    }

    if (decision.action === 'skip') {
      const marker = {
        degraded: true,
        action: 'skipped' as const,
        tier,
        reason: decision.reason,
        usage: decision.usage,
        budget: decision.budget,
      };
      await recordDecision(job, 'skipped', {
        action: 'budget_skip',
        actor: 'cost_guard',
        tier,
        reason: decision.reason,
        usage: decision.usage,
        budget: decision.budget,
      });
      log.warn(
        { event: 'agent_job.budget_skip', jobId: job.id, jobKind: job.kind, tier, reason: decision.reason },
        'Skipping a lite job: the monthly AI budget is exhausted',
      );
      await recordRunSafe({
        ...base,
        tier,
        tokens: 0,
        durationMs: now() - startedAt,
        outcome: 'degraded',
        degradedReason: decision.reason,
        degradedAction: 'skipped',
      });
      return { result: marker, costTokens: 0 };
    }

    // Medium: defer to the next budget window without burning a retry attempt.
    const resumeAt = nextMonthStart(now());
    const followUp = await enqueue(
      job.kind,
      { ...payloadOf(job), deferred_from: job.id },
      {
        userId: job.userId,
        runAt: resumeAt,
        priority: job.priority,
        maxAttempts: job.maxAttempts,
        idempotencyKey: `budget-defer:${job.id}:${monthKey(resumeAt)}`,
      },
    );
    const marker = {
      degraded: true,
      action: 'deferred' as const,
      tier,
      reason: decision.reason,
      resumeAt: resumeAt.toISOString(),
      deferredJobId: followUp.id,
    };
    await recordDecision(job, 'deferred', {
      action: 'budget_defer',
      actor: 'cost_guard',
      tier,
      reason: decision.reason,
      resumeAt: marker.resumeAt,
      deferredJobId: marker.deferredJobId,
    });
    log.warn(
      { event: 'agent_job.budget_defer', jobId: job.id, jobKind: job.kind, tier, reason: decision.reason },
      'Deferring a medium job: the monthly AI budget is exhausted',
    );
    await recordRunSafe({
      ...base,
      tier,
      tokens: 0,
      durationMs: now() - startedAt,
      outcome: 'degraded',
      degradedReason: decision.reason,
      degradedAction: 'deferred',
    });
    return { result: marker, costTokens: 0 };
  };
}

/**
 * Production executor for the drain route's `execute` seam. Handlers are registered
 * by the Wave 15 routines; until then a claimed job fails with `NO_HANDLER` rather
 * than being silently completed. `routes/agent-worker.ts` belongs to another lane,
 * so the wiring there (or in a later checkbox) is `createAgentWorkerRoutes({ execute:
 * agentJobExecutor })`.
 */
export const agentJobExecutor = createAgentJobExecutor();
