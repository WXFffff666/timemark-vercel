import { Hono, type Context, type Next } from 'hono';
import { timingSafeEqual } from 'crypto';
import { getCronSecret } from '../utils/heartbeat.js';
import { createLogger } from '../utils/logger.js';
import {
  getSchedulerStatus,
  pumpSchedulerChain,
  type SchedulerPumpResult,
  type SchedulerStatus,
} from '../services/agent/scheduler.workflow.js';

/**
 * Checkbox 115: the scheduling-loop endpoint + trigger topology.
 *
 *   GET  /api/agent/scheduler/start   -> cheap liveness probe (no auth, no DB, no tick)
 *   POST /api/agent/scheduler/start   -> CRON_SECRET-guarded single tick (idempotent)
 *   GET  /api/agent/scheduler/status  -> CRON_SECRET-guarded chain status
 *
 * Trigger topology (mirrors /api/agent/worker/drain, checkbox 114):
 *  - cron-job.org calls POST /start every 10 minutes with
 *    `Authorization: Bearer <CRON_SECRET>` (plus the `X-Requested-With:
 *    XMLHttpRequest` marker the CSRF guard requires for a machine POST that
 *    carries no Origin/Referer).
 *  - POST is idempotent by construction: pumpSchedulerChain() executes at most ONE
 *    tick per call, claims the tick with a compare-and-swap on last_tick_at, and
 *    the routine advance itself is a CAS plus an idempotency-key dedupe — so a
 *    duplicated or retried callback can never double-run a routine.
 */

const log = createLogger('agent-scheduler');

/** Runtime seams; tests inject all three, production uses the real singletons. */
export interface AgentSchedulerRouteDeps {
  /** One bounded tick; defaults to {@link pumpSchedulerChain}. */
  pumpSchedulerChain?: () => Promise<SchedulerPumpResult>;
  /** Chain status read; defaults to {@link getSchedulerStatus}. */
  getSchedulerStatus?: () => Promise<SchedulerStatus>;
  /** Secret source; defaults to {@link getCronSecret} (CRONSECRET / CRON_SECRET). */
  getCronSecret?: () => string | undefined;
}

/** Timing-safe `Authorization: Bearer <secret>` comparison (agent-worker precedent). */
function hasValidSchedulerCredential(authorization: string | undefined, secret: string): boolean {
  if (!authorization) return false;
  const actual = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${secret}`);
  // Length is not secret; the byte comparison itself is constant-time.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function schedulerGuard(getSecret: () => string | undefined) {
  return async (c: Context, next: Next) => {
    const secret = getSecret();
    // No configured credential keeps the endpoint closed, not open (mirrors cron.ts).
    if (!secret) {
      return c.json({ error: 'CRON_SECRET / CRONSECRET not configured' }, 500);
    }
    if (!hasValidSchedulerCredential(c.req.header('Authorization'), secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  };
}

/** Build the scheduler router. Tests inject the pump / status / secret seams. */
export function createAgentSchedulerRoutes(deps: AgentSchedulerRouteDeps = {}): Hono {
  const pump = deps.pumpSchedulerChain ?? pumpSchedulerChain;
  const status = deps.getSchedulerStatus ?? getSchedulerStatus;
  const getSecret = deps.getCronSecret ?? getCronSecret;
  const routes = new Hono();

  // Cheap liveness probe: NO auth, NO database, NO tick. Safe for uptime monitors.
  routes.get('/start', (c) =>
    c.json({ status: 'ok', endpoint: '/api/agent/scheduler/start', method: 'POST' }),
  );

  routes.post('/start', schedulerGuard(getSecret), async (c) => {
    try {
      const result = await pump();
      return c.json(result);
    } catch (error) {
      // Infra failure (e.g. the DB is unreachable): surfaced as 500, never swallowed.
      log.error({ event: 'agent_scheduler.pump_failed', err: error }, 'pumpSchedulerChain threw');
      return c.json({ error: 'pump_failed' }, 500);
    }
  });

  routes.get('/status', schedulerGuard(getSecret), async (c) => {
    try {
      return c.json(await status());
    } catch (error) {
      log.error({ event: 'agent_scheduler.status_failed', err: error }, 'getSchedulerStatus threw');
      return c.json({ error: 'status_failed' }, 500);
    }
  });

  return routes;
}

/** Production singleton mounted at `/api/agent/scheduler` (see backend/src/index.ts). */
const agentSchedulerRoutes = createAgentSchedulerRoutes();

export default agentSchedulerRoutes;
