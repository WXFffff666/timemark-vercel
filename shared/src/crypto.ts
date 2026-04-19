import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;

// Legacy salt for backward compatibility with data encrypted before random-salt migration
const LEGACY_SALT = 'timemark-salt-2026';

// Old format: iv(12) + authTag(16) + encrypted(N) — minimum 29 bytes
// New format: salt(16) + iv(12) + authTag(16) + encrypted(N) — minimum 45 bytes
const LEGACY_MIN_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH + 1; // 29
const NEW_MIN_LENGTH = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1; // 45

function deriveKey(masterKey: string, salt: string | Buffer): Buffer {
  return crypto.pbkdf2Sync(masterKey, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Detect if ciphertext was encrypted with the old fixed-salt format.
 * Old format: iv(12) + authTag(16) + encrypted — no salt prefix.
 * New format: salt(16) + iv(12) + authTag(16) + encrypted.
 * 
 * Heuristic: if the data length is less than NEW_MIN_LENGTH, it's definitely old format.
 * For ambiguous lengths, we try new format first, fall back to legacy on failure.
 */
export function isLegacyFormat(ciphertext: string): boolean {
  try {
    const data = Buffer.from(ciphertext, 'base64');
    // If data is too short for new format, it must be legacy
    if (data.length < NEW_MIN_LENGTH) return true;
    // For longer data, we can't be 100% sure from length alone.
    // We use a marker: new format salt is random bytes, old format starts with IV.
    // Since we can't distinguish reliably by content, we'll try new format first in decrypt().
    return false;
  } catch {
    return true;
  }
}

export function encrypt(plaintext: string, masterKey: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(masterKey, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  // New format: salt(16) + iv(12) + authTag(16) + encrypted(N)
  const result = Buffer.concat([salt, iv, authTag, encrypted]);
  return result.toString('base64');
}

export function decrypt(ciphertext: string, masterKey: string): string {
  const data = Buffer.from(ciphertext, 'base64');
  
  if (data.length < LEGACY_MIN_LENGTH) {
    throw new Error('Invalid ciphertext format');
  }
  
  // Try new format first (salt + iv + authTag + encrypted)
  if (data.length >= NEW_MIN_LENGTH) {
    try {
      return decryptNewFormat(data, masterKey);
    } catch {
      // Fall through to legacy format
    }
  }
  
  // Fall back to legacy format (iv + authTag + encrypted)
  return decryptLegacyFormat(data, masterKey);
}

function decryptNewFormat(data: Buffer, masterKey: string): string {
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  
  const key = deriveKey(masterKey, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function decryptLegacyFormat(data: Buffer, masterKey: string): string {
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  
  const key = deriveKey(masterKey, LEGACY_SALT);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  try {
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error('Decryption failed: invalid key or tampered data');
  }
}

export function generateKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
