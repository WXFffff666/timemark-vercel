import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '@timemark/shared/crypto';

describe('Crypto', () => {
  const key = 'a'.repeat(64);

  it('encrypt then decrypt returns original', () => {
    const text = 'Hello TimeMark';
    expect(decrypt(encrypt(text, key), key)).toBe(text);
  });

  it('encrypted differs from original', () => {
    const text = 'secret';
    expect(encrypt(text, key)).not.toBe(text);
  });

  it('wrong key throws', () => {
    const encrypted = encrypt('test', key);
    expect(() => decrypt(encrypted, 'b'.repeat(64))).toThrow();
  });

  it('handles unicode', () => {
    const text = '你好世界🎂';
    expect(decrypt(encrypt(text, key), key)).toBe(text);
  });
});
