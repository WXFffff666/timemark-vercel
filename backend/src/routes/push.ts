import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';
import webPush from 'web-push';

const push = new Hono<{ Variables: { user: User } }>();

push.use('*', authMiddleware);

// 生成 VAPID 密钥（首次启动时生成并保存）
let vapidKeys: { publicKey: string; privateKey: string } | null = null;

function getVapidKeys(): { publicKey: string; privateKey: string } {
  if (!vapidKeys) {
    // 从环境变量或生成新密钥
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    
    if (publicKey && privateKey) {
      vapidKeys = { publicKey, privateKey };
    } else {
      // 生成新密钥
      vapidKeys = webPush.generateVAPIDKeys();
      console.log('[Push] Generated new VAPID keys');
      console.log('[Push] Public Key:', vapidKeys.publicKey);
      console.log('[Push] Private Key:', vapidKeys.privateKey);
      console.log('[Push] Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars to persist');
    }
    
    // 设置 web-push 配置
    webPush.setVapidDetails(
      'mailto:admin@timemark.app',
      vapidKeys.publicKey,
      vapidKeys.privateKey
    );
  }
  
  return vapidKeys;
}

/**
 * 获取 VAPID 公钥
 * GET /api/push/vapid-key
 */
push.get('/vapid-key', (c) => {
  const keys = getVapidKeys();
  return c.json({ success: true, data: { publicKey: keys.publicKey } });
});

/**
 * 订阅推送通知
 * POST /api/push/subscribe
 */
push.post('/subscribe', async (c) => {
  const user = c.get('user');
  const subscription = await c.req.json();
  
  if (!subscription || !subscription.endpoint) {
    return c.json({ success: false, error: 'Invalid subscription' }, 400);
  }
  
  try {
    // 保存订阅到数据库
    await query(
       `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth, created_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,
      [user.id, subscription.endpoint, subscription.keys?.p256dh || '', subscription.keys?.auth || '']
    );
    
    return c.json({ success: true, message: 'Subscription saved' });
  } catch (error: any) {
    console.error('[Push] Failed to save subscription:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

/**
 * 取消订阅
 * POST /api/push/unsubscribe
 */
push.post('/unsubscribe', async (c) => {
  const user = c.get('user');
  const subscription = await c.req.json();
  
  try {
    await query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [user.id, subscription.endpoint]
    );
    
    return c.json({ success: true, message: 'Subscription removed' });
  } catch (error: any) {
    console.error('[Push] Failed to remove subscription:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

/**
 * 发送测试推送通知
 * POST /api/push/test
 */
push.post('/test', async (c) => {
  const user = c.get('user');
  
  try {
    const keys = getVapidKeys();
    
    // 获取用户的订阅
    const subscriptions = await query(
      'SELECT * FROM push_subscriptions WHERE user_id = $1',
      [user.id]
    );
    
    if (subscriptions.rows.length === 0) {
      return c.json({ success: false, error: 'No push subscriptions found' }, 400);
    }
    
    const payload = JSON.stringify({
      title: 'TimeMark 测试通知',
      body: '这是一条测试推送通知',
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
    });
    
    const results = await Promise.allSettled(
      subscriptions.rows.map(async (sub: any) => {
        const subscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth,
          },
        };
        
        return webPush.sendNotification(subscription, payload);
      })
    );
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    return c.json({
      success: true,
      message: `Push sent: ${successful} successful, ${failed} failed`,
    });
  } catch (error: any) {
    console.error('[Push] Failed to send test push:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

/**
 * 发送推送通知到指定用户（内部使用）
 */
export async function sendPushNotification(userId: number, title: string, body: string): Promise<void> {
  try {
    const keys = getVapidKeys();
    
    const subscriptions = await query(
      'SELECT * FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );
    
    if (subscriptions.rows.length === 0) {
      return;
    }
    
    const payload = JSON.stringify({
      title,
      body,
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
    });
    
    await Promise.allSettled(
      subscriptions.rows.map(async (sub: any) => {
        const subscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth,
          },
        };
        
        try {
          await webPush.sendNotification(subscription, payload);
        } catch (error: any) {
          // 如果订阅失效，删除它
          if (error.statusCode === 410) {
            await query(
              'DELETE FROM push_subscriptions WHERE endpoint = $1',
              [sub.endpoint]
            );
          }
          throw error;
        }
      })
    );
  } catch (error) {
    console.error('[Push] Failed to send push notification:', error);
  }
}

export default push;
