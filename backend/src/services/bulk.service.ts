import { query } from '../db/index.js';
import { linkTag, unlinkTag } from './tag.service.js';
import { logAudit } from './audit.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('bulk');

/**
 * Task 139: one action applied across a typed list of { entityType, ids }.
 *
 * Contracts that matter:
 *  - The action allowlist and the entity-type allowlist are fixed constants,
 *    never interpolated from user input (the table name comes from a map).
 *  - Unknown entity type fails the WHOLE request with 400 before any write, so
 *    a typo can never half-apply a batch. Everything else (a known type that
 *    the action does not support, a missing row, a per-row DB error) is reported
 *    per id - partial success is honest, never a blanket OK.
 *  - Every successful write goes through the shipped audit service.
 */

export const BULK_ACTIONS = ['delete', 'tag', 'archive', 'complete', 'change-type'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export const BULK_ENTITY_TYPES = [
  'event',
  'contact',
  'document',
  'expiry',
  'inventory',
  'maintenance',
  'habit',
  'goal',
] as const;
export type BulkEntityType = (typeof BULK_ENTITY_TYPES)[number];

/** Hard cap on the total ids in one request - a bulk action is not a migration. */
export const BULK_MAX_IDS = 200;

/** Fixed entity -> table map; mirrors tag.service but stays local to bulk. */
const ENTITY_TABLES: Record<BulkEntityType, string> = {
  event: 'events',
  contact: 'fixed_contacts',
  document: 'documents',
  expiry: 'expiry_items',
  inventory: 'inventory_items',
  maintenance: 'maintenance_plans',
  habit: 'habits',
  goal: 'goals',
};

/** Entities carrying `is_active` that `archive` soft-deletes by flipping it. */
const IS_ACTIVE_TABLES = new Set<BulkEntityType>(['document', 'expiry', 'inventory', 'maintenance', 'habit']);

/**
 * change-type target vocabularies mirrored from the DB CHECK constraints. A missing
 * entry (event, goal) means the column is free text and any non-empty value is allowed.
 */
const CHANGE_TYPE_VALUES: Partial<Record<BulkEntityType, readonly string[]>> = {
  document: ['passport', 'id_card', 'driver_license', 'visa', 'certificate', 'policy', 'contract', 'other'],
  expiry: ['subscription', 'bill', 'insurance', 'domain', 'warranty', 'custom'],
  inventory: ['food', 'medicine', 'supply', 'other'],
  maintenance: ['vehicle', 'appliance', 'device', 'other'],
};

/** Column that `change-type` rewrites, per entity kind. */
const CHANGE_TYPE_COLUMN: Partial<Record<BulkEntityType, string>> = {
  event: 'type',
  document: 'kind',
  expiry: 'kind',
  inventory: 'category',
  maintenance: 'asset_kind',
  goal: 'category',
};

export type BulkResultCode =
  | 'ok'
  | 'not_found'
  | 'unsupported_action_for_type'
  | 'invalid_target_type'
  | 'error';

export interface BulkActionItem {
  entityType: string;
  ids: number[];
}

export interface BulkParams {
  /** tag action only. */
  tagId?: number;
  /** tag action only; 'add' links, 'remove' unlinks (default add). */
  mode?: 'add' | 'remove';
  /** change-type only. */
  toType?: string;
}

export interface BulkRequest {
  action: BulkAction;
  items: BulkActionItem[];
  params?: BulkParams;
}

export interface BulkItemResult {
  entityType: BulkEntityType;
  id: number;
  ok: boolean;
  code: BulkResultCode;
  message?: string;
}

export interface BulkOutcome {
  action: BulkAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: BulkItemResult[];
}

export type BulkValidation =
  | { ok: true; request: BulkRequest }
  | { ok: false; status: 400; code: string; message: string };

function isBulkAction(value: unknown): value is BulkAction {
  return typeof value === 'string' && (BULK_ACTIONS as readonly string[]).includes(value);
}

function isBulkEntityType(value: unknown): value is BulkEntityType {
  return typeof value === 'string' && (BULK_ENTITY_TYPES as readonly string[]).includes(value);
}

/** True when the action can act on an entity kind that is itself a known type. */
export function actionSupportsType(action: BulkAction, entityType: BulkEntityType): boolean {
  switch (action) {
    case 'delete':
    case 'tag':
      return true;
    case 'archive':
      return IS_ACTIVE_TABLES.has(entityType) || entityType === 'goal';
    case 'complete':
      return entityType === 'goal';
    case 'change-type':
      return CHANGE_TYPE_COLUMN[entityType] !== undefined;
    default:
      return false;
  }
}

/**
 * All-or-nothing validation: an unknown action, an unknown entity type, a bad id
 * shape or an over-cap batch rejects the request before a single write.
 */
export function validateBulkRequest(raw: unknown): BulkValidation {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, status: 400, code: 'invalid_body', message: '请求体无效' };
  }
  const body = raw as { action?: unknown; items?: unknown; params?: unknown };

  if (!isBulkAction(body.action)) {
    return { ok: false, status: 400, code: 'unknown_action', message: '未知的批量操作' };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, status: 400, code: 'empty_selection', message: '未选择任何条目' };
  }

  const items: BulkActionItem[] = [];
  let totalIds = 0;
  for (const entry of body.items) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, status: 400, code: 'invalid_item', message: '条目格式无效' };
    }
    const item = entry as { entityType?: unknown; ids?: unknown };
    if (!isBulkEntityType(item.entityType)) {
      return {
        ok: false,
        status: 400,
        code: 'unknown_entity_type',
        message: `未知的实体类型：${String(item.entityType)}`,
      };
    }
    if (!Array.isArray(item.ids) || item.ids.length === 0) {
      return { ok: false, status: 400, code: 'empty_selection', message: '未选择任何条目' };
    }
    const ids: number[] = [];
    for (const id of item.ids) {
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
        return { ok: false, status: 400, code: 'invalid_id', message: '条目 ID 无效' };
      }
      ids.push(id);
    }
    totalIds += ids.length;
    items.push({ entityType: item.entityType, ids });
  }

  if (totalIds > BULK_MAX_IDS) {
    return {
      ok: false,
      status: 400,
      code: 'too_many_ids',
      message: `一次最多操作 ${BULK_MAX_IDS} 个条目（当前 ${totalIds}）`,
    };
  }

  const params = (body.params ?? {}) as BulkParams;
  if (body.action === 'tag') {
    if (typeof params.tagId !== 'number' || !Number.isInteger(params.tagId) || params.tagId <= 0) {
      return { ok: false, status: 400, code: 'missing_params', message: 'tag 操作需要 tagId' };
    }
  }
  if (body.action === 'change-type') {
    if (typeof params.toType !== 'string' || params.toType.trim().length === 0) {
      return { ok: false, status: 400, code: 'missing_params', message: 'change-type 操作需要 toType' };
    }
    if (params.toType.length > 64) {
      return { ok: false, status: 400, code: 'invalid_target_type', message: '目标类型过长' };
    }
  }

  return { ok: true, request: { action: body.action, items, params } };
}

async function auditWrite(
  userId: number,
  action: BulkAction,
  entityType: BulkEntityType,
  id: number,
): Promise<void> {
  await logAudit(userId, `bulk.${action}`, entityType, id, { bulk: true });
}

/** Applies one entity id; throws for an unexpected DB error so the caller reports it. */
async function applyOne(
  userId: number,
  action: BulkAction,
  entityType: BulkEntityType,
  id: number,
  params: BulkParams,
): Promise<BulkResultCode> {
  if (!actionSupportsType(action, entityType)) {
    return 'unsupported_action_for_type';
  }

  if (action === 'tag') {
    if (params.mode === 'remove') {
      await unlinkTag(userId, params.tagId!, entityType, id);
    } else {
      await linkTag(userId, params.tagId!, entityType, id);
    }
    await auditWrite(userId, action, entityType, id);
    return 'ok';
  }

  const table = ENTITY_TABLES[entityType];

  if (action === 'delete') {
    const result = await query(`DELETE FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
    if ((result.rowCount ?? 0) === 0) return 'not_found';
    await auditWrite(userId, action, entityType, id);
    return 'ok';
  }

  if (action === 'archive') {
    if (entityType === 'goal') {
      const result = await query(
        `UPDATE goals SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if ((result.rowCount ?? 0) === 0) return 'not_found';
    } else {
      const result = await query(
        `UPDATE ${table} SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if ((result.rowCount ?? 0) === 0) return 'not_found';
    }
    await auditWrite(userId, action, entityType, id);
    return 'ok';
  }

  if (action === 'complete') {
    const result = await query(
      `UPDATE goals SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if ((result.rowCount ?? 0) === 0) return 'not_found';
    await auditWrite(userId, action, entityType, id);
    return 'ok';
  }

  // change-type
  const column = CHANGE_TYPE_COLUMN[entityType]!;
  const toType = params.toType!.trim();
  const allowed = CHANGE_TYPE_VALUES[entityType];
  if (allowed && !allowed.includes(toType)) {
    return 'invalid_target_type';
  }
  const result = await query(
    `UPDATE ${table} SET ${column} = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3`,
    [toType, id, userId],
  );
  if ((result.rowCount ?? 0) === 0) return 'not_found';
  await auditWrite(userId, action, entityType, id);
  return 'ok';
}

/**
 * Runs a validated request and returns a truthful per-id result map. A row that
 * fails (foreign id, unsupported action, DB error) is reported individually; the
 * batch is never rounded up to a blanket success.
 */
export async function applyBulk(userId: number, request: BulkRequest): Promise<BulkOutcome> {
  const params = request.params ?? {};
  const results: BulkItemResult[] = [];

  for (const item of request.items) {
    for (const id of item.ids) {
      const entityType = item.entityType as BulkEntityType;
      try {
        const code = await applyOne(userId, request.action, entityType, id, params);
        results.push({
          entityType,
          id,
          ok: code === 'ok',
          code,
          ...(code === 'ok' ? {} : { message: resultMessage(code) }),
        });
      } catch (error) {
        log.warn({ err: error, action: request.action, entityType, id }, 'bulk item failed');
        results.push({ entityType, id, ok: false, code: 'error', message: '操作失败' });
      }
    }
  }

  const succeeded = results.filter((entry) => entry.ok).length;
  return {
    action: request.action,
    requested: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

function resultMessage(code: BulkResultCode): string {
  switch (code) {
    case 'not_found':
      return '条目不存在';
    case 'unsupported_action_for_type':
      return '该操作不支持此类型';
    case 'invalid_target_type':
      return '目标类型无效';
    default:
      return '操作失败';
  }
}
