import type { Context } from 'hono';

/**
 * Resolve client IP on Vercel / reverse proxies.
 * Prefer platform headers; do not rewrite public IPs to 127.0.0.1.
 */
export function getClientIp(c: Context): string {
  const forwardedFor = c.req.header('x-forwarded-for');
  const vercelForwarded = c.req.header('x-vercel-forwarded-for');
  const realIp = c.req.header('x-real-ip');
  const cfIp = c.req.header('cf-connecting-ip');

  let ip = '';
  if (vercelForwarded) {
    ip = vercelForwarded.split(',')[0]?.trim() || '';
  } else if (forwardedFor) {
    ip = forwardedFor.split(',')[0]?.trim() || '';
  } else if (realIp) {
    ip = realIp.trim();
  } else if (cfIp) {
    ip = cfIp.trim();
  }

  if (!ip) {
    try {
      // @ts-expect-error Hono optional API
      if (typeof c.getClientIp === 'function') {
        // @ts-expect-error Hono optional API
        ip = c.getClientIp({ proxyProof: true }) || '';
      }
    } catch {
      // ignore
    }
  }

  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  if (!ip || ip === '::1') {
    ip = '127.0.0.1';
  }

  return ip.slice(0, 45);
}
