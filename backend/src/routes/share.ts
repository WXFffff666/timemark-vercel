/**
 * Share routes (task 148) - default-exported Hono router.
 *
 *   GET    /api/share/:token   PUBLIC, token-scoped, read-only
 *   GET    /api/share          (auth) list this user's tokens
 *   POST   /api/share          (auth) create a scoped token (raw value shown once)
 *   DELETE /api/share/:id      (auth) revoke a token
 *
 * The public read is registered BEFORE the `use('*', authMiddleware)` guard (the
 * same ordering trick used by the existing `features/share` route): its handler
 * returns first, so the auth middleware never runs for it. It is rate-limited per
 * IP + path. The management routes below the guard require a session.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { rateLimit } from '../middleware/rate-limit.js';
import type { User } from '@timemark/shared';
import { formatZodError } from '@timemark/shared';
import {
  ShareNotFoundError,
  SharePasscodeInvalidError,
  SharePasscodeRequiredError,
  ShareScopeError,
  createShareToken,
  listShareTokens,
  resolveShareToken,
  revokeShareToken,
} from '../services/agent/share.service.js';

const share = new Hono<{ Variables: { user: User } }>();

const MAX_TOKEN_CHARS = 512;
/** 60 reads / minute / IP for the public page. */
const shareReadRateLimit = rateLimit(60, 60_000);

const createShareSchema = z
  .object({
    scopeType: z.enum(['profile', 'tag']),
    profileId: z.number().int().positive().optional(),
    tag: z.string().trim().min(1).max(100).optional(),
    label: z.string().trim().max(100).nullish(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
    passcode: z.string().trim().min(4).max(64).nullish(),
  })
  .strict();

// ---- PUBLIC read (must stay above the auth guard) -------------------------
share.get('/:token', shareReadRateLimit, async (c) => {
  const token = c.req.param('token');
  if (!token || token.length > MAX_TOKEN_CHARS) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const passcode = c.req.header('X-Share-Passcode') ?? c.req.query('passcode') ?? null;

  try {
    const { view } = await resolveShareToken(token, passcode);
    return c.json({ success: true, data: view });
  } catch (error) {
    if (error instanceof SharePasscodeRequiredError || error instanceof SharePasscodeInvalidError) {
      const required = error instanceof SharePasscodeRequiredError;
      return c.json(
        {
          success: false,
          error: required ? '需要访问密码' : '访问密码错误',
          code: required ? 'passcode_required' : 'passcode_invalid',
        },
        401,
      );
    }
    if (error instanceof ShareNotFoundError) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    throw error;
  }
});

// ---- AUTHENTICATED management ---------------------------------------------
share.use('*', authMiddleware);

share.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const data = await listShareTokens(userId);
  return c.json({ success: true, data });
});

share.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => null);
  const parsed = createShareSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const { token, view } = await createShareToken(userId, parsed.data);
    return c.json({ success: true, data: { ...view, token } }, 201);
  } catch (error) {
    if (error instanceof ShareScopeError) {
      return c.json({ success: false, error: error.message }, 400);
    }
    throw error;
  }
});

share.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, error: '无效的 ID' }, 400);
  }
  const revoked = await revokeShareToken(userId, id);
  if (!revoked) return c.json({ success: false, error: '分享不存在或已撤销' }, 404);
  return c.json({ success: true });
});

export default share;
