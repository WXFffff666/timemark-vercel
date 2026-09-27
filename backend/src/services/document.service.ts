import { query } from '../db/index.js';
import { encrypt, decrypt } from '@timemark/shared/crypto';
import { toYmdString } from '@timemark/shared';
import type { CreateDocumentInput, UpdateDocumentInput } from '@timemark/shared';
import { getAttachment, reassignAttachment, type AttachmentRecord } from './attachment.service.js';
import { logFireAndForget } from '../utils/logger.js';

/**
 * 证件保险箱数据访问层（todo 54）。
 *
 * - `document_number_encrypted` 是 AES-256-GCM 密文，密钥约定与通知凭证完全一致
 *   （`@timemark/shared/crypto` + MASTER_KEY，含 LEGACY_MASTER_KEY 迁移回退）。
 * - 明文只在一次性 reveal 端点返回；列表/详情只给 `numberConfigured` 标志，
 *   序列化器根本不产生 document_number 字段（比"记得删字段"更难出错）。
 * - 解密失败（MASTER_KEY 已更换等）**fail closed**：返回 `undecryptable`，
 *   绝不回退输出密文/明文，也绝不让列表端点崩溃（列表从不解密）。
 * - 所有 SQL 按 user_id 限定；链接/解链附件同样双端校验归属。
 * - 证件图片只存附件存储；本表无任何字节列。
 */

const LEGACY_MASTER_KEY = 'timemark-default-master-key-change-in-production-2026';

function getMasterKey(): string {
  const key = process.env.MASTER_KEY;
  if (!key) {
    throw new Error('MASTER_KEY is not set. Ensure initSecretKeys() is called before using document service.');
  }
  return key;
}

export interface DocumentRecord {
  id: number;
  user_id: number;
  profile_id: number | null;
  kind: string;
  title: string;
  issuer: string | null;
  /** Ciphertext only. Never serialized into a public DTO. */
  document_number_encrypted: string | null;
  issued_at: string | null;
  expires_at: string | null;
  country: string | null;
  notes: string | null;
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/** Public DTO: has `numberConfigured`, never the encrypted value (mirrors tokenConfigured). */
export interface PublicDocument {
  id: number;
  user_id: number;
  profile_id: number | null;
  kind: string;
  title: string;
  issuer: string | null;
  issued_at: string | null;
  expires_at: string | null;
  country: string | null;
  notes: string | null;
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
  numberConfigured: boolean;
}

type RawRow = Record<string, unknown>;

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function serializeDocumentRow(row: RawRow): DocumentRecord {
  const reminderConfig = row.reminder_config;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    profile_id: toNumberOrNull(row.profile_id),
    kind: String(row.kind),
    title: String(row.title),
    issuer: row.issuer == null ? null : String(row.issuer),
    document_number_encrypted:
      row.document_number_encrypted == null ? null : String(row.document_number_encrypted),
    issued_at: toYmdString(row.issued_at),
    expires_at: toYmdString(row.expires_at),
    country: row.country == null ? null : String(row.country),
    notes: row.notes == null ? null : String(row.notes),
    reminder_config:
      reminderConfig && typeof reminderConfig === 'object'
        ? (reminderConfig as Record<string, unknown>)
        : reminderConfig
          ? (JSON.parse(String(reminderConfig)) as Record<string, unknown>)
          : null,
    is_active: row.is_active !== false,
    created_at: toIsoOrNull(row.created_at),
    updated_at: toIsoOrNull(row.updated_at),
  };
}

export function toPublicDocument(record: DocumentRecord): PublicDocument {
  return {
    id: record.id,
    user_id: record.user_id,
    profile_id: record.profile_id,
    kind: record.kind,
    title: record.title,
    issuer: record.issuer,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
    country: record.country,
    notes: record.notes,
    reminder_config: record.reminder_config,
    is_active: record.is_active,
    created_at: record.created_at,
    updated_at: record.updated_at,
    numberConfigured: !!record.document_number_encrypted,
  };
}

export interface DocumentFilters {
  kind?: string;
  active?: boolean;
  /** title / issuer 子串（大小写不敏感）；证件号码已加密，绝不参与搜索 */
  q?: string;
}

export async function listDocuments(
  userId: number,
  filters: DocumentFilters,
  page: number,
  limit: number,
): Promise<{ items: DocumentRecord[]; total: number }> {
  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];

  if (filters.kind) {
    params.push(filters.kind);
    where.push(`kind = $${params.length}`);
  }
  if (filters.active !== undefined) {
    params.push(filters.active);
    where.push(`is_active = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(title ILIKE $${params.length} OR issuer ILIKE $${params.length})`);
  }

  const whereSql = where.join(' AND ');
  const offset = (page - 1) * limit;

  const totalResult = await query(
    `SELECT COUNT(*)::int AS count FROM documents WHERE ${whereSql}`,
    params,
  );
  const rows = await query(
    `SELECT * FROM documents WHERE ${whereSql}
     ORDER BY expires_at ASC NULLS LAST, id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    items: rows.rows.map((row) => serializeDocumentRow(row as RawRow)),
    total: Number(totalResult.rows[0]?.count ?? 0),
  };
}

export async function listExpiringDocuments(userId: number, days: number): Promise<DocumentRecord[]> {
  const result = await query(
    `SELECT * FROM documents
     WHERE user_id = $1 AND is_active = TRUE
       AND expires_at IS NOT NULL
       AND expires_at <= CURRENT_DATE + ($2::int * INTERVAL '1 day')
     ORDER BY expires_at ASC, id ASC`,
    [userId, days],
  );
  return result.rows
    .map((row) => serializeDocumentRow(row as RawRow))
    .filter((document) => document.expires_at !== null);
}

export async function getDocument(userId: number, id: number): Promise<DocumentRecord | null> {
  const result = await query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = result.rows[0];
  return row ? serializeDocumentRow(row as RawRow) : null;
}

function encryptNumber(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return encrypt(trimmed, getMasterKey());
}

export async function createDocument(
  userId: number,
  input: CreateDocumentInput,
): Promise<DocumentRecord> {
  const result = await query(
    `INSERT INTO documents (
       user_id, profile_id, kind, title, issuer, document_number_encrypted,
       issued_at, expires_at, country, notes, reminder_config, is_active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      userId,
      input.profileId ?? null,
      input.kind,
      input.title,
      input.issuer ?? null,
      encryptNumber(input.documentNumber),
      input.issuedAt ?? null,
      input.expiresAt ?? null,
      input.country ?? null,
      input.notes ?? null,
      input.reminderConfig ? JSON.stringify(input.reminderConfig) : null,
      input.isActive ?? true,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('证件行插入未返回数据');
  return serializeDocumentRow(row as RawRow);
}

const FIELD_MAP: ReadonlyArray<[keyof UpdateDocumentInput, string]> = [
  ['kind', 'kind'],
  ['title', 'title'],
  ['issuer', 'issuer'],
  ['issuedAt', 'issued_at'],
  ['expiresAt', 'expires_at'],
  ['country', 'country'],
  ['notes', 'notes'],
  ['isActive', 'is_active'],
  ['profileId', 'profile_id'],
];

/**
 * PATCH semantics: absent fields are untouched; `documentNumber: null` (or '') clears the
 * number, a non-empty string replaces it (re-encrypted). The response never echoes it.
 */
export async function updateDocument(
  userId: number,
  id: number,
  input: UpdateDocumentInput,
): Promise<DocumentRecord | null> {
  const sets: string[] = [];
  // $1 = id, $2 = user_id; every SET value starts at $3.
  const params: unknown[] = [id, userId];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  for (const [key, column] of FIELD_MAP) {
    if (input[key] !== undefined) push(column, input[key] ?? null);
  }
  if (input.reminderConfig !== undefined) {
    push('reminder_config', input.reminderConfig === null ? null : JSON.stringify(input.reminderConfig));
  }
  if (input.documentNumber !== undefined) {
    push('document_number_encrypted', encryptNumber(input.documentNumber));
  }

  if (sets.length === 0) return getDocument(userId, id);
  sets.push('updated_at = CURRENT_TIMESTAMP');

  const result = await query(
    `UPDATE documents SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
    params,
  );
  const row = result.rows[0];
  return row ? serializeDocumentRow(row as RawRow) : null;
}

export async function deleteDocument(userId: number, id: number): Promise<boolean> {
  const result = await query('DELETE FROM documents WHERE id = $1 AND user_id = $2', [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

export interface DecryptedNumber {
  plaintext: string;
  /** Set when the value was legacy-encrypted and should be re-encrypted with MASTER_KEY. */
  reEncrypted: string | null;
}

/**
 * Mirrors config.service's decrypt migration: current key -> legacy key -> fail closed.
 * A wrong MASTER_KEY yields `null` (never ciphertext, never plaintext, never a throw).
 */
export function decryptDocumentNumber(ciphertext: string): DecryptedNumber | null {
  let currentKey: string;
  try {
    currentKey = getMasterKey();
  } catch {
    return null;
  }

  try {
    return { plaintext: decrypt(ciphertext, currentKey), reEncrypted: null };
  } catch {
    // Try the legacy key used before auto-generated MASTER_KEY support.
  }

  try {
    const plaintext = decrypt(ciphertext, LEGACY_MASTER_KEY);
    return { plaintext, reEncrypted: encrypt(plaintext, currentKey) };
  } catch {
    return null;
  }
}

export type RevealResult =
  | { status: 'ok'; number: string }
  | { status: 'not_found' }
  | { status: 'not_configured' }
  | { status: 'undecryptable' };

/** One-shot reveal. Never returns the ciphertext; undecryptable values fail closed. */
export async function revealDocumentNumber(userId: number, id: number): Promise<RevealResult> {
  const record = await getDocument(userId, id);
  if (!record) return { status: 'not_found' };
  if (!record.document_number_encrypted) return { status: 'not_configured' };

  const decrypted = decryptDocumentNumber(record.document_number_encrypted);
  if (!decrypted) return { status: 'undecryptable' };

  if (decrypted.reEncrypted) {
    await query(
      'UPDATE documents SET document_number_encrypted = $3 WHERE id = $1 AND user_id = $2',
      [id, userId, decrypted.reEncrypted],
    ).catch(
      logFireAndForget('documents.reencrypt_failed', 'Failed to re-encrypt a legacy document number'),
    );
  }
  return { status: 'ok', number: decrypted.plaintext };
}

export type LinkAttachmentResult =
  | { status: 'ok'; attachment: AttachmentRecord }
  | { status: 'document_not_found' }
  | { status: 'attachment_not_found' };

/** Attach an existing user-owned attachment to this document (both ends owner-checked). */
export async function linkDocumentAttachment(
  userId: number,
  documentId: number,
  attachmentId: number,
): Promise<LinkAttachmentResult> {
  const document = await getDocument(userId, documentId);
  if (!document) return { status: 'document_not_found' };
  const attachment = await getAttachment(userId, attachmentId);
  if (!attachment) return { status: 'attachment_not_found' };

  const updated = await reassignAttachment(userId, attachmentId, 'document', documentId);
  if (!updated) return { status: 'attachment_not_found' };
  return { status: 'ok', attachment: updated };
}

/** Unlink only an attachment that is actually linked to this user's document. */
export async function unlinkDocumentAttachment(
  userId: number,
  documentId: number,
  attachmentId: number,
): Promise<{ status: 'ok'; attachment: AttachmentRecord } | { status: 'not_found' }> {
  const document = await getDocument(userId, documentId);
  if (!document) return { status: 'not_found' };

  const attachment = await getAttachment(userId, attachmentId);
  if (
    !attachment ||
    attachment.owner_type !== 'document' ||
    attachment.owner_id !== documentId
  ) {
    return { status: 'not_found' };
  }

  const updated = await reassignAttachment(userId, attachmentId, null, null);
  if (!updated) return { status: 'not_found' };
  return { status: 'ok', attachment: updated };
}
