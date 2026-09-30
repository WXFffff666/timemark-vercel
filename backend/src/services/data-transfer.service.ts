import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { decrypt } from '@timemark/shared/crypto';
import { createLogger } from '../utils/logger.js';
import { encryptFieldValue } from './field-encryption.service.js';

/**
 * 数据导入/导出：D1/D12/D2 新实体（todo 58）。
 *
 * 设计要点：
 * - **导出**在 data.ts 中按显式列清单查询；本模块也导出版本与加密元数据规则。
 * - **导入**在单个事务里执行（db.withTransaction）：任何一条失败 → ROLLBACK，全不落库。
 * - **幂等**：按导出中的 `id` 显式插入；带 `updated_at` 的表用
 *   `ON CONFLICT (id) DO UPDATE ... WHERE 现有行属于同一用户 AND 现有 updated_at < 新值`
 *   —— 第二次导入同一条数据不会产生重复行，也不会覆盖更新的行；无 `updated_at` 的
 *   记录表（历史/日志/附件）用 `ON CONFLICT (id) DO NOTHING`。
 * - **加密**：`document_number_encrypted` 原样搬运（导出不含明文）。字段级加密列
 *   （documents.notes、maintenance_*.notes、attachments.filename/content_type，任务 161）
 *   在导出端解密、在导入端用当前 MASTER_KEY 重新加密（形状判定防止二次加密）。导入前先比对导出
 *   元数据里的 `masterKeyFingerprint`，并用当前 MASTER_KEY 逐条试解密；任一不符都
 *   在**写任何行之前**拒绝（镜像通知凭证的解密迁移失败语义，但导入不做 legacy 回退）。
 * - 用户归属：顶层表强制 `user_id = 当前用户`（忽略载荷中的 user_id）；子表
 *   （expiry_history / maintenance_logs）只在父行属于当前用户时才写入。
 */

const log = createLogger('data-transfer');

export const DATA_EXPORT_VERSION = '2.0';
export const MAX_SUPPORTED_EXPORT_MAJOR = 2;

export class DataImportValidationError extends Error {
  readonly code = 'DATA_IMPORT_VALIDATION';
  constructor(message: string) {
    super(message);
    this.name = 'DataImportValidationError';
  }
}

export class DataImportEncryptionError extends Error {
  readonly code = 'DATA_IMPORT_KEY_MISMATCH';
  constructor(message: string) {
    super(message);
    this.name = 'DataImportEncryptionError';
  }
}

function currentMasterKey(): string | null {
  const key = process.env.MASTER_KEY?.trim();
  return key ? key : null;
}

/**
 * Fingerprint of the key an export's encrypted columns were produced with.
 * SHA-256 over a fixed prefix + the key: not reversible, changes with the key.
 */
export function exportKeyFingerprint(): string | null {
  const key = currentMasterKey();
  if (!key) return null;
  return createHash('sha256').update(`timemark-data-export-v1:${key}`).digest('hex');
}

export function isSupportedExportVersion(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  const major = Number.parseInt(raw.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= 1 && major <= MAX_SUPPORTED_EXPORT_MAJOR;
}

interface EntitySpec {
  /** payload key (camelCase) */
  key: string;
  table: string;
  /** 除 id / user_id 之外的列（全部显式列出，绝不遍历载荷 key 拼 SQL） */
  columns: readonly string[];
  /** 有 updated_at 的表走 newer-wins upsert；否则 DO NOTHING */
  updatedAtColumn?: string;
  /** 必须验证的日期时间列（缺失/非法 → 跳过该行，绝不猜测） */
  timestampColumns: readonly string[];
  /** JSONB 列（对象 → JSON 字符串） */
  jsonColumns?: readonly string[];
  /** TEXT[] 列 */
  arrayColumns?: readonly string[];
  /** 字段级加密列（任务 161）：导入时用当前 MASTER_KEY 加密（幂等，绝不二次加密） */
  encryptedColumns?: readonly string[];
  /** 子表：父行必须属于当前用户 */
  parent?: { column: string; table: string };
}

export const ENTITY_SPECS: readonly EntitySpec[] = [
  {
    key: 'expiryItems',
    table: 'expiry_items',
    columns: [
      'profile_id', 'kind', 'title', 'vendor', 'amount_cents', 'currency', 'cycle', 'cycle_days',
      'start_date', 'next_due_date', 'auto_renew', 'notes', 'tags', 'reminder_config', 'is_active',
      'created_at', 'updated_at',
    ],
    updatedAtColumn: 'updated_at',
    timestampColumns: ['created_at', 'updated_at'],
    jsonColumns: ['reminder_config'],
    arrayColumns: ['tags'],
  },
  {
    key: 'expiryHistory',
    table: 'expiry_history',
    columns: ['item_id', 'action', 'from_date', 'to_date', 'amount_cents', 'created_at'],
    timestampColumns: ['created_at'],
    parent: { column: 'item_id', table: 'expiry_items' },
  },
  {
    key: 'inventoryItems',
    table: 'inventory_items',
    columns: [
      'profile_id', 'name', 'category', 'quantity', 'unit', 'low_stock_threshold', 'purchased_at',
      'expires_at', 'location', 'notes', 'reminder_config', 'is_active', 'created_at', 'updated_at',
    ],
    updatedAtColumn: 'updated_at',
    timestampColumns: ['created_at', 'updated_at'],
    jsonColumns: ['reminder_config'],
  },
  {
    key: 'maintenancePlans',
    table: 'maintenance_plans',
    columns: [
      'profile_id', 'asset_name', 'asset_kind', 'interval_days', 'interval_usage', 'usage_unit',
      'current_usage', 'last_done_at', 'next_due_at', 'next_due_usage', 'notes', 'reminder_config',
      'is_active', 'created_at', 'updated_at',
    ],
    updatedAtColumn: 'updated_at',
    timestampColumns: ['created_at', 'updated_at'],
    jsonColumns: ['reminder_config'],
    encryptedColumns: ['notes'],
  },
  {
    key: 'maintenanceLogs',
    table: 'maintenance_logs',
    columns: ['plan_id', 'done_at', 'usage_at', 'cost_cents', 'notes', 'created_at'],
    timestampColumns: ['created_at'],
    encryptedColumns: ['notes'],
    parent: { column: 'plan_id', table: 'maintenance_plans' },
  },
  {
    key: 'documents',
    table: 'documents',
    columns: [
      'profile_id', 'kind', 'title', 'issuer', 'document_number_encrypted', 'issued_at', 'expires_at',
      'country', 'notes', 'reminder_config', 'is_active', 'created_at', 'updated_at',
    ],
    updatedAtColumn: 'updated_at',
    timestampColumns: ['created_at', 'updated_at'],
    jsonColumns: ['reminder_config'],
    encryptedColumns: ['notes'],
  },
  {
    key: 'attachments',
    table: 'attachments',
    columns: [
      'owner_type', 'owner_id', 'filename', 'content_type', 'byte_size', 'sha256', 'storage_key',
      'created_at',
    ],
    // 字节不进导出；storage_key 是内部对象引用，导入后指向对象存储中仍存在的对象。
    timestampColumns: ['created_at'],
    encryptedColumns: ['filename', 'content_type'],
  },
];

export const NEW_ENTITY_KEYS: readonly string[] = ENTITY_SPECS.map((spec) => spec.key);

/** 载荷形状：已知的新实体字段如果出现必须是数组；加密元数据必须是对象。 */
export function assertImportPayloadShape(payload: Record<string, unknown>): void {
  for (const key of NEW_ENTITY_KEYS) {
    if (payload[key] !== undefined && !Array.isArray(payload[key])) {
      throw new DataImportValidationError(`导入数据格式错误：${key} 必须是数组`);
    }
  }
  if (payload.encryption !== undefined) {
    const meta = payload.encryption;
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      throw new DataImportValidationError('导入数据格式错误：encryption 必须是对象');
    }
  }
}

function documentCiphertexts(payload: Record<string, unknown>): string[] {
  const docs = payload.documents;
  if (!Array.isArray(docs)) return [];
  const out: string[] = [];
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    const value = (doc as Record<string, unknown>).document_number_encrypted;
    if (typeof value === 'string' && value.trim() !== '') out.push(value);
  }
  return out;
}

/**
 * Refuse an import whose encrypted columns cannot be read with the CURRENT key.
 * Runs BEFORE any write; throws DataImportEncryptionError with a clear message.
 */
export function validateImportEncryption(payload: Record<string, unknown>): void {
  const meta = payload.encryption as { masterKeyFingerprint?: unknown; algorithm?: unknown } | undefined;
  const claimedFingerprint = typeof meta?.masterKeyFingerprint === 'string' ? meta.masterKeyFingerprint : null;
  const currentFingerprint = exportKeyFingerprint();
  const ciphertexts = documentCiphertexts(payload);

  if (claimedFingerprint) {
    if (!currentFingerprint || claimedFingerprint !== currentFingerprint) {
      throw new DataImportEncryptionError(
        '导出数据的加密密钥与当前 MASTER_KEY 不一致，导入被拒绝（请使用导出时的 MASTER_KEY 重试）',
      );
    }
  }

  if (ciphertexts.length === 0) return;
  const currentKey = currentMasterKey();
  if (!currentKey) {
    throw new DataImportEncryptionError('导入数据包含加密的证件号码，但当前未配置 MASTER_KEY，导入被拒绝');
  }
  for (const ciphertext of ciphertexts) {
    try {
      decrypt(ciphertext, currentKey);
    } catch {
      throw new DataImportEncryptionError(
        '导入数据中的证件号码无法用当前 MASTER_KEY 解密，导入被拒绝（密钥不一致或数据已损坏）',
      );
    }
  }
}

function parseTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function coerceValue(spec: EntitySpec, column: string, raw: Record<string, unknown>): unknown {
  const value = raw[column];
  if (value === undefined) return null;
  if (spec.jsonColumns?.includes(column)) {
    if (value === null || value === '') return null;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }
  if (spec.arrayColumns?.includes(column)) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }
  if (spec.encryptedColumns?.includes(column)) {
    if (value === null || value === '') return null;
    // Export payloads carry decrypted values; re-encrypt on import. Idempotent: a value
    // that already looks like current/legacy ciphertext is passed through untouched.
    return encryptFieldValue(typeof value === 'string' ? value : String(value));
  }
  return value ?? null;
}

export interface ImportNewEntitiesResult {
  applied: Record<string, number>;
  skipped: number;
}

/**
 * Import the new life-domain entities for `userId` using `client` (a transaction client).
 * Explicit ids keep child references (expiry_history.item_id, maintenance_logs.plan_id,
 * attachments.owner_id) intact; rows that conflict with a NEWER row are left untouched.
 */
export async function importNewEntities(
  client: PoolClient,
  userId: number,
  payload: Record<string, unknown>,
): Promise<ImportNewEntitiesResult> {
  const applied: Record<string, number> = {};
  let skipped = 0;

  for (const spec of ENTITY_SPECS) {
    applied[spec.key] = 0;
    const rows = Array.isArray(payload[spec.key]) ? (payload[spec.key] as unknown[]) : [];

    for (const raw of rows) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        skipped += 1;
        continue;
      }
      const row = raw as Record<string, unknown>;

      const id = Number(row.id);
      if (!Number.isInteger(id) || id <= 0) {
        skipped += 1;
        continue;
      }

      // Every declared timestamp must parse; a corrupt one skips the row rather than
      // risking an "updated_at in the future" clobber or a 500 that aborts the import.
      const timestamps: Record<string, string> = {};
      let timestampOk = true;
      for (const column of spec.timestampColumns) {
        const parsed = parseTimestamp(row[column]);
        if (!parsed) {
          timestampOk = false;
          break;
        }
        timestamps[column] = parsed;
      }
      if (!timestampOk) {
        skipped += 1;
        continue;
      }

      if (spec.parent) {
        const parentId = Number(row[spec.parent.column]);
        if (!Number.isInteger(parentId) || parentId <= 0) {
          skipped += 1;
          continue;
        }
        const parent = await client.query(
          `SELECT 1 FROM ${spec.parent.table} WHERE id = $1 AND user_id = $2`,
          [parentId, userId],
        );
        if (parent.rows.length === 0) {
          skipped += 1;
          continue;
        }
      }

      const columns: string[] = ['id'];
      const values: unknown[] = [id];
      if (!spec.parent) {
        columns.push('user_id');
        values.push(userId);
      }
      // Absent (undefined) columns are OMITTED so Postgres defaults apply; only explicit
      // values (including null) are sent. Timestamps are always present (validated above).
      const includedColumns = spec.columns.filter(
        (column) => spec.timestampColumns.includes(column) || row[column] !== undefined,
      );
      for (const column of includedColumns) {
        columns.push(column);
        values.push(spec.timestampColumns.includes(column) ? timestamps[column] : coerceValue(spec, column, row));
      }

      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      let conflictClause: string;
      if (spec.updatedAtColumn) {
        const assignments = includedColumns.map((column) => `${column} = EXCLUDED.${column}`).join(', ');
        const guards = [
          `${spec.table}.${spec.updatedAtColumn} < EXCLUDED.${spec.updatedAtColumn}`,
        ];
        if (!spec.parent) guards.unshift(`${spec.table}.user_id = EXCLUDED.user_id`);
        conflictClause = `ON CONFLICT (id) DO UPDATE SET ${assignments} WHERE ${guards.join(' AND ')}`;
      } else {
        conflictClause = 'ON CONFLICT (id) DO NOTHING';
      }

      const result = await client.query(
        `INSERT INTO ${spec.table} (${columns.join(', ')})
         VALUES (${placeholders})
         ${conflictClause}
         RETURNING id`,
        values,
      );
      if (result.rows.length > 0) {
        applied[spec.key] += 1;
      } else {
        // Conflicting row exists and is not older (idempotent re-import / newer local row).
        skipped += 1;
      }
    }
  }

  await resetSequences(client);
  log.info({ userId, applied, skipped }, 'New-entity import applied');
  return { applied, skipped };
}

/**
 * Explicit-id inserts do not advance SERIAL sequences; push each sequence past the
 * imported max so later inserts without an id cannot collide. Best-effort: a database
 * without sequences (or without pg_get_serial_sequence) must not fail the import.
 */
async function resetSequences(client: PoolClient): Promise<void> {
  for (const spec of ENTITY_SPECS) {
    try {
      await client.query(
        `SELECT setval(
           pg_get_serial_sequence('${spec.table}', 'id'),
           GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${spec.table}), 1)
         )`,
      );
    } catch (error) {
      log.warn(
        { event: 'data_import.sequence_reset_failed', table: spec.table, err: error },
        'Failed to reset a serial sequence after import; new inserts may need a manual bump',
      );
    }
  }
}
