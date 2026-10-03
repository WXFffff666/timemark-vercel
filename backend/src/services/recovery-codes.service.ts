import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { query } from '../db/index.js';

/**
 * TOTP recovery codes — the only way back into a single-user account whose
 * authenticator is lost. Codes are stored as SHA-256 hashes (same pattern as the
 * API key in config.service.ts: hash at rest, plaintext returned exactly once).
 */

/**
 * Deliberately excludes l / o / 0 / 1 / i — characters that are easy to misread
 * when a code is transcribed from paper into a login form.
 */
const RECOVERY_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const CODE_GROUP_LENGTH = 5;
const CODE_GROUP_COUNT = 2;

export const DEFAULT_RECOVERY_CODE_COUNT = 10;
export const MAX_RECOVERY_CODE_COUNT = 20;

/** Lowercase, strips hyphens and whitespace — `AB12x-xy 234` and `ab12xxy234` are the same code. */
export function normalizeRecoveryCode(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\s-]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

function randomCodeGroup(): string {
  let group = '';
  for (let i = 0; i < CODE_GROUP_LENGTH; i += 1) {
    group += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  }
  return group;
}

export function formatRecoveryCode(normalized: string): string {
  return `${normalized.slice(0, CODE_GROUP_LENGTH)}-${normalized.slice(CODE_GROUP_LENGTH)}`;
}

/** Generates `count` unique codes in the `xxxxx-xxxxx` display format. */
export function generateRecoveryCodes(count: number = DEFAULT_RECOVERY_CODE_COUNT): string[] {
  const requested = Math.floor(Number(count));
  const total = Number.isFinite(requested)
    ? Math.max(1, Math.min(requested, MAX_RECOVERY_CODE_COUNT))
    : DEFAULT_RECOVERY_CODE_COUNT;
  const codes = new Set<string>();
  while (codes.size < total) {
    let normalized = '';
    for (let g = 0; g < CODE_GROUP_COUNT; g += 1) {
      normalized += randomCodeGroup();
    }
    codes.add(formatRecoveryCode(normalized));
  }
  return [...codes];
}

/**
 * Replaces the user's stored hashes. Issuing new codes invalidates all old ones —
 * this is the documented behaviour, not a side effect to work around.
 */
export async function replaceRecoveryCodes(userId: number, codes: string[]): Promise<void> {
  const hashes = codes.map((code) => hashRecoveryCode(code));
  await query('UPDATE users SET totp_recovery_codes = $1::jsonb WHERE id = $2', [
    JSON.stringify(hashes),
    userId,
  ]);
}

function readStoredHashes(row: unknown): string[] {
  const value = (row as { totp_recovery_codes?: unknown } | undefined)?.totp_recovery_codes;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  // pg can hand back a JSONB column as a string if it was stored oddly — parse defensively
  // and treat anything that is not an array of strings as "no usable codes".
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      return [];
    }
  }
  return [];
}

export async function countRemainingRecoveryCodes(userId: number): Promise<number> {
  const result = await query('SELECT totp_recovery_codes FROM users WHERE id = $1', [userId]);
  return readStoredHashes(result.rows[0]).length;
}

/**
 * Consumes a code: constant-time compare against every stored hash, and on a hit
 * removes that hash immediately so the same code can never log in twice.
 */
export async function consumeRecoveryCode(userId: number, rawCode: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(rawCode);
  if (!normalized) return false;

  const result = await query('SELECT totp_recovery_codes FROM users WHERE id = $1', [userId]);
  const hashes = readStoredHashes(result.rows[0]);
  if (hashes.length === 0) return false;

  const candidate = Buffer.from(hashRecoveryCode(normalized), 'hex');
  let hitIndex = -1;
  for (let i = 0; i < hashes.length; i += 1) {
    const stored = Buffer.from(hashes[i], 'hex');
    // Hashes are fixed-length hex digests, but a corrupted row could hold anything —
    // length mismatches make timingSafeEqual throw, so check length first.
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
      hitIndex = i;
      break;
    }
  }
  if (hitIndex === -1) return false;

  const remaining = hashes.filter((_, i) => i !== hitIndex);
  await query('UPDATE users SET totp_recovery_codes = $1::jsonb WHERE id = $2', [
    JSON.stringify(remaining),
    userId,
  ]);
  return true;
}
