import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { createProfileSchema, formatZodError, updateProfileSchema, setProfileAccountsSchema } from '@timemark/shared';
import {
  createProfile,
  deleteProfile,
  findOwnedProfile,
  getProfile,
  listProfileAccountIds,
  listProfiles,
  setProfileAccountIds,
  updateProfile,
} from '../services/profile.service.js';

/**
 * 家庭多档案 API（D5，checkbox 68/69）。
 *
 * 约定与 /api/expiry、/api/habits 一致：`new Hono<{Variables:{user:User}}>()` +
 * `use('*', authMiddleware)`；「不存在」与「他人的行」都是 404（防存在性泄露）。
 *
 * - 每个用户恰好一个 kind='self' 的「我」档案（v41 迁移创建）：不可新建、不可删除、
 *   类别不可修改；其余 family/pet 档案可自由 CRUD。
 * - 删除档案只把关联数据的 profile_id 置 NULL（ON DELETE SET NULL），绝不删数据。
 * - 档案是查询过滤的来源（其它路由的 `?profileId=`），本身不携带任何通知路由语义
 *   （通知路由是 checkbox 70）。
 */
const profiles = new Hono<{ Variables: { user: User } }>();
profiles.use('*', authMiddleware);

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

profiles.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const activeRaw = c.req.query('active');
  let active: boolean | undefined;
  if (activeRaw === 'true') active = true;
  else if (activeRaw === 'false') active = false;
  else if (activeRaw !== undefined && activeRaw !== '') {
    return c.json({ success: false, error: "active 只能为 'true' 或 'false'" }, 400);
  }

  const data = await listProfiles(userId, { active });
  return c.json({ success: true, data });
});

profiles.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createProfileSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const profile = await createProfile(userId, parsed.data);
  return c.json({ success: true, data: profile }, 201);
});

profiles.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const profile = await getProfile(userId, id);
  if (!profile) return c.json({ success: false, error: '档案不存在' }, 404);
  return c.json({ success: true, data: profile });
});

profiles.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const existing = await getProfile(userId, id);
  if (!existing) return c.json({ success: false, error: '档案不存在' }, 404);
  if (existing.kind === 'self' && parsed.data.kind !== undefined) {
    return c.json({ success: false, error: '默认档案「我」的类别不可修改' }, 400);
  }

  const updated = await updateProfile(userId, id, parsed.data);
  if (!updated) return c.json({ success: false, error: '档案不存在' }, 404);
  return c.json({ success: true, data: updated });
});

profiles.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const result = await deleteProfile(userId, id);
  if (result === 'not_found') return c.json({ success: false, error: '档案不存在' }, 404);
  if (result === 'is_self') return c.json({ success: false, error: '默认档案「我」不可删除' }, 400);
  return c.json({ success: true });
});

/**
 * 档案级通知路由（checkbox 70）：该档案的提醒走哪些通知账户。
 * 读取空数组 = 未配置路由 = 回退「全部启用账户」（与引入路由前的行为一致）。
 */
profiles.get('/:id/accounts', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  // 归属 + 启用状态校验：他人的 / 已归档的档案一律 404（与 ?profileId= 过滤器一致）。
  const owned = await findOwnedProfile(userId, id);
  if (!owned) return c.json({ success: false, error: '档案不存在' }, 404);

  const accountIds = await listProfileAccountIds(userId, id);
  return c.json({ success: true, data: { profile_id: id, account_ids: accountIds } });
});

profiles.put('/:id/accounts', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = setProfileAccountsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const result = await setProfileAccountIds(userId, id, parsed.data.accountIds);
  if (result.status === 'profile_not_found') {
    return c.json({ success: false, error: '档案不存在' }, 404);
  }
  if (result.status === 'invalid_account') {
    return c.json({ success: false, error: `通知账户不存在或不属于当前用户（${result.accountId}）` }, 400);
  }
  return c.json({ success: true, data: { profile_id: id, account_ids: result.accountIds } });
});

export default profiles;
