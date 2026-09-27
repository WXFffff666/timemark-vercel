/**
 * Browser Web Push channel (checkbox 84).
 *
 * VAPID env naming (reconciled): `PUSH_VAPID_PUBLIC_KEY` /
 * `PUSH_VAPID_PRIVATE_KEY` / `PUSH_VAPID_SUBJECT` are the canonical names.
 * The legacy `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` spellings are still
 * honored as a fallback so existing deployments keep working.
 *
 * Fail-open contract: when VAPID is not configured this module reports
 * `null`/`false` and the notification dispatcher skips the `web_push` channel
 * (`no_configuration`) instead of throwing out of the dispatcher.
 *
 * Permanent delivery failures (404 / 410 from the push service) delete the
 * stored subscription and are never retried; transient failures are reported
 * so the caller can decide about the retry queue.
 */
import webPush from 'web-push';
import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('webpush');

export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@timemark.app';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface StoredPushSubscription {
  endpoint: string;
  keys_p256dh: string | null;
  keys_auth: string | null;
}

export interface WebPushPayload {
  title: string;
  body: string;
  url: string;
  icon: string;
  badge: string;
  tag: string;
}

export interface WebPushDeliveryResult {
  sent: number;
  removed: string[];
  failed: Array<{ endpoint: string; error: string }>;
}

/** Read the reconciled VAPID env names (canonical first, legacy as fallback). */
export function getVapidConfig(): VapidConfig | null {
  const publicKey = process.env.PUSH_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.PUSH_VAPID_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || '';
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: process.env.PUSH_VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
  };
}

/**
 * True only when VAPID keys exist AND web-push accepts them. Malformed keys are
 * treated like missing keys so the dispatcher skips the channel (fail open).
 */
export function isWebPushConfigured(): boolean {
  try {
    ensureWebPushConfigured();
    return true;
  } catch {
    return false;
  }
}

/** Configure the web-push library for this invocation. Throws when unconfigured/malformed. */
export function ensureWebPushConfigured(): VapidConfig {
  const config = getVapidConfig();
  if (!config) {
    throw new Error(
      'Web Push 未配置：请设置 PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY（兼容旧名 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）',
    );
  }
  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return config;
}

/** Strip the lightweight markdown used in notification bodies for a plain-text push body. */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .replace(/[`*_>]/g, '')
    .replace(/\s*\n\s*/g, ' · ')
    .trim();
}

/** Build a JSON-safe push payload for an event reminder. */
export function buildWebPushPayload(event: Record<string, unknown>): WebPushPayload {
  const rawName = typeof event.name === 'string' ? event.name.trim() : '';
  const title = rawName || 'TimeMark 提醒';
  const message = typeof event.customMessage === 'string' ? toPlainText(event.customMessage) : '';
  const date = typeof event.date === 'string' ? event.date.slice(0, 10) : '';
  const fallback = [date, typeof event.type === 'string' ? event.type : ''].filter(Boolean).join(' · ');
  const eventId = Number(event.id);
  return {
    title,
    body: message || fallback || '打开 TimeMark 查看详情',
    url: Number.isFinite(eventId) && eventId > 0 ? `/reminders?event=${eventId}` : '/reminders',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: Number.isFinite(eventId) && eventId > 0 ? `timemark-event-${eventId}` : 'timemark',
  };
}

/** User-scoped subscriptions for the push/test routes and the dispatcher. */
export async function listUserPushSubscriptions(userId: number): Promise<StoredPushSubscription[]> {
  const result = await query(
    'SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at ASC',
    [userId],
  );
  return result.rows as StoredPushSubscription[];
}

/**
 * Deliver a payload to every stored subscription.
 *
 * - 404 / 410 from the push service: the subscription row is DELETED and
 *   reported in `removed` — it is never retried.
 * - Anything else: reported in `failed` (transient), the row is kept.
 * - Unconfigured VAPID throws (callers must check `getVapidConfig()` first);
 *   the dispatcher only reaches this path when VAPID is configured.
 */
export async function deliverWebPush(
  subscriptions: StoredPushSubscription[],
  payload: WebPushPayload,
  userId: number,
): Promise<WebPushDeliveryResult> {
  ensureWebPushConfigured();
  const body = JSON.stringify(payload);
  const result: WebPushDeliveryResult = { sent: 0, removed: [], failed: [] };

  await Promise.all(
    subscriptions.map(async (sub) => {
      if (!sub.endpoint) return;
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.keys_p256dh || '',
              auth: sub.keys_auth || '',
            },
          },
          body,
        );
        result.sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        const message = error instanceof Error ? error.message : String(error);
        if (status === 404 || status === 410) {
          // Expired/unsubscribed endpoint: delete and never retry.
          try {
            await query(
              'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
              [userId, sub.endpoint],
            );
            result.removed.push(sub.endpoint);
          } catch (dbError) {
            log.warn(
              { event: 'webpush.subscription_delete_failed', err: dbError },
              'Failed to delete expired push subscription',
            );
            result.failed.push({ endpoint: sub.endpoint, error: message });
          }
          return;
        }
        result.failed.push({ endpoint: sub.endpoint, error: message });
      }
    }),
  );

  if (result.removed.length > 0) {
    log.info(
      { event: 'webpush.subscriptions_removed', count: result.removed.length },
      'Removed expired push subscriptions',
    );
  }
  if (result.failed.length > 0) {
    log.warn(
      { event: 'webpush.delivery_failed', count: result.failed.length },
      'Transient Web Push delivery failures',
    );
  }
  return result;
}
