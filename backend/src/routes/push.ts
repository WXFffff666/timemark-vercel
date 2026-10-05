import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { formatZodError } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';
import {
  buildWebPushPayload,
  deliverWebPush,
  getVapidConfig,
  listUserPushSubscriptions,
} from '../services/notifications/webpush.service.js';

const push = new Hono<{ Variables: { user: User } }>();

push.use('*', authMiddleware);

/**
 * Checkbox 84: browser Web Push (VAPID, not FCM).
 *
 * Env naming: PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY are canonical;
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are honored as a legacy fallback.
 */

/** Reject oversized/invalid endpoints early (10 KB endpoint strings never reach the DB). */
const endpointSchema = z.url().max(2048);

const subscribeSchema = z.object({
  endpoint: endpointSchema,
  keys: z
    .object({
      p256dh: z.string().min(1).max(512),
      auth: z.string().min(1).max(512),
    })
    .optional(),
});

const unsubscribeSchema = z.object({
  endpoint: endpointSchema,
});

async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * VAPID public key for the browser.
 * GET /api/push/vapid-key
 */
push.get('/vapid-key', (c) => {
  const config = getVapidConfig();
  if (!config) {
    return c.json(
      { success: false, error: 'Web Push 未配置：请设置 PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY' },
      501,
    );
  }
  return c.json({ success: true, data: { publicKey: config.publicKey } });
});

/**
 * Save (upsert) a browser push subscription.
 * POST /api/push/subscribe
 */
push.post('/subscribe', async (c) => {
  const user = c.get('user');
  const raw = await readJson(c);
  if (!raw.ok) return c.json({ success: false, error: '请求体必须是 JSON' }, 400);

  const parsed = subscribeSchema.safeParse(raw.value);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error) }, 400);
  }

  const { endpoint, keys } = parsed.data;
  try {
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET keys_p256dh = EXCLUDED.keys_p256dh, keys_auth = EXCLUDED.keys_auth`,
      [user.id, endpoint, keys?.p256dh ?? '', keys?.auth ?? ''],
    );
    return c.json({ success: true, message: 'Subscription saved' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save subscription';
    return c.json({ success: false, error: message }, 500);
  }
});

/**
 * Remove a browser push subscription. Idempotent: a subscription that never
 * existed still returns success (the client's local unsubscribe already ran).
 *
 * DELETE /api/push/unsubscribe (canonical) — POST kept as a legacy alias.
 */
const unsubscribeHandler = async (c: Context<{ Variables: { user: User } }>) => {
  const user = c.get('user');
  const raw = await readJson(c);
  if (!raw.ok) return c.json({ success: false, error: '请求体必须是 JSON' }, 400);

  const parsed = unsubscribeSchema.safeParse(raw.value);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error) }, 400);
  }

  try {
    await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [
      user.id,
      parsed.data.endpoint,
    ]);
    return c.json({ success: true, message: 'Subscription removed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to remove subscription';
    return c.json({ success: false, error: message }, 500);
  }
};

push.delete('/unsubscribe', unsubscribeHandler);
push.post('/unsubscribe', unsubscribeHandler);

/**
 * v2.27 遗留3：设备管理。列出当前用户全部 push 订阅（endpoint 只回主机段，
 * 不回完整 URL）；DELETE 按 id 跨设备移除——此前 unsubscribe 只能删当前浏览器。
 */
push.get('/subscriptions', async (c) => {
  const userId = Number(c.get('user').id);
  try {
    const result = await query(
      `SELECT id, endpoint, created_at FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    const devices = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      let host = '';
      try {
        host = new URL(String(r.endpoint)).host;
      } catch {
        host = String(r.endpoint).slice(0, 24);
      }
      return { id: Number(r.id), endpointHost: host, createdAt: String(r.created_at) };
    });
    return c.json({ success: true, data: { devices } });
  } catch (error) {
    return c.json(
      { success: false, error: error instanceof Error ? error.message : '读取设备列表失败' },
      500,
    );
  }
});

push.delete('/subscriptions/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, error: '无效的设备 ID' }, 400);
  }
  try {
    const result = await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND id = $2', [
      userId,
      id,
    ]);
    return c.json({ success: true, removed: result.rowCount ?? 0 });
  } catch (error) {
    return c.json(
      { success: false, error: error instanceof Error ? error.message : '删除失败' },
      500,
    );
  }
});

/**
 * Send a test push to every stored subscription of the current user.
 * POST /api/push/test
 *
 * 410/404 endpoints are deleted by `deliverWebPush` and reported as `removed`;
 * they are never retried.
 */
push.post('/test', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  if (!getVapidConfig()) {
    return c.json(
      { success: false, error: 'Web Push 未配置：请设置 PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY' },
      501,
    );
  }

  let subscriptions;
  try {
    subscriptions = await listUserPushSubscriptions(userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load subscriptions';
    return c.json({ success: false, error: message }, 500);
  }

  if (subscriptions.length === 0) {
    return c.json({ success: false, error: '没有已保存的推送订阅，请先开启浏览器推送' }, 400);
  }

  const payload = buildWebPushPayload({
    id: 0,
    name: 'TimeMark 测试通知',
    type: 'other',
    date: new Date().toISOString().slice(0, 10),
    customMessage: '这是一条测试推送通知',
  });

  try {
    const delivery = await deliverWebPush(subscriptions, payload, userId);
    const data = {
      sent: delivery.sent,
      removed: delivery.removed.length,
      failed: delivery.failed.length,
    };
    if (delivery.failed.length > 0 && delivery.sent === 0) {
      return c.json(
        { success: false, error: delivery.failed[0]?.error || '推送发送失败', data },
        502,
      );
    }
    return c.json({
      success: true,
      data,
      message: `Push sent: ${data.sent} successful, ${data.removed} removed, ${data.failed} failed`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send test push';
    return c.json({ success: false, error: message }, 500);
  }
});

export default push;
