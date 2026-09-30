import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { askQuestion, getAskCatalogue } from '../services/ask.service.js';

/**
 * 确定性 Ask 面板 API（task 133）。
 *
 * - `GET /api/ask/catalogue`：意图目录（可以问什么 + 示例问法 + 模板），前端原样渲染。
 * - `POST /api/ask`：`{ question, params? }` → 模板化回答 / 追问 / 目录 / 未找到。
 *
 * 约定与 /api/search、/api/habits 一致：`new Hono<{Variables:{user:User}}>()`
 * + `use('*', authMiddleware)`。映射与作答全部离线：零外发网络请求，无 AI。
 * 未识别的问题返回目录，绝不猜测答案。
 */
const ask = new Hono<{ Variables: { user: User } }>();
ask.use('*', authMiddleware);

const askBodySchema = z.object({
  question: z.string().trim().min(1).max(300),
  /** 歧义追问后的回填（如 { kind: 'bill' }）；可带 entity / days / q。 */
  params: z.record(z.string(), z.string()).optional(),
});

ask.get('/catalogue', (c) => {
  return c.json({ success: true, data: getAskCatalogue() });
});

ask.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = askBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: '参数无效：question 必须为 1-300 字符' }, 400);
  }
  const data = await askQuestion(userId, parsed.data.question, parsed.data.params ?? {});
  return c.json({ success: true, data });
});

export default ask;
