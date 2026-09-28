import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  PATTERN_KINDS,
  listPatterns,
  type PatternKind,
} from '../services/patterns.service.js';

/**
 * Deterministic behavioural-pattern API (checkbox 105).
 *
 * Read-only projection of `user_patterns`, the table written by the nightly
 * `recomputeAllUserPatterns()` in daily-maintenance. The rows below
 * `SURFACED_MIN_CONFIDENCE` (0.5) are deliberately NOT returned: they are stored so the
 * miner can grow them with more evidence, not so they can be shown as preferences.
 *
 * Conventions match /api/habits and /api/maintenance: `new Hono<{Variables:{user:User}}>()`
 * + `use('*', authMiddleware)`; no pagination (one row per kind+key).
 */
const patterns = new Hono<{ Variables: { user: User } }>();
patterns.use('*', authMiddleware);

patterns.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const kindRaw = c.req.query('kind');
  if (kindRaw !== undefined && kindRaw !== '' && !(PATTERN_KINDS as readonly string[]).includes(kindRaw)) {
    return c.json({ success: false, error: `未知的模式类型: ${kindRaw}` }, 400);
  }
  const kind = kindRaw ? (kindRaw as PatternKind) : undefined;
  const data = await listPatterns(userId, kind);
  return c.json({ success: true, data });
});

export default patterns;
