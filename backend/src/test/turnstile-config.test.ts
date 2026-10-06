import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { turnstileConfigPayload } from '../utils/turnstile.js';

/**
 * v2.28 生产事故复盘：TURNSTILE_SECRET_KEY 在而 TURNSTILE_SITE_KEY 丢失时，
 * 后端 enabled=true 且前端拿不到 siteKey → 登录页验证组件凭空消失、登录必被拒。
 * `misconfigured` 标志让前端能把这种"配置不对称"显式说出口，而不是静默空白。
 */
const ENV_KEYS = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'SiteKey', 'SecretKey', 'SITE_KEY', 'SECRET_KEY'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function withEnv(siteKey?: string, secretKey?: string): void {
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  if (siteKey) process.env.TURNSTILE_SITE_KEY = siteKey;
  if (secretKey) process.env.TURNSTILE_SECRET_KEY = secretKey;
}

describe('turnstileConfigPayload', () => {
  it('both keys present → enabled, siteKey exposed, not misconfigured', () => {
    withEnv('0x4AAA-site', '0x4AAA-secret');
    expect(turnstileConfigPayload()).toEqual({
      siteKey: '0x4AAA-site',
      enabled: true,
      misconfigured: false,
    });
  });

  it('secret without siteKey → the dangerous asymmetric state is flagged', () => {
    withEnv(undefined, '0x4AAA-secret');
    const payload = turnstileConfigPayload();
    expect(payload.enabled).toBe(true);
    expect(payload.siteKey).toBeNull();
    expect(payload.misconfigured).toBe(true);
  });

  it('siteKey without secret → disabled, widget hidden, login still works', () => {
    withEnv('0x4AAA-site', undefined);
    expect(turnstileConfigPayload()).toEqual({
      siteKey: '0x4AAA-site',
      enabled: false,
      misconfigured: false,
    });
  });

  it('neither key → disabled, not misconfigured', () => {
    withEnv(undefined, undefined);
    expect(turnstileConfigPayload()).toEqual({
      siteKey: null,
      enabled: false,
      misconfigured: false,
    });
  });
});
