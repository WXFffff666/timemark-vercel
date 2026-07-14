/** Shared CORS / CSRF origin rules for SPA + custom domains on Vercel */

export function getConfiguredOrigins(): string[] {
  const origins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ];

  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    if (corsOrigin === '*') return ['*'];
    origins.push(...corsOrigin.split(',').map((o) => o.trim()).filter(Boolean));
  }

  if (process.env.VERCEL_URL) {
    origins.push(`https://${process.env.VERCEL_URL}`);
  }

  // Common custom domain for this deployment
  origins.push('https://timemark.the37777777.top');

  return origins;
}

export function isVercelAppOrigin(origin: string): boolean {
  return /^https:\/\/[\w-]+\.vercel\.app$/.test(origin);
}

export function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(origin);
    return url.host === host;
  } catch {
    return false;
  }
}

export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: string[],
): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes('*')) return true;
  if (isVercelAppOrigin(origin)) return true;
  if (originMatchesHost(origin, host)) return true;

  return allowedOrigins.some((allowed) => {
    if (origin === allowed) return true;
    if (allowed.startsWith('*.')) {
      return origin.endsWith(allowed.slice(2));
    }
    return false;
  });
}

export function resolveCorsOrigin(origin: string | undefined, host: string | undefined): string {
  const allowed = getConfiguredOrigins();
  if (!origin) return allowed[0] ?? 'http://localhost:5173';
  if (isAllowedOrigin(origin, host, allowed)) return origin;
  return allowed[0] ?? 'http://localhost:5173';
}
