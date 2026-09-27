import type { Context } from 'hono';
import type { User } from '@timemark/shared';
import { findOwnedProfile } from '../services/profile.service.js';

/**
 * 可选的 `?profileId=` 过滤参数（checkbox 69）。
 *
 * - 省略 / 空串 -> null：不添加任何档案谓词 = 「全部档案」，与引入档案前的
 *   API 形状完全一致（老调用方与既存 API key 不受影响）。
 * - 合法且属于当前用户 -> 数字 id。
 * - 非法 / 不存在 / 属于他人 / 已归档 -> 404 Response（存在性与归属一概不泄露）。
 *
 * 用法（每个路由一行 + 一行类型收窄）：
 *   const profileFilter = await parseProfileFilter(c, userId);
 *   if (profileFilter instanceof Response) return profileFilter;
 */
export async function parseProfileFilter(
  c: Context<{ Variables: { user: User } }>,
  userId: number,
): Promise<number | null | Response> {
  const raw = c.req.query('profileId');
  if (raw === undefined || raw === '') return null;

  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, error: '档案不存在' }, 404);
  }

  const owned = await findOwnedProfile(userId, id);
  if (!owned) {
    return c.json({ success: false, error: '档案不存在' }, 404);
  }
  return id;
}
