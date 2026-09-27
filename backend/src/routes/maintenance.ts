import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  createMaintenancePlanSchema,
  formatZodError,
  recordMaintenanceLogSchema,
  updateMaintenancePlanSchema,
  ASSET_KINDS,
  NO_INTERVAL_MESSAGE,
} from '@timemark/shared';
import {
  createMaintenancePlan,
  deleteMaintenancePlan,
  getMaintenancePlan,
  listMaintenanceLogs,
  listMaintenancePlans,
  recordMaintenanceLog,
  updateMaintenancePlan,
  type MaintenancePlanFilters,
} from '../services/maintenance.service.js';
import { parseProfileFilter } from './profile-filter.js';

/**
 * 保养计划 API（D12，todo 50）。
 *
 * 约定与 /api/expiry、/api/inventory 一致：`new Hono<{Variables:{user:User}}>()`
 * + `use('*', authMiddleware)`，分页返回 `{ success, data, pagination }`。
 * 全部查询按 user_id 限定；「不存在」与「他人的行」都是 404。
 * 不读取车辆里程表：current_usage 只来自用户输入或保养记录。
 */
const maintenance = new Hono<{ Variables: { user: User } }>();
maintenance.use('*', authMiddleware);

function parsePage(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

maintenance.get('/', async (c) => {
  const userId = Number(c.get('user').id);

  const kindRaw = c.req.query('assetKind');
  if (kindRaw && !(ASSET_KINDS as readonly string[]).includes(kindRaw)) {
    return c.json({ success: false, error: `未知的资产类型: ${kindRaw}` }, 400);
  }
  const activeRaw = c.req.query('active');
  let active: boolean | undefined;
  if (activeRaw === 'true') active = true;
  else if (activeRaw === 'false') active = false;
  else if (activeRaw !== undefined && activeRaw !== '') {
    return c.json({ success: false, error: "active 只能为 'true' 或 'false'" }, 400);
  }

  // 可选档案过滤（checkbox 69）：省略 = 全部档案；他人的档案一律 404。
  const profileFilter = await parseProfileFilter(c, userId);
  if (profileFilter instanceof Response) return profileFilter;

  const filters: MaintenancePlanFilters = {
    assetKind: kindRaw,
    active,
    q: c.req.query('q') || undefined,
    profileId: profileFilter,
  };
  const page = parsePage(c.req.query('page'));
  const limit = parseLimit(c.req.query('limit'));

  const { items, total } = await listMaintenancePlans(userId, filters, page, limit);
  return c.json({
    success: true,
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

maintenance.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createMaintenancePlanSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }
  const plan = await createMaintenancePlan(userId, parsed.data);
  return c.json({ success: true, data: plan }, 201);
});

maintenance.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const plan = await getMaintenancePlan(userId, id);
  if (!plan) return c.json({ success: false, error: '保养计划不存在' }, 404);
  return c.json({ success: true, data: plan });
});

maintenance.get('/:id/logs', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const logs = await listMaintenanceLogs(userId, id);
  if (logs === null) return c.json({ success: false, error: '保养计划不存在' }, 404);
  return c.json({ success: true, data: logs });
});

maintenance.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateMaintenancePlanSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const result = await updateMaintenancePlan(userId, id, parsed.data);
  if (result.status === 'not_found') {
    return c.json({ success: false, error: '保养计划不存在' }, 404);
  }
  if (result.status === 'no_interval') {
    // 改完两个间隔都为 null —— 计划将无法计算下次保养，明确拒绝
    return c.json({ success: false, error: NO_INTERVAL_MESSAGE }, 400);
  }
  return c.json({ success: true, data: result.plan });
});

maintenance.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const deleted = await deleteMaintenancePlan(userId, id);
  // 404（而非 403）：他人的行与不存在的行不可区分，避免存在性泄露
  if (!deleted) return c.json({ success: false, error: '保养计划不存在' }, 404);
  return c.json({ success: true });
});

maintenance.post('/:id/log', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = recordMaintenanceLogSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const result = await recordMaintenanceLog(userId, id, parsed.data);
  if (result.status === 'not_found') {
    return c.json({ success: false, error: '保养计划不存在' }, 404);
  }
  if (result.status === 'usage_required') {
    return c.json({
      success: false,
      error: '该计划按用量保养，记录时必须提供 usageAt（本次用量读数）',
      data: result.plan,
    }, 400);
  }
  return c.json({ success: true, data: result.plan, log: result.log }, 201);
});

export default maintenance;
