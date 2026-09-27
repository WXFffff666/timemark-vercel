import { randomUUID } from 'node:crypto';
import { query } from '../db/index.js';
import { ATTACHMENT_MAX_BYTES, type AttachmentOwnerType } from '@timemark/shared';
import { deleteObject, getObject, putObject, type StoredObject } from './storage.service.js';
import { logFireAndForget } from '../utils/logger.js';

/**
 * 附件数据访问与存储编排（todo 53）。
 *
 * 关键约束：
 * - 所有 SQL 都带 `user_id = $n`：跨用户读/删在 SQL 层就不可能命中（路由 404）。
 * - owner_type/owner_id 必须指向**当前用户拥有的**对应实体行（多态校验），
 *   否则拒绝（404）——不能挂到他人在的证件/事件上。
 * - 字节只进对象存储（storage.service），Postgres 行只保存元数据。
 * - 上传上限 2 MB 在**调用存储之前**强制；插入失败时回滚已上传对象（deleteObject）。
 * - 存储 key 只由内部生成（user id + uuid + 内容类型扩展名），绝不使用用户文件名。
 */

const OWNER_TABLES: Record<AttachmentOwnerType, string> = {
  document: 'documents',
  expiry: 'expiry_items',
  inventory: 'inventory_items',
  maintenance: 'maintenance_plans',
  event: 'events',
};

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'text/plain': 'txt',
};

export interface AttachmentRecord {
  id: number;
  user_id: number;
  owner_type: AttachmentOwnerType | null;
  owner_id: number | null;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  storage_key: string;
  created_at: string | null;
}

/** Public DTO: never includes storage_key; download_url points at the API, not the store. */
export interface PublicAttachment {
  id: number;
  owner_type: AttachmentOwnerType | null;
  owner_id: number | null;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  created_at: string | null;
  download_url: string;
}

export class AttachmentTooLargeError extends Error {
  readonly code = 'ATTACHMENT_TOO_LARGE';
  constructor(byteSize: number) {
    super(`附件超过 ${Math.floor(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB 上限（实际 ${byteSize} 字节）`);
    this.name = 'AttachmentTooLargeError';
  }
}

export class AttachmentEmptyError extends Error {
  readonly code = 'ATTACHMENT_EMPTY';
  constructor() {
    super('不能上传空文件');
    this.name = 'AttachmentEmptyError';
  }
}

export class AttachmentOwnerNotFoundError extends Error {
  readonly code = 'ATTACHMENT_OWNER_NOT_FOUND';
  constructor() {
    super('附件归属对象不存在');
    this.name = 'AttachmentOwnerNotFoundError';
  }
}

export class AttachmentContentTypeMismatchError extends Error {
  readonly code = 'ATTACHMENT_CONTENT_TYPE_MISMATCH';
  constructor(declared: string, actual: string | null) {
    super(
      actual
        ? `声明的类型 ${declared} 与实际文件内容（${actual}）不一致`
        : `声明的类型 ${declared} 与实际文件内容不一致（无法识别实际类型）`,
    );
    this.name = 'AttachmentContentTypeMismatchError';
  }
}

export function isAttachmentOwnerType(value: unknown): value is AttachmentOwnerType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OWNER_TABLES, value);
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function serializeAttachmentRow(row: Record<string, unknown>): AttachmentRecord {
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    owner_type: (row.owner_type as AttachmentOwnerType | null) ?? null,
    owner_id: row.owner_id == null ? null : Number(row.owner_id),
    filename: String(row.filename),
    content_type: String(row.content_type),
    byte_size: Number(row.byte_size),
    sha256: String(row.sha256),
    storage_key: String(row.storage_key),
    created_at: toIsoOrNull(row.created_at),
  };
}

export function toPublicAttachment(record: AttachmentRecord): PublicAttachment {
  return {
    id: record.id,
    owner_type: record.owner_type,
    owner_id: record.owner_id,
    filename: record.filename,
    content_type: record.content_type,
    byte_size: record.byte_size,
    sha256: record.sha256,
    created_at: record.created_at,
    download_url: `/api/attachments/${record.id}`,
  };
}

/** Owner row must exist AND belong to this user (polymorphic table chosen from a fixed map). */
export async function ownerExists(
  userId: number,
  ownerType: AttachmentOwnerType,
  ownerId: number,
): Promise<boolean> {
  const table = OWNER_TABLES[ownerType];
  const result = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND user_id = $2`, [ownerId, userId]);
  return result.rows.length > 0;
}

/** Storage key shape is entirely internal: no user filename ever reaches it. */
export function buildStorageKey(userId: number, contentType: string): string {
  const extension = CONTENT_TYPE_EXTENSIONS[contentType] ?? 'bin';
  return `attachments/${userId}/${randomUUID()}.${extension}`;
}

export interface CreateAttachmentData {
  ownerType: AttachmentOwnerType;
  ownerId: number;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export async function createAttachment(
  userId: number,
  data: CreateAttachmentData,
): Promise<AttachmentRecord> {
  // Cap and emptiness are enforced BEFORE any storage/network call.
  if (data.bytes.byteLength === 0) throw new AttachmentEmptyError();
  if (data.bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new AttachmentTooLargeError(data.bytes.byteLength);

  if (!(await ownerExists(userId, data.ownerType, data.ownerId))) {
    throw new AttachmentOwnerNotFoundError();
  }

  const storageKey = buildStorageKey(userId, data.contentType);
  const stored = await putObject(storageKey, data.bytes, data.contentType);

  try {
    const result = await query(
      `INSERT INTO attachments (
         user_id, owner_type, owner_id, filename, content_type, byte_size, sha256, storage_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        userId,
        data.ownerType,
        data.ownerId,
        data.filename,
        data.contentType,
        stored.size,
        stored.sha256,
        storageKey,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('附件行插入未返回数据');
    return serializeAttachmentRow(row as Record<string, unknown>);
  } catch (error) {
    // Roll back the uploaded object so a failed insert cannot leave an orphan blob.
    await deleteObject(storageKey).catch(
      logFireAndForget('attachment.rollback_delete_failed', 'Failed to roll back an uploaded attachment object'),
    );
    throw error;
  }
}

export interface AttachmentFilters {
  ownerType?: AttachmentOwnerType;
  ownerId?: number;
}

export async function listAttachments(
  userId: number,
  filters: AttachmentFilters,
  page: number,
  limit: number,
): Promise<{ items: AttachmentRecord[]; total: number }> {
  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];
  if (filters.ownerType) {
    params.push(filters.ownerType);
    where.push(`owner_type = $${params.length}`);
  }
  if (filters.ownerId !== undefined) {
    params.push(filters.ownerId);
    where.push(`owner_id = $${params.length}`);
  }
  const whereSql = where.join(' AND ');
  const offset = (page - 1) * limit;

  const totalResult = await query(
    `SELECT COUNT(*)::int AS count FROM attachments WHERE ${whereSql}`,
    params,
  );
  const rows = await query(
    `SELECT * FROM attachments WHERE ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    items: rows.rows.map((row) => serializeAttachmentRow(row as Record<string, unknown>)),
    total: Number(totalResult.rows[0]?.count ?? 0),
  };
}

export async function getAttachment(userId: number, id: number): Promise<AttachmentRecord | null> {
  const result = await query('SELECT * FROM attachments WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = result.rows[0];
  return row ? serializeAttachmentRow(row as Record<string, unknown>) : null;
}

/** Open the stored bytes for a row the user owns. `null` = object missing from the store. */
export async function openAttachmentObject(
  record: AttachmentRecord,
): Promise<StoredObject | null> {
  return getObject(record.storage_key);
}

/**
 * Delete the row first (source of truth) and then the object; a failed object delete is
 * logged and left for the orphan purge (todo 57) so a transient Blob error cannot fail
 * the delete or resurrect the row. Returns the deleted record, or null when not found.
 */
export async function deleteAttachment(userId: number, id: number): Promise<AttachmentRecord | null> {
  const result = await query(
    'DELETE FROM attachments WHERE id = $1 AND user_id = $2 RETURNING *',
    [id, userId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const record = serializeAttachmentRow(row as Record<string, unknown>);
  await deleteObject(record.storage_key).catch(
    logFireAndForget('attachment.object_delete_failed', 'Failed to delete an attachment object; purge will retry'),
  );
  return record;
}

/** Link/unlink support (todo 54): move an existing, user-owned attachment to another owner. */
export async function reassignAttachment(
  userId: number,
  id: number,
  ownerType: AttachmentOwnerType | null,
  ownerId: number | null,
): Promise<AttachmentRecord | null> {
  const result = await query(
    `UPDATE attachments
     SET owner_type = $3, owner_id = $4
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, ownerType, ownerId],
  );
  const row = result.rows[0];
  return row ? serializeAttachmentRow(row as Record<string, unknown>) : null;
}

/** Content sniffing (magic bytes) used to reject declared/actual mismatches. */
export function sniffContentType(bytes: Uint8Array): string | null {
  const startsWith = (signature: number[], offset = 0): boolean =>
    bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);
  const asciiAt = (offset: number, text: string): boolean =>
    bytes.length >= offset + text.length &&
    [...text].every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));

  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiAt(0, 'RIFF') && asciiAt(8, 'WEBP')) return 'image/webp';
  if (isProbablyText(bytes)) return 'text/plain';
  return null;
}

/** UTF-8 decodable and free of NUL bytes; binary payloads (exe/zip/...) fail this. */
function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export interface ContentTypeCheck {
  declared: string;
  actual: string | null;
}

/**
 * Policy: **reject** a declared/actual mismatch (fail closed) rather than silently
 * correcting the type. `null` actual = unrecognized bytes (e.g. an .exe renamed .pdf).
 */
export function assertContentTypeMatches(bytes: Uint8Array, declared: string): void {
  const actual = sniffContentType(bytes);
  if (actual !== declared) throw new AttachmentContentTypeMismatchError(declared, actual);
}
