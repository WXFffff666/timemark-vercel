import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';

const push = new Hono();

push.get('/vapid-public-key', (c) =>
  c.json({ success: true, data: { publicKey: process.env.VAPID_PUBLIC_KEY || null } }),
);

push.post('/subscribe', authMiddleware, (c) =>
  c.json({ success: false, error: 'Web Push is not available on Vercel serverless' }, 501),
);

push.post('/unsubscribe', authMiddleware, (c) =>
  c.json({ success: true }),
);

export default push;
