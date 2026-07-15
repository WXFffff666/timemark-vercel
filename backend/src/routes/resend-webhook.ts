import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'crypto';
import { query } from '../db/index.js';

const resendWebhook = new Hono();

/** B25: Resend 投递状态 webhook（可选用户配置 secret） */
resendWebhook.post('/delivery', async (c) => {
  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > 32 * 1024) {
    return c.json({ error: 'Payload too large' }, 413);
  }

  const sig = c.req.header('svix-signature') || c.req.header('x-resend-signature');
  const users = await query(
    `SELECT user_id, resend_webhook_secret FROM user_configs WHERE resend_webhook_secret IS NOT NULL`,
  );

  let verifiedUserId: number | null = null;
  for (const row of users.rows as Array<{ user_id: number; resend_webhook_secret: string }>) {
    if (!sig || !row.resend_webhook_secret) continue;
    const expected = createHmac('sha256', row.resend_webhook_secret).update(rawBody).digest('hex');
    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(sig.replace(/^sha256=/, ''), 'hex');
      if (a.length === b.length && timingSafeEqual(a, b)) {
        verifiedUserId = row.user_id;
        break;
      }
    } catch { /* try next */ }
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (verifiedUserId) {
    const status = String(payload.type || payload.event || 'unknown');
    await query(
      `UPDATE email_logs SET error_message = COALESCE(error_message, '') || $1
       WHERE user_id = $2 AND id = (SELECT id FROM email_logs WHERE user_id = $2 ORDER BY sent_at DESC LIMIT 1)`,
      [` [resend:${status}]`, verifiedUserId],
    ).catch(() => {});
  }

  return c.json({ received: true });
});

export default resendWebhook;
