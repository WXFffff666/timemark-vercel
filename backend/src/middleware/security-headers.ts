import type { Context, Next } from 'hono';

export async function securityHeaders(c: Context, next: Next) {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  const cspReportUri = process.env.CSP_REPORT_URI;
  if (cspReportUri) {
    c.header('Content-Security-Policy-Report-Only', `default-src 'self'; report-uri ${cspReportUri}`);
  }
  c.res.headers.delete('X-Powered-By');
}
