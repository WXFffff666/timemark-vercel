import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from 'crypto';

function verifyCronBearer(authHeader: string, secret: string): boolean {
  const expected = `Bearer ${secret}`;
  try {
    const a = Buffer.from(authHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

describe('cron auth', () => {
  it('accepts valid bearer token', () => {
    expect(verifyCronBearer('Bearer test-secret', 'test-secret')).toBe(true);
  });

  it('rejects wrong bearer token', () => {
    expect(verifyCronBearer('Bearer wrong', 'test-secret')).toBe(false);
  });

  it('rejects missing bearer prefix', () => {
    expect(verifyCronBearer('test-secret', 'test-secret')).toBe(false);
  });
});
