/**
 * 143 - admin routes for the post-migration self-check and repair.
 *
 * Mount (integrator owns backend/src/index.ts):
 *   app.route('/api/admin/migration-selfcheck', migrationSelfcheckRoutes);
 * (same auth convention as /api/admin/agent: session authMiddleware).
 */
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  repairMigrationFindings,
  runMigrationSelfCheck,
} from '../services/agent/migration-selfcheck.service.js';

const migrationSelfcheckRoutes = new Hono();

migrationSelfcheckRoutes.use('*', authMiddleware);

/** GET / -> structured findings (read-only). */
migrationSelfcheckRoutes.get('/', async (c) => {
  const data = await runMigrationSelfCheck();
  return c.json({ success: true, data });
});

/** POST /repair -> idempotent repair of repairable findings + fresh check. */
migrationSelfcheckRoutes.post('/repair', async (c) => {
  const data = await repairMigrationFindings();
  return c.json({ success: true, data });
});

export default migrationSelfcheckRoutes;
