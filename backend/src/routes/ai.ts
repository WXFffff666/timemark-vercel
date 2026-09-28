import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { getAiStatus } from '../services/ai/gateway.js';
import type { User } from '@timemark/shared';

const aiRoutes = new Hono<{ Variables: { user: User } }>();

aiRoutes.use('*', authMiddleware);

/**
 * checkbox 98: which AI provider resolves right now (`enabled:false` when no
 * `AI_*` env is set). The payload contains hostnames and model names only -
 * never an API key and never a full base URL.
 */
aiRoutes.get('/status', (c) => c.json({ success: true, data: getAiStatus() }));

export default aiRoutes;
