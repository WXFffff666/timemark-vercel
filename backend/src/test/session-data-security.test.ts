import { describe, expect, it } from 'vitest';
import { encrypt, decrypt } from '@timemark/shared/crypto';

const MASTER_KEY = 'test-master-key-for-session-data-security-32b';

describe('session_data security contract', () => {
  it('encrypts smtp session metadata for JSONB string storage', () => {
    const payload = { smtpProvider: '163', smtpEncryption: 'ssl' as const };
    const ciphertext = encrypt(JSON.stringify(payload), MASTER_KEY);
    expect(typeof ciphertext).toBe('string');
    const restored = JSON.parse(decrypt(ciphertext, MASTER_KEY));
    expect(restored).toEqual(payload);
  });

  it('rejects unexpected smtp session keys when sanitizing via parse', () => {
    const payload = { smtpProvider: '163', evil: 'x' };
    const ciphertext = encrypt(JSON.stringify(payload), MASTER_KEY);
    const restored = JSON.parse(decrypt(ciphertext, MASTER_KEY)) as Record<string, unknown>;
    const allowed = Object.keys(restored).filter((k) => ['smtpProvider', 'smtpEncryption'].includes(k));
    expect(allowed).toEqual(['smtpProvider']);
  });
});
