/** Cloudflare Turnstile verification (optional — skip when secret not set). */
export async function verifyTurnstileToken(
  token: string | undefined,
  remoteIp?: string,
): Promise<{ ok: boolean; skipped: boolean; error?: string }> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
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
