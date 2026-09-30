import { Hono } from 'hono';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  getAiStatus,
  getAiStatusWithProbe,
  type AiEnv,
  type AiProviderStatus,
  type AiStatus,
} from '../services/ai/gateway.js';
import { getMonthlyUsage, readMonthlyBudget } from '../services/agent/budget.service.js';
import {
  getDegradedRoutines,
  getLastSuccessfulRun,
  isQueueStalled,
  listAgentWorkers,
  readQueueHealth,
  resolveQueueStallMs,
  resolveWorkerStaleMs,
  type AgentWorkerHealth,
  type DegradedRoutine,
  type LastSuccessfulRun,
  type QueueHealth,
} from '../services/agent/run-observability.service.js';

/**
 * Checkbox 130: `GET /api/agent/health` - the single operational snapshot of the
 * background AI, consumed by the frontend degraded-state hook (checkbox 128).
 *
 * Mount path (an integrator inserts this into the FROZEN `backend/src/index.ts`):
 *
 *   app.route('/api/agent/health', agentHealthRoutes);   // BEFORE app.route('/api/agent', agentRoutes)
 *
 * The exact path must be registered before the `/api/agent` sub-app (same pattern as
 * `/api/agent/worker`) so the agent wildcard middleware cannot shadow it.
 *
 * Documented response shape (`data`):
 *
 *   {
 *     generatedAt: ISO string,
 *     stalled: boolean,                       // deliberately stalled queue (see below)
 *     queue:  { depth, oldestQueuedAgeSeconds, oldestQueuedAt, stalled, stallThresholdSeconds },
 *     worker: { online, staleAfterSeconds, lastSeenAt, lastSeenAgeSeconds, workers: [...] },
 *     lastSuccessfulRun: { jobId, kind, finishedAt, ageSeconds } | null,
 *     provider: { enabled, activeProvider, probeRan,
 *                 primary|fallback|local: { configured, model, reachable } },
 *     budget: { month, tokens: { limit, used, remaining }, calls: { limit, used, remaining } },
 *     degraded: { count24h, reasons: [...], routines: [...] }
 *   }
 *
 * `stalled` is TRUE only for a deliberately stalled queue: queued work exists AND its
 * oldest item has waited past `AGENT_QUEUE_STALL_MS` (default 15 min).
 *
 * `?probe=1` adds the short provider reachability probe (bounded ~1.5 s); the default
 * response never performs outbound network calls. Never returns API keys, full base
 * URLs, prompt bodies or any credential.
 */

const agentHealth = new Hono<{ Variables: { user: User } }>();

agentHealth.use('*', authMiddleware);

async function safe<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

const EMPTY_QUEUE: QueueHealth = { depth: 0, oldestQueuedAt: null, oldestQueuedAgeMs: null };

function seconds(ms: number | null): number | null {
  return ms === null ? null : Math.max(0, Math.round(ms / 1000));
}

function slot(status: AiProviderStatus): { configured: boolean; model: string | null; reachable: boolean | null } {
  return { configured: status.configured, model: status.model, reachable: status.reachable };
}

function budgetSection(limit: number | null, used: number): { limit: number | null; used: number; remaining: number | null } {
  return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
}

agentHealth.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const env = process.env as AiEnv;
  const probe = c.req.query('probe') === '1';
  const nowMs = Date.now();

  const [queue, workers, lastSuccessfulRun, usage, degradedRoutines] = await Promise.all([
    safe(readQueueHealth(nowMs), EMPTY_QUEUE),
    safe(listAgentWorkers(nowMs), [] as AgentWorkerHealth[]),
    safe(getLastSuccessfulRun(nowMs), null as LastSuccessfulRun | null),
    safe(getMonthlyUsage(userId), { tokens: 0, calls: 0 }),
    safe(getDegradedRoutines(), [] as DegradedRoutine[]),
  ]);

  let provider: AiStatus;
  try {
    provider = probe ? await getAiStatusWithProbe() : getAiStatus();
  } catch {
    provider = getAiStatus();
  }

  const stallMs = resolveQueueStallMs(env);
  const stalled = isQueueStalled(queue.depth, queue.oldestQueuedAgeMs, stallMs);
  const staleMs = resolveWorkerStaleMs(env);
  const onlineWorker = workers.find((worker) => worker.ageMs !== null && worker.ageMs <= staleMs) ?? null;
  const budget = readMonthlyBudget(env);
  const now = new Date(nowMs);
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  return c.json({
    success: true,
    data: {
      generatedAt: now.toISOString(),
      stalled,
      queue: {
        depth: queue.depth,
        oldestQueuedAgeSeconds: seconds(queue.oldestQueuedAgeMs),
        oldestQueuedAt: queue.oldestQueuedAt,
        stalled,
        stallThresholdSeconds: Math.round(stallMs / 1000),
      },
      worker: {
        online: onlineWorker !== null,
        staleAfterSeconds: Math.round(staleMs / 1000),
        lastSeenAt: onlineWorker?.lastSeenAt ?? workers[0]?.lastSeenAt ?? null,
        lastSeenAgeSeconds: seconds(onlineWorker?.ageMs ?? workers[0]?.ageMs ?? null),
        workers: workers.map((worker) => ({
          id: worker.id,
          kind: worker.kind,
          lastSeenAt: worker.lastSeenAt,
          ageSeconds: seconds(worker.ageMs),
        })),
      },
      lastSuccessfulRun: lastSuccessfulRun === null
        ? null
        : {
            jobId: lastSuccessfulRun.jobId,
            kind: lastSuccessfulRun.kind,
            finishedAt: lastSuccessfulRun.finishedAt,
            ageSeconds: seconds(lastSuccessfulRun.ageMs),
          },
      provider: {
        enabled: provider.enabled,
        activeProvider: provider.provider,
        probeRan: probe,
        primary: slot(provider.primary),
        fallback: slot(provider.fallback),
        local: slot(provider.local),
      },
      budget: {
        month,
        tokens: budgetSection(budget.tokens, usage.tokens),
        calls: budgetSection(budget.calls, usage.calls),
      },
      degraded: {
        count24h: degradedRoutines.length,
        reasons: [...new Set(degradedRoutines.map((routine) => routine.reason))],
        routines: degradedRoutines.map((routine) => ({
          routineId: routine.routineId,
          kind: routine.kind,
          name: routine.name,
          reason: routine.reason,
          lastAt: routine.lastAt,
          count: routine.count,
        })),
      },
    },
  });
});

export default agentHealth;
