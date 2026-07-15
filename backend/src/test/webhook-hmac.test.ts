import { describe, it, expect } from 'vitest';
import { createHmac, timingSafeEqual } from 'crypto';

function verifyWebhookSignature(rawBody: string, secret: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signature.replace(/^sha256=/, '');
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

describe('Webhook HMAC', () => {
  it('validates correct signature', () => {
    const body = '{"name":"test","date":"2026-01-01"}';
    const secret = 'test-secret-key';
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, secret, sig)).toBe(true);
  });

  it('rejects invalid signature', () => {
    expect(verifyWebhookSignature('{}', 'secret', 'sha256=deadbeef')).toBe(false);
  });
});
