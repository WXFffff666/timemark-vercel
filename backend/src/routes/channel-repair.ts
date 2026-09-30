import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  ChannelRepairError,
  getRepairDiagnosis,
  listRepairCandidates,
  reenterCredentials,
  retestChannel,
  setChannelActive,
} from '../services/agent/channel-repair.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('channel-repair-route');

const channelRepair = new Hono<{ Variables: { user: User } }>();

// Same gate as every other owner-scoped route: only the authenticated user's
// own notification_accounts rows are ever reached.
channelRepair.use('*', authMiddleware);

const credentialsSchema = z
  .object({
    webhook: z.string().max(4096).optional(),
    token: z.string().max(4096).optional(),
    secret: z.string().max(4096).optional(),
    chat_id: z.string().max(512).optional(),
    reactivate: z.boolean().optional(),
  })
  .strict();

const confirmSchema = z.object({ confirm: z.literal(true) });

function parseAccountId(raw: string | undefined): number | null {
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function fail(c: Context, error: unknown) {
  if (error instanceof ChannelRepairError) {
    return c.json({ success: false, error: error.message, code: error.code }, error.status);
  }
  log.error({ err: error }, 'channel-repair route error');
  return c.json({ success: false, error: '渠道修复失败，请稍后重试', code: 'channel_repair_failed' }, 500);
}

/** Candidate channels for the repair wizard (disabled / unhealthy / last test failed). */
channelRepair.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  try {
    return c.json({ success: true, data: await listRepairCandidates(userId) });
  } catch (error) {
    return fail(c, error);
  }
});

/** Full guided diagnosis: credential shape + failure history. No secret values. */
channelRepair.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const accountId = parseAccountId(c.req.param('id'));
  if (!accountId) {
    return c.json({ success: false, error: '无效的渠道 ID', code: 'invalid_account_id' }, 400);
  }
  try {
    return c.json({ success: true, data: await getRepairDiagnosis(userId, accountId) });
  } catch (error) {
    return fail(c, error);
  }
});

/** Live re-test using the stored credentials. */
channelRepair.post('/:id/test', async (c) => {
  const userId = Number(c.get('user').id);
  const accountId = parseAccountId(c.req.param('id'));
  if (!accountId) {
    return c.json({ success: false, error: '无效的渠道 ID', code: 'invalid_account_id' }, 400);
  }
  try {
    const outcome = await retestChannel(userId, accountId);
    return c.json({ success: true, data: outcome });
  } catch (error) {
    return fail(c, error);
  }
});

/** Re-enter credentials (only the provided fields change; required fields validated). */
channelRepair.post('/:id/credentials', async (c) => {
  const userId = Number(c.get('user').id);
  const accountId = parseAccountId(c.req.param('id'));
  if (!accountId) {
    return c.json({ success: false, error: '无效的渠道 ID', code: 'invalid_account_id' }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: '凭据格式无效', code: 'invalid_credentials_payload' }, 400);
  }
  try {
    const result = await reenterCredentials(userId, accountId, parsed.data);
    return c.json({ success: true, data: result });
  } catch (error) {
    return fail(c, error);
  }
});

/** Explicit disable - requires `{ confirm: true }`, never an implicit side effect. */
channelRepair.post('/:id/disable', async (c) => {
  const userId = Number(c.get('user').id);
  const accountId = parseAccountId(c.req.param('id'));
  if (!accountId) {
    return c.json({ success: false, error: '无效的渠道 ID', code: 'invalid_account_id' }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: '需要显式确认才能禁用渠道', code: 'confirmation_required' }, 400);
  }
  try {
    return c.json({ success: true, data: await setChannelActive(userId, accountId, false, true) });
  } catch (error) {
    return fail(c, error);
  }
});

/** Explicit re-enable (the usual follow-up after a credential fix). */
channelRepair.post('/:id/enable', async (c) => {
  const userId = Number(c.get('user').id);
  const accountId = parseAccountId(c.req.param('id'));
  if (!accountId) {
    return c.json({ success: false, error: '无效的渠道 ID', code: 'invalid_account_id' }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: '需要显式确认才能启用渠道', code: 'confirmation_required' }, 400);
  }
  try {
    return c.json({ success: true, data: await setChannelActive(userId, accountId, true, true) });
  } catch (error) {
    return fail(c, error);
  }
});

export default channelRepair;
