/** Cloudflare Turnstile verification (optional — skip when secret not set). */

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

/** Prefer TURNSTILE_*; accept common dashboard typos (SiteKey / SecretKey). */
export function getTurnstileSiteKey(): string | undefined {
  return readEnv(
    'TURNSTILE_SITE_KEY',
    'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    'SiteKey',
    'SITE_KEY',
  );
}

export function getTurnstileSecretKey(): string | undefined {
  return readEnv('TURNSTILE_SECRET_KEY', 'SecretKey', 'SECRET_KEY');
}

export function isTurnstileEnabled(): boolean {
  return !!getTurnstileSecretKey();
}

export async function verifyTurnstileToken(
  token: string | undefined,
  remoteIp?: string,
): Promise<{ ok: boolean; skipped: boolean; error?: string }> {
  const secret = getTurnstileSecretKey();
  if (!secret) return { ok: true, skipped: true };

  if (!token) {
    return { ok: false, skipped: false, error: '请完成人机验证' };
  }

  const body = new URLSearchParams({
    secret,
    response: token,
  });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = (await res.json()) as { success?: boolean };
    if (!data.success) {
      return { ok: false, skipped: false, error: '人机验证失败，请重试' };
    }
    return { ok: true, skipped: false };
  } catch {
    return { ok: false, skipped: false, error: '人机验证服务暂不可用' };
  }
}
