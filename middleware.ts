/**
 * Only allow the canonical custom domain for the SPA.
 * API routes are excluded so Vercel health checks and cron keep working.
 */

const CANONICAL_HOST = 'timemark.the37777777.top';

function isLocalDev(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
}

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const host = url.hostname;

  if (host !== CANONICAL_HOST && !isLocalDev(host)) {
    url.protocol = 'https:';
    url.hostname = CANONICAL_HOST;
    return Response.redirect(url.toString(), 308);
  }
}

export const config = {
  matcher: ['/((?!api/).*)'],
};
