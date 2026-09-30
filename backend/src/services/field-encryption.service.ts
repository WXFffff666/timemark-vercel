import { decrypt, encrypt } from '@timemark/shared/crypto';
import { query } from '../db/index.js';

/**
 * Field-level encryption for free-text notes and attachment metadata (task 161).
 *
 * This module is the ONLY write/read path for the columns listed in ENCRYPTED_COLUMNS.
 * Every caller goes through encryptFieldValue / decryptFieldValue, which wrap the
 * shared AES-256-GCM helpers in `@timemark/shared/crypto` - the same pair used by
 * notification credentials and `documents.document_number_encrypted`. There is no
 * second crypto implementation.
 *
 * Degradation contract: `decryptFieldValue` never throws and never returns ciphertext.
 * A ciphertext-shaped value that cannot be decrypted (wrong MASTER_KEY, tampered row)
 * reads back as UNDECRYPTABLE_PLACEHOLDER; a legacy plaintext row reads back unchanged.
 */

export const UNDECRYPTABLE_PLACEHOLDER = '[无法解密]';

/** Old hardcoded default key used before auto-generated MASTER_KEY support (mirrors migrate.ts). */
const LEGACY_MASTER_KEY = 'timemark-default-master-key-change-in-production-2026';

/** Legacy ciphertext format minimum: 12-byte IV + 16-byte auth tag + >=1 payload byte. */
const MIN_CIPHERTEXT_BYTES = 29;
/** base64 characters needed to carry MIN_CIPHERTEXT_BYTES. */
const MIN_CIPHERTEXT_CHARS = Math.ceil(MIN_CIPHERTEXT_BYTES / 3) * 4;

/**
 * Columns encrypted at rest, by table - chosen by reading what actually holds free-text
 * notes/metadata (task 161):
 * - `documents.notes`, `maintenance_plans.notes`, `maintenance_logs.notes` (free text)
 * - `interactions.summary` (free-text touchpoint summary)
 * - `attachments.filename` / `attachments.content_type` (metadata; filename is the
 *   user-supplied free-text label, content_type the mime).
 *
 * Deliberately NOT encrypted: `attachments.byte_size` is a numeric operational value
 * (positive CHECK, Content-Length, retention accounting), not free text; `sha256` and
 * `storage_key` are derived/internal object references needed for integrity and object
 * addressing. Encrypting them would require a destructive column type change and break
 * numeric semantics, so no DDL is needed for this feature.
 *
 * `events` is absent on purpose: the table has no notes/description column (schema.pg.sql
 * + migrations checked); its free-text `name`/`person_name` are trigram-searchable display
 * fields and are not encrypted.
 */
export const ENCRYPTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  attachments: ['filename', 'content_type'],
  documents: ['notes'],
  interactions: ['summary'],
  maintenance_plans: ['notes'],
  maintenance_logs: ['notes'],
};

function currentMasterKey(): string | null {
  const key = process.env.MASTER_KEY;
  return key && key.trim() !== '' ? key : null;
}

/** Shape test only: canonical base64 carrying at least a legacy-format ciphertext. */
function isCiphertextShaped(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_CIPHERTEXT_CHARS) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return false;
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length < MIN_CIPHERTEXT_BYTES) return false;
  return decoded.toString('base64').replace(/=+$/, '') === trimmed.replace(/=+$/, '');
}

/**
 * Encrypt one free-text value before a write. Idempotent: a value already encrypted with
 * the current key - or shaped like legacy/foreign ciphertext - is returned untouched, so a
 * re-import or a re-run of the migration can never double-encrypt. Without MASTER_KEY the
 * value is returned as-is (dev/test; the startup migration skips too, same semantics as
 * `migrateEncryptionKey()`).
 */
export function encryptFieldValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value === '') return '';
  const key = currentMasterKey();
  if (!key) return value;
  try {
    decrypt(value, key);
    return value; // already encrypted with the current key - never wrap twice
  } catch {
    // fall through to the shape test
  }
  if (isCiphertextShaped(value)) return value; // legacy/foreign ciphertext; migration re-wraps it
  return encrypt(value, key);
}

/**
 * Decrypt one value at read time. Never throws:
 * - current-key ciphertext -> plaintext
 * - legacy-key ciphertext -> plaintext (the startup migration re-wraps it with the current key)
 * - unencrypted legacy plaintext -> returned unchanged
 * - ciphertext-shaped but undecryptable -> `placeholder` (default UNDECRYPTABLE_PLACEHOLDER)
 */
export function decryptFieldValue(
  value: unknown,
  placeholder: string = UNDECRYPTABLE_PLACEHOLDER,
): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : String(value);
  if (text === '') return text;
  const key = currentMasterKey();
  if (key) {
    try {
      return decrypt(text, key);
    } catch {
      // try the legacy key next
    }
    try {
      return decrypt(text, LEGACY_MASTER_KEY);
    } catch {
      // not ciphertext under either key
    }
  }
  return isCiphertextShaped(text) ? placeholder : text;
}

/** Decrypt an explicit encrypted-column list on one row (export payloads). */
export function decryptRowFields<T extends Record<string, unknown>>(row: T, table: string): T {
  const columns = ENCRYPTED_COLUMNS[table];
  if (!columns) return row;
  const out: Record<string, unknown> = { ...row };
  for (const column of columns) {
    if (out[column] !== null && out[column] !== undefined) {
      out[column] = decryptFieldValue(out[column]);
    }
  }
  return out as T;
}

/**
 * Startup migration for legacy plaintext rows, mirroring `migrateEncryptionKey()`:
 * scans every ENCRYPTED_COLUMNS table, encrypts plaintext rows with the current MASTER_KEY
 * and re-wraps legacy-key ciphertext. Already-current ciphertext and undecryptable
 * ciphertext are skipped, so a second run encrypts nothing (idempotent, never double-encrypts).
 * Never throws: a missing table/column is logged and skipped so bootstrap cannot break.
 */
export async function migrateFieldEncryption(): Promise<{ rows: number }> {
  const key = currentMasterKey();
  if (!key) {
    console.warn('[Migration] MASTER_KEY not set, skipping field encryption migration');
    return { rows: 0 };
  }

  let migratedRows = 0;
  for (const [table, columns] of Object.entries(ENCRYPTED_COLUMNS)) {
    const predicates = columns.map((column) => `${column} IS NOT NULL AND ${column} <> ''`).join(' OR ');
    let rows: Array<Record<string, unknown>>;
    try {
      const result = await query(`SELECT id, ${columns.join(', ')} FROM ${table} WHERE ${predicates}`);
      rows = result.rows as Array<Record<string, unknown>>;
    } catch (error) {
      console.warn(
        `[Migration] Field encryption skipped for ${table}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    for (const row of rows) {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const column of columns) {
        const raw = row[column];
        if (raw === null || raw === undefined) continue;
        const value = String(raw);
        if (value === '') continue;

        try {
          decrypt(value, key);
          continue; // already encrypted with the current key
        } catch {
          // not current-key ciphertext: legacy key, plaintext, or corrupt
        }

        let plaintext = value;
        try {
          plaintext = decrypt(value, LEGACY_MASTER_KEY);
        } catch {
          if (isCiphertextShaped(value)) continue; // foreign/corrupt ciphertext - never re-wrap
          // else: legacy plaintext row - encrypt below
        }
        values.push(encrypt(plaintext, key));
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0) continue;

      values.push(row.id);
      try {
        await query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
        migratedRows += 1;
      } catch (error) {
        console.warn(
          `[Migration] Failed to encrypt ${table} row ${String(row.id)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (migratedRows > 0) {
    console.log(`[Migration] Encrypted ${migratedRows} row(s) of notes/attachment metadata`);
  } else {
    console.log('[Migration] No legacy plaintext notes/attachment metadata found, field encryption migration complete');
  }
  return { rows: migratedRows };
}
