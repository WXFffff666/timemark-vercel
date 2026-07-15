import type { Context, Next } from 'hono';
import { getConfiguredOrigins, isAllowedOrigin } from '../utils/allowed-origins.js';

export function csrfProtection() {
  const allowedOrigins = getConfiguredOrigins();

  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return next();
    }

    const origin = c.req.header('Origin');
    const referer = c.req.header('Referer');
    const host = c.req.header('host') ?? c.req.header('x-forwarded-host');

    let requestOrigin = origin;
    if (!requestOrigin && referer) {
      try {
        requestOrigin = new URL(referer).origin;
      } catch {
        // ignore invalid referer
      }
    }

    const hasCustomHeader = c.req.header('X-Requested-With') === 'XMLHttpRequest';

    if (!requestOrigin) {
      const authHeader = c.req.header('Authorization');
      if (authHeader?.startsWith('Bearer ') && hasCustomHeader) {
        return next();
      }
      return c.json({ success: false, error: 'Missing origin or authorization' }, 403);
    }

    if (!isAllowedOrigin(requestOrigin, host, allowedOrigins)) {
      console.warn(`[CSRF] Blocked request from origin: ${requestOrigin} host: ${host}`);
      return c.json({ success: false, error: 'Origin not allowed' }, 403);
    }

    return next();
  };
}
