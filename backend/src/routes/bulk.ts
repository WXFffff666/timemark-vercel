import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { applyBulk, validateBulkRequest } from '../services/bulk.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('bulk-route');

const bulk = new Hono<{ Variables: { user: User } }>();

// Owner-scoped: every write filters on user_id and the tag helpers re-check ownership.
bulk.use('*', authMiddleware);

/**
 * POST /api/bulk
 * Body: { action, items: [{ entityType, ids }], params? }
 *
 * Validation is all-or-nothing (unknown action/entity type/id shape/over-cap -> 400);
 * the response reports each id's outcome so partial success is visible and honest.
 */
bulk.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => null);
  const validation = validateBulkRequest(body);
  if (!validation.ok) {
    return c.json({ success: false, error: validation.message, code: validation.code }, 400);
  }
  try {
    const outcome = await applyBulk(userId, validation.request);
    return c.json({ success: true, data: outcome });
  } catch (error) {
    log.error({ err: error }, 'bulk action failed');
    return c.json({ success: false, error: '批量操作失败，请稍后重试', code: 'bulk_failed' }, 500);
  }
});

export default bulk;
