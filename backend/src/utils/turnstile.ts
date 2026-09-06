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

type SiteVerifyResponse = {
  success?: boolean;
  'error-codes'?: string[];
};

type TurnstileVerifyOptions = {
  token: string | undefined;
  /** Only pass to Cloudflare when sourced from a trusted platform header */
  trustedRemoteIp?: string;
};

export async function verifyTurnstileToken(
  token: string | undefined,
  /** 兼容旧签名：siteverify 统一不带 remoteip（见上），该参数仅保留不再使用 */
  _trustedRemoteIp?: string,
): Promise<{ ok: boolean; skipped: boolean; error?: string; code?: string }> {
  const secret = getTurnstileSecretKey();
  if (!secret) return { ok: true, skipped: true };

  if (!token) {
    return { ok: false, skipped: false, error: '请完成人机验证', code: 'turnstile_required' };
  }

  const verify = async (includeRemoteIp: boolean): Promise<SiteVerifyResponse> => {
    const body = new URLSearchParams({ secret, response: token });
    if (includeRemoteIp && trustedRemoteIp) {
      body.set('remoteip', trustedRemoteIp);
    }

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return res.json() as Promise<SiteVerifyResponse>;
  };

  try {
    // Cloudflare 规定每个 token 只能提交 siteverify 一次：第一次提交（无论成败）即消费。
    // 因此绝不带 remoteip 失败后重试——第二次必然 timeout-or-duplicate，用户永远过不了验证。
    // remoteip 只是可选加固，token+secret 校验本身已足够安全，统一不带。
    const data = await verify(false);

    if (!data.success) {
      const codes = data['error-codes'] ?? [];
      if (codes.includes('invalid-input-secret')) {
        console.error('[turnstile] invalid secret key — check TURNSTILE_SECRET_KEY / SecretKey');
        return {
          ok: false,
          skipped: false,
          error: '人机验证配置错误，请联系管理员',
          code: 'turnstile_misconfigured',
        };
      }
      if (codes.includes('timeout-or-duplicate')) {
        return {
          ok: false,
          skipped: false,
          error: '人机验证已过期，请重新验证',
          code: 'turnstile_expired',
        };
      }
      if (codes.length) {
        console.warn('[turnstile] siteverify failed:', codes.join(', '));
      }
      return {
        ok: false,
        skipped: false,
        error: '人机验证失败，请重试',
        code: 'turnstile_failed',
      };
    }
    return { ok: true, skipped: false };
  } catch (err) {
    console.error('[turnstile] siteverify error:', err);
    return {
      ok: false,
      skipped: false,
      error: '人机验证服务暂不可用',
      code: 'turnstile_unavailable',
    };
  }
}
