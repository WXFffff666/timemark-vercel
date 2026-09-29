import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { formatZodError } from '@timemark/shared';
import type { User } from '@timemark/shared';
import {
  AGENT_TOKEN_SCOPES,
  createAgentToken,
  listAgentTokens,
  renameAgentToken,
  revokeAgentToken,
} from '../services/agent-tokens.service.js';

/**
 * Checkbox 101: Settings-facing CRUD for scoped, revocable agent tokens.
 *
 * The RAW token is returned by POST / ONLY - the response to GET / never carries a token
 * value or its hash. The service stores only the SHA-256 hash, so a token can never be
 * recovered after creation; the UI shows it once and requires a new token otherwise.
 */
const agentTokens = new Hono<{ Variables: { user: User } }>();

agentTokens.use('*', authMiddleware);

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(AGENT_TOKEN_SCOPES)).min(1).optional(),
});

const renameTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

const uuidSchema = z.string().uuid();

agentTokens.get('/', async (c) => {
  const user = c.get('user');
  const tokens = await listAgentTokens(Number(user.id));
  return c.json({ success: true, data: { tokens } });
});

agentTokens.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = createTokenSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error) }, 400);
  }
  const created = await createAgentToken(Number(user.id), parsed.data.name, parsed.data.scopes);
  // The raw token is present here and ONLY here.
  return c.json({ success: true, data: { token: created.token, record: created.view } }, 201);
});

agentTokens.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = uuidSchema.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ success: false, error: 'Invalid token id' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = renameTokenSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error) }, 400);
  }
  const renamed = await renameAgentToken(Number(user.id), id.data, parsed.data.name);
  if (!renamed) return c.json({ success: false, error: 'Token not found' }, 404);
  return c.json({ success: true });
});

agentTokens.post('/:id/revoke', async (c) => {
  const user = c.get('user');
  const id = uuidSchema.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ success: false, error: 'Invalid token id' }, 400);
  const revoked = await revokeAgentToken(Number(user.id), id.data);
  if (!revoked) return c.json({ success: false, error: 'Token not found or already revoked' }, 404);
  return c.json({ success: true });
});

export default agentTokens;
