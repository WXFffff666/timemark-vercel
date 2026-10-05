import { Hono, type Context } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  AUDIT_ACTIONS,
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  listAuditEvents,
  readUndoWindowMs,
  undoAuditEvent,
  type AuditAction,
} from '../services/agent/audit.service.js';

/**
 * Task 142 API — the audit trail of destructive changes (delete / merge /
 * bulk_edit / archive) and the exactly-once undo.
 *
 * GET  /api/audit             paginated audit rows (limit/offset/action/entityKind)
 * POST /api/audit/:id/undo    restores the recorded snapshot; a second undo
 *                             (or one past the configured window) -> 409.
 *
 * The integrator mounts this router at `/api/audit` (see the 135-142 note).
 */
const audit = new Hono<{ Variables: { user: User } }>();
audit.use('*', authMiddleware);

function parseAuditId(c: Context): number | null {
  const parsed = Number(c.req.param('id'));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// GET /api/audit?limit=20&offset=0&action=delete&entityKind=event
audit.get('/', async (c) => {
  const userId = Number(c.get('user').id);

  const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, AUDIT_LIST_MAX_LIMIT)
    : AUDIT_LIST_DEFAULT_LIMIT;
  const offsetRaw = Number.parseInt(c.req.query('offset') ?? '', 10);
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const actionRaw = c.req.query('action');
  if (actionRaw && !(AUDIT_ACTIONS as readonly string[]).includes(actionRaw)) {
    return c.json({ success: false, code: 'invalid_request', error: '无效的 action 过滤值' }, 400);
  }
  const action = actionRaw ? (actionRaw as AuditAction) : null;

  const entityKind = c.req.query('entityKind')?.trim() || null;
  if (entityKind && entityKind.length > 64) {
    return c.json({ success: false, code: 'invalid_request', error: '无效的 entityKind 过滤值' }, 400);
  }

  // v2.27：时间范围参数（非法值忽略，不报错——筛选是可选增强）
  const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('from') ?? '') ? c.req.query('from') as string : undefined;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('to') ?? '') ? c.req.query('to') as string : undefined;
  const page = await listAuditEvents(userId, { limit, offset, action, entityKind, from, to });
  return c.json({
    success: true,
    data: {
      ...page,
      undoWindowMs: readUndoWindowMs(),
      note: '撤销仅在配置的时间窗口内可用，且每条记录只能撤销一次',
    },
  });
});

// POST /api/audit/:id/undo — restores the snapshot EXACTLY ONCE; second -> 409.
audit.post('/:id/undo', async (c) => {
  const auditId = parseAuditId(c);
  if (auditId === null) {
    return c.json({ success: false, code: 'invalid_request', error: '无效的审计记录 ID' }, 400);
  }

  const outcome = await undoAuditEvent(Number(c.get('user').id), auditId);
  switch (outcome.status) {
    case 'restored':
      return c.json({ success: true, data: outcome });
    case 'not_found':
      return c.json({ success: false, code: 'not_found', error: '审计记录不存在' }, 404);
    case 'already_undone':
      return c.json({ success: false, code: 'already_undone', error: '该变更已被撤销（每条记录仅可撤销一次）' }, 409);
    case 'undo_expired':
      return c.json({ success: false, code: 'undo_expired', error: '撤销窗口已过期，无法恢复' }, 409);
    case 'nothing_to_undo':
      return c.json({ success: false, code: 'nothing_to_undo', error: '该审计记录没有可恢复的快照' }, 409);
  }
});

export default audit;
