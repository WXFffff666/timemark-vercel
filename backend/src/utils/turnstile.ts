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

  type SiteVerifyResponse = {
    success?: boolean;
    'error-codes'?: string[];
  };

  const verify = async (includeRemoteIp: boolean): Promise<SiteVerifyResponse> => {
    const body = new URLSearchParams({ secret, response: token });
    if (includeRemoteIp && remoteIp) body.set('remoteip', remoteIp);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return res.json() as Promise<SiteVerifyResponse>;
  };

  try {
    // Prefer verification without remoteip: behind Vercel/Cloudflare proxies the
    // server-resolved IP often differs from the IP Turnstile bound to the token.
    let data = await verify(false);
    if (!data.success && remoteIp) {
      data = await verify(true);
    }

    if (!data.success) {
      const codes = data['error-codes'] ?? [];
      if (codes.includes('invalid-input-secret')) {
        console.error('[turnstile] invalid secret key — check TURNSTILE_SECRET_KEY / SecretKey');
        return { ok: false, skipped: false, error: '人机验证配置错误，请联系管理员' };
      }
      if (codes.includes('timeout-or-duplicate')) {
        return { ok: false, skipped: false, error: '人机验证已过期，请重新验证' };
      }
      if (codes.length) {
        console.warn('[turnstile] siteverify failed:', codes.join(', '));
      }
      return { ok: false, skipped: false, error: '人机验证失败，请重试' };
    }
    return { ok: true, skipped: false };
  } catch (err) {
    console.error('[turnstile] siteverify error:', err);
    return { ok: false, skipped: false, error: '人机验证服务暂不可用' };
  }
}
