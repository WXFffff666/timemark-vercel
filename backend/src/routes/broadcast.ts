import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { broadcastEmailSchema, broadcastPreviewSchema } from '@timemark/shared';
import {
  sendBroadcastEmail,
  listBroadcastCampaigns,
  renderBroadcastPreview,
} from '../services/broadcast.service.js';
import { verifyTotpCode } from '../services/auth.service.js';
import { query } from '../db/index.js';
import { rateLimit } from '../middleware/rate-limit.js';

const broadcast = new Hono<{ Variables: { user: User } }>();
broadcast.use('*', authMiddleware);
broadcast.use('*', rateLimit(10, 60 * 60 * 1000));

broadcast.get('/campaigns', async (c) => {
  const user = c.get('user');
  const data = await listBroadcastCampaigns(Number(user.id));
  return c.json({ success: true, data });
});

broadcast.post('/preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = broadcastPreviewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  return c.json({
    success: true,
    data: renderBroadcastPreview(parsed.data.subject, parsed.data.html),
  });
});

broadcast.post('/email', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = broadcastEmailSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const totpRow = await query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [userId]);
  const totpData = totpRow.rows[0] as { totp_secret?: string; totp_enabled?: boolean } | undefined;
  const totpSecret = totpData?.totp_enabled && totpData?.totp_secret ? totpData.totp_secret : undefined;
  if (totpSecret) {
    if (!parsed.data.totpCode || !(await verifyTotpCode(totpSecret, parsed.data.totpCode))) {
      return c.json({ success: false, error: '批量发送需验证双因素认证码' }, 403);
    }
  }

  if (parsed.data.useAllContacts || (parsed.data.recipientEmails?.length ?? 0) > 10 || (parsed.data.contactIds?.length ?? 0) > 10) {
    if (!totpSecret) {
      return c.json({ success: false, error: '大批量发送请先开启双因素认证' }, 403);
    }
  }

  try {
    const result = await sendBroadcastEmail(userId, parsed.data);
    return c.json({ success: true, data: result });
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : '发送失败' }, 400);
  }
});

export default broadcast;
