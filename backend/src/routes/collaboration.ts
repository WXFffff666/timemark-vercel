/**
 * Family collaboration routes (task 160) - default-exported Hono router.
 *
 *   GET    /api/collaboration/guest/:token          PUBLIC, token-scoped, read-only
 *   POST   /api/collaboration/guest/:token/comments PUBLIC; commenter | editor
 *   POST   /api/collaboration/guest/:token/events   PUBLIC; editor only (viewer -> 403)
 *   GET    /api/collaboration/invites               (auth) list the owner's invites
 *   POST   /api/collaboration/invites               (auth) create an invite (raw token shown once)
 *   DELETE /api/collaboration/invites/:id           (auth) revoke an invite
 *   GET    /api/collaboration/activity              (auth) collaborator activity feed
 *
 * SINGLE-OWNER, NOT MULTI-TENANT. Guests have no account and no settings; the
 * public handlers above the auth guard can only ever see the scoped surface of
 * the one owner named on the invite. See collaboration.service.ts.
 *
 * The public routes are registered BEFORE `use('*', authMiddleware)` (the same
 * ordering trick used by routes/share.ts): their handlers return first, so the
 * auth middleware never runs for them. They are rate-limited per IP + path.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { rateLimit } from '../middleware/rate-limit.js';
import type { User } from '@timemark/shared';
import { formatZodError } from '@timemark/shared';
import {
  COLLABORATION_ENTITY_TYPES,
  COLLABORATION_ROLES,
  CollaborationForbiddenError,
  CollaborationNotFoundError,
  CollaborationScopeError,
  assertCollaborationCanComment,
  assertCollaborationCanEdit,
  buildCollaborationGuestView,
  createCollaborationInvite,
  createCollaboratorEvent,
  listCollaborationActivity,
  listCollaborationInvites,
  recordCollaborationActivity,
  resolveCollaborationInvite,
  revokeCollaborationInvite,
  type ResolvedCollaborationInvite,
} from '../services/agent/collaboration.service.js';

const collaboration = new Hono<{ Variables: { user: User } }>();

const MAX_TOKEN_CHARS = 512;
/** 60 guest reads / minute / IP. */
const guestReadRateLimit = rateLimit(60, 60_000);

const createInviteSchema = z
  .object({
    email: z.string().trim().max(320).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, '邮箱格式不正确').nullish(),
    label: z.string().trim().max(100).nullish(),
    role: z.enum(COLLABORATION_ROLES),
    scope: z
      .object({
        profileId: z.number().int().positive().nullish(),
        tag: z.string().trim().max(100).nullish(),
        entityTypes: z.array(z.enum(COLLABORATION_ENTITY_TYPES)).max(10).optional(),
      })
      .strict()
      .default({}),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

const commentSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
const eventSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: z.string().trim().max(40).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  })
  .strict();

type RouteContext = Parameters<typeof authMiddleware>[0];

function fail(c: RouteContext, error: unknown) {
  if (error instanceof CollaborationNotFoundError) {
    return c.json({ success: false, error: '邀请不存在或已失效' }, 404);
  }
  if (error instanceof CollaborationForbiddenError) {
    return c.json({ success: false, error: error.message }, 403);
  }
  if (error instanceof CollaborationScopeError) {
    return c.json({ success: false, error: error.message }, 400);
  }
  throw error;
}

async function resolveOrFail(
  c: RouteContext,
  token: string | undefined,
): Promise<{ invite: ResolvedCollaborationInvite } | { response: Response }> {
  if (!token || token.length > MAX_TOKEN_CHARS) {
    return { response: c.json({ success: false, error: '邀请不存在或已失效' }, 404) };
  }
  try {
    const invite = await resolveCollaborationInvite(token);
    return { invite };
  } catch (error) {
    return { response: fail(c, error) };
  }
}

// ---- PUBLIC guest surface (must stay above the auth guard) -----------------
collaboration.get('/guest/:token', guestReadRateLimit, async (c) => {
  const resolved = await resolveOrFail(c, c.req.param('token'));
  if ('response' in resolved) return resolved.response;
  const view = await buildCollaborationGuestView(resolved.invite);
  await recordCollaborationActivity(resolved.invite.ownerUserId, {
    actorKind: 'guest',
    actorLabel: resolved.invite.label ?? `invite:${resolved.invite.id}`,
    inviteId: resolved.invite.id,
    action: 'guest_viewed',
    detail: { role: resolved.invite.role },
  });
  return c.json({ success: true, data: view });
});

collaboration.post('/guest/:token/comments', guestReadRateLimit, async (c) => {
  const resolved = await resolveOrFail(c, c.req.param('token'));
  if ('response' in resolved) return resolved.response;
  const { invite } = resolved;
  const body = await c.req.json().catch(() => null);
  const parsed = commentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  try {
    assertCollaborationCanComment(invite);
  } catch (error) {
    await recordCollaborationActivity(invite.ownerUserId, {
      actorKind: 'guest',
      actorLabel: invite.label ?? `invite:${invite.id}`,
      inviteId: invite.id,
      action: 'guest_write_denied',
      detail: { attempted: 'comment', role: invite.role },
    });
    return fail(c, error);
  }
  await recordCollaborationActivity(invite.ownerUserId, {
    actorKind: 'guest',
    actorLabel: invite.label ?? `invite:${invite.id}`,
    inviteId: invite.id,
    action: 'guest_commented',
    detail: { role: invite.role, text: parsed.data.text.slice(0, 500) },
  });
  return c.json({ success: true, data: { recorded: true } }, 201);
});

collaboration.post('/guest/:token/events', guestReadRateLimit, async (c) => {
  const resolved = await resolveOrFail(c, c.req.param('token'));
  if ('response' in resolved) return resolved.response;
  const { invite } = resolved;
  const body = await c.req.json().catch(() => null);
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  if (!invite.permissions.canEdit) {
    await recordCollaborationActivity(invite.ownerUserId, {
      actorKind: 'guest',
      actorLabel: invite.label ?? `invite:${invite.id}`,
      inviteId: invite.id,
      action: 'guest_write_denied',
      detail: { attempted: 'event_create', role: invite.role },
    });
  }
  try {
    assertCollaborationCanEdit(invite);
    const created = await createCollaboratorEvent(invite, parsed.data);
    return c.json({ success: true, data: created }, 201);
  } catch (error) {
    return fail(c, error);
  }
});

// ---- AUTHENTICATED owner management ---------------------------------------
collaboration.use('*', authMiddleware);

collaboration.get('/invites', async (c) => {
  const ownerUserId = Number(c.get('user').id);
  const data = await listCollaborationInvites(ownerUserId);
  return c.json({ success: true, data });
});

collaboration.post('/invites', async (c) => {
  const ownerUserId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => null);
  const parsed = createInviteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const { token, view } = await createCollaborationInvite(ownerUserId, parsed.data);
    return c.json({ success: true, data: { ...view, token } }, 201);
  } catch (error) {
    return fail(c, error);
  }
});

collaboration.delete('/invites/:id', async (c) => {
  const ownerUserId = Number(c.get('user').id);
  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, error: '无效的邀请 ID' }, 400);
  }
  const revoked = await revokeCollaborationInvite(ownerUserId, id);
  if (!revoked) return c.json({ success: false, error: '邀请不存在或已撤销' }, 404);
  return c.json({ success: true });
});

collaboration.get('/activity', async (c) => {
  const ownerUserId = Number(c.get('user').id);
  const data = await listCollaborationActivity(ownerUserId);
  return c.json({ success: true, data });
});

export default collaboration;
