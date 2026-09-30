import type { Context, Next } from 'hono';
import { getConfiguredOrigins, isAllowedOrigin } from '../utils/allowed-origins.js';

export function csrfProtection() {
  const allowedOrigins = getConfiguredOrigins();

  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return next();
    }

    if (c.req.path.startsWith('/api/webhook/') || c.req.path.startsWith('/api/inbox/receive/') || c.req.path === '/api/csp-report') {
      return next();
    }

    // checkbox 103: the MCP Streamable-HTTP endpoint authenticates with a scoped Bearer agent
    // token (`tmt_...`), which a browser never attaches automatically (it is not a cookie), so
    // classic CSRF does not apply. Exempt ONLY this exact path and ONLY when such a Bearer
    // credential is present; every other non-GET /api/* request still needs Origin/Referer or
    // Bearer + X-Requested-With, so CSRF for the rest of the app is unchanged.
    if (c.req.path === '/api/mcp' && /^Bearer\s+tmt_/i.test(c.req.header('Authorization') ?? '')) {
      return next();
    }

    // checkbox 115: the scheduler tick is machine-to-machine (cron-job.org POSTs it with
    // `Authorization: Bearer <CRON_SECRET>` - validated timing-safely in routes/agent-scheduler.ts -
    // and no browser Origin). A Bearer credential is never attached automatically by a browser,
    // so classic CSRF does not apply; same rationale as the /api/mcp exemption above. The route
    // answers 401 for any wrong secret, so this only removes the X-Requested-With requirement.
    if (c.req.path === '/api/agent/scheduler/start' && /^Bearer\s+/i.test(c.req.header('Authorization') ?? '')) {
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
