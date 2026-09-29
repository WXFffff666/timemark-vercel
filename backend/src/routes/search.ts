import { Hono } from 'hono';
import { z } from 'zod';
import { formatZodError } from '@timemark/shared';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { EmbeddingsError, isEmbeddingsEnabled } from '../services/ai/embeddings.js';
import { searchLocal, semanticSearch } from '../services/search.service.js';

/**
 * Search over the user's own data (checkbox 106).
 *
 * `POST /` is the DEFAULT and the only path that ever runs unconfigured: trigram GIN
 * search via `pg_trgm`, zero external calls, CJK substring capable. `POST /semantic` is
 * the opt-in accelerator (pgvector + an embedding provider); with `EMBEDDINGS_ENABLED`
 * unset it answers 503 without contacting anything.
 *
 * Conventions match /api/patterns and /api/habits: `new Hono<{Variables:{user:User}}>()`
 * + `use('*', authMiddleware)`.
 */
const search = new Hono<{ Variables: { user: User } }>();
search.use('*', authMiddleware);

const searchBodySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(50).optional(),
});

search.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = searchBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error) }, 400);
  }
  const q = parsed.data.q.trim();
  if (q === '') {
    return c.json({ success: false, error: '搜索内容不能为空' }, 400);
  }
  const results = await searchLocal(Number(user.id), q, { limit: parsed.data.limit });
  return c.json({ success: true, data: { mode: 'trigram', query: q, results } });
});

search.post('/semantic', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = searchBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error) }, 400);
  }
  if (!isEmbeddingsEnabled()) {
    return c.json(
      {
        success: false,
        code: 'EMBEDDINGS_DISABLED',
        error:
          '语义搜索未启用：设置 EMBEDDINGS_ENABLED=true 并将 EMBEDDINGS_BASE_URL 指向一个 OpenAI 兼容的嵌入服务（默认本地 Ollama nomic-embed-text）',
      },
      503,
    );
  }
  const q = parsed.data.q.trim();
  if (q === '') {
    return c.json({ success: false, error: '搜索内容不能为空' }, 400);
  }
  try {
    const results = await semanticSearch(Number(user.id), q, { limit: parsed.data.limit });
    return c.json({ success: true, data: { mode: 'semantic', query: q, results } });
  } catch (error) {
    if (error instanceof EmbeddingsError) {
      // A model config that cannot fit the vector column is the caller's 400; provider
      // outages / network problems stay 503 so the client can retry later.
      const status = error.code === 'EMBEDDINGS_DIMS' ? 400 : 503;
      return c.json({ success: false, code: error.code, error: error.message }, status);
    }
    throw error;
  }
});

export default search;
