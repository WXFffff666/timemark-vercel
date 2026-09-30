import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  DATA_HEALTH_KINDS,
  getDataHealthReport,
  repairDataHealth,
  type DataHealthKind,
} from '../services/data-health.service.js';

/**
 * Task 137: data-health API, mounted at `/api/data-health`.
 *
 *   GET  /api/data-health                 -> report (counts + examples, read-only)
 *   POST /api/data-health/repair/:kind    -> one-click repair (idempotent, audited)
 *
 * A destructive repair (one that deletes rows, e.g. orphan tag links or duplicate
 * contacts) answers 409 `confirmation_required` unless the body carries `{ "confirm": true }`.
 * Every query is user-scoped inside the service.
 */
const dataHealth = new Hono<{ Variables: { user: User } }>();
dataHealth.use('*', authMiddleware);

dataHealth.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const report = await getDataHealthReport(userId);
  return c.json({ success: true, data: report });
});

dataHealth.post('/repair/:kind', async (c) => {
  const userId = Number(c.get('user').id);
  const kind = c.req.param('kind') as DataHealthKind;
  if (!(DATA_HEALTH_KINDS as readonly string[]).includes(kind)) {
    return c.json({ success: false, error: '未知的数据健康项' }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };
  const confirm = body.confirm === true;

  const outcome = await repairDataHealth(userId, kind, { confirm });
  if (outcome.status === 'confirmation_required') {
    return c.json(
      { success: false, error: 'confirmation_required', code: 'confirmation_required', hint: outcome.hint },
      409,
    );
  }
  return c.json({ success: true, data: outcome.result });
});

export default dataHealth;
