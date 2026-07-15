/**
 * Redirect Vercel preview (*.vercel.app) traffic to the canonical custom domain.
 * API routes are excluded so serverless functions keep working during deploy checks.
 */

const CANONICAL_HOST = 'timemark.the37777777.top';

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const host = url.hostname;

  if (
    host !== CANONICAL_HOST &&
    !host.includes('localhost') &&
    !host.includes('127.0.0.1') &&
    host.endsWith('.vercel.app')
  ) {
    url.protocol = 'https:';
    url.hostname = CANONICAL_HOST;
    return Response.redirect(url.toString(), 308);
  }
}

export const config = {
  matcher: ['/((?!api/).*)'],
};
