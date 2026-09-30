/**
 * 162 - extension point proving the AI layer is OFF.
 *
 * Mount (integrator owns backend/src/index.ts):
 *   app.route('/api/ai-status', aiStatusRoutes);
 * `GET /api/ai-status/off-verify` returns the structured proof.
 */
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { verifyAiOff } from '../services/ai/ai-off-verifier.service.js';

const aiStatusRoutes = new Hono();

aiStatusRoutes.use('*', authMiddleware);

aiStatusRoutes.get('/off-verify', async (c) => {
  const data = await verifyAiOff();
  return c.json({ success: true, data });
});

export default aiStatusRoutes;
