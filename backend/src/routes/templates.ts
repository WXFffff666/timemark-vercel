import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { formatZodError } from '@timemark/shared';
import {
  TEMPLATE_STEP_KINDS,
  TemplateStepError,
  createTemplate,
  deleteTemplate,
  getTemplate,
  instantiateTemplate,
  listTemplates,
  seedDefaultTemplates,
} from '../services/agent/template.service.js';

/**
 * 例行模板 API（task 140）。
 *
 * 约定与 /api/habits、/api/tags 一致：`new Hono<{Variables:{user:User}}>()` +
 * `use('*', authMiddleware)`；「不存在」与「他人的行」都是 404。
 *
 * 路由顺序：/seed 必须注册在 /:id 之前。
 * 挂载（index.ts 由集成方维护）：app.route('/api/templates', templatesRoutes);
 */
const templates = new Hono<{ Variables: { user: User } }>();
templates.use('*', authMiddleware);

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function invalid(c: Context, error: z.ZodError) {
  return c.json(
    { success: false, error: formatZodError(error), details: z.flattenError(error) },
    400,
  );
}

const reminderSchema = z.object({
  enabled: z.boolean().optional(),
  daysBeforeList: z.array(z.number().int().min(0).max(3650)).max(20).optional(),
  reminderTimes: z.array(z.string().regex(HM_RE)).max(10).optional(),
  channels: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  emailRecipients: z.array(z.string().trim().regex(/^[^@\s]+@[^@\s]+$/).max(200)).max(20).optional(),
});

const recurringSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).optional(),
  endType: z.enum(['never', 'count', 'date']).optional(),
  endCount: z.number().int().min(1).max(365).optional(),
  endDate: z.string().regex(YMD_RE).optional(),
});

const habitSpecSchema = z.object({
  icon: z.string().max(40).nullable().optional(),
  targetPerPeriod: z.number().int().min(1).max(100).optional(),
  period: z.enum(['day', 'week']).optional(),
  scheduleDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  reminderTimes: z.array(z.string().regex(HM_RE)).max(10).optional(),
  color: z.string().max(40).nullable().optional(),
});

const maintenanceSpecSchema = z.object({
  assetKind: z.string().trim().min(1).max(40).optional(),
  intervalDays: z.number().int().min(1).max(3650).optional(),
  intervalUsage: z.number().min(0).optional(),
  usageUnit: z.string().trim().max(40).optional(),
  notes: z.string().max(1000).optional(),
});

const stepSchema = z.object({
  kind: z.enum(TEMPLATE_STEP_KINDS),
  title: z.string().trim().min(1).max(200),
  position: z.number().int().min(0).max(999).optional(),
  profileId: z.number().int().positive().nullable().optional(),
  dateOffsetDays: z.number().int().min(-3650).max(3650).optional(),
  eventType: z.string().trim().min(1).max(40).optional(),
  calendarType: z.enum(['gregorian', 'lunar']).optional(),
  reminder: reminderSchema.optional(),
  recurring: recurringSchema.optional(),
  habitId: z.number().int().positive().optional(),
  habit: habitSpecSchema.optional(),
  maintenancePlanId: z.number().int().positive().optional(),
  maintenance: maintenanceSpecSchema.optional(),
});

const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  steps: z.array(stepSchema).min(1).max(50),
});

const instantiateSchema = z.object({
  slot: z.string().trim().min(1).max(64).optional(),
  anchorDate: z.string().regex(YMD_RE).optional(),
  profileId: z.number().int().positive().optional(),
});

templates.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const data = await listTemplates(userId);
  return c.json({ success: true, data });
});

// 内置模板幂等植入；必须早于 /:id 注册
templates.post('/seed', async (c) => {
  const userId = Number(c.get('user').id);
  const data = await seedDefaultTemplates(userId);
  return c.json({ success: true, data });
});

templates.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createTemplateSchema.safeParse(body);
  if (!parsed.success) return invalid(c, parsed.error);
  const data = await createTemplate(userId, parsed.data);
  return c.json({ success: true, data }, 201);
});

templates.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);
  const data = await getTemplate(userId, id);
  if (!data) return c.json({ success: false, error: '模板不存在' }, 404);
  return c.json({ success: true, data });
});

templates.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);
  const deleted = await deleteTemplate(userId, id);
  if (!deleted) return c.json({ success: false, error: '模板不存在' }, 404);
  return c.json({ success: true });
});

templates.post('/:id/instantiate', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = instantiateSchema.safeParse(body ?? {});
  if (!parsed.success) return invalid(c, parsed.error);

  try {
    const result = await instantiateTemplate(userId, id, parsed.data);
    switch (result.status) {
      case 'not_found':
        return c.json({ success: false, error: '模板不存在' }, 404);
      case 'invalid_anchor':
        return c.json({ success: false, error: 'anchorDate 不是有效日期' }, 400);
      case 'already_instantiated':
        // 双击/重放：该 slot 已有实例，未创建任何新条目。
        return c.json({ success: true, data: { ...result, alreadyInstantiated: true } }, 200);
      case 'ok':
        return c.json({ success: true, data: { ...result, alreadyInstantiated: false } }, 201);
    }
  } catch (error) {
    if (error instanceof TemplateStepError) {
      return c.json(
        {
          success: false,
          error: error.message,
          details: { stepId: error.stepId, stepKind: error.stepKind },
        },
        400,
      );
    }
    throw error;
  }
});

export default templates;
