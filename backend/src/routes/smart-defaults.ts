import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { deriveSmartDefaults } from '../services/agent/smart-defaults.service.js';

/**
 * 智能默认值 API（task 141）。
 *
 * GET /api/smart-defaults?kind=meeting&keyword=周会
 *   - kind     可选：事件类型过滤（省略 = 全部事件）
 *   - keyword  可选：标题关键词，用于标签提示（也接受 title= 别名）
 *
 * 纯历史统计（众数/中位数），无模型调用；每个默认值都带 source/statistic/confidence/sampleSize。
 * 挂载（index.ts 由集成方维护）：app.route('/api/smart-defaults', smartDefaultsRoutes);
 */
const smartDefaults = new Hono<{ Variables: { user: User } }>();
smartDefaults.use('*', authMiddleware);

const MAX_KIND_LENGTH = 64;
const MAX_KEYWORD_LENGTH = 100;

smartDefaults.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const kind = (c.req.query('kind') ?? '').trim();
  const keyword = (c.req.query('keyword') ?? c.req.query('title') ?? '').trim();

  if (kind.length > MAX_KIND_LENGTH) {
    return c.json({ success: false, error: `kind 长度不能超过 ${MAX_KIND_LENGTH}` }, 400);
  }
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    return c.json({ success: false, error: `keyword 长度不能超过 ${MAX_KEYWORD_LENGTH}` }, 400);
  }

  const data = await deriveSmartDefaults(userId, {
    kind: kind || null,
    keyword: keyword || null,
  });
  return c.json({ success: true, data });
});

export default smartDefaults;
