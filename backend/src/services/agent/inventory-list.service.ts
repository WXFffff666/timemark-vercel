import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { createShareToken, listShareTokens, revokeShareToken, type ShareTokenView } from './share.service.js';

/**
 * Task 158: household collaborative list (shopping / chores).
 *
 * Deliberately separate from the shipped `inventory_items` stock domain: this is
 * a shared to-do list (`household_lists` + `household_list_items`), items are
 * add/check/uncheck/assign/quantity/note, and check toggles are IDEMPOTENT -
 * checking an already-checked item returns it unchanged (no checked_at churn).
 *
 * A per-list share link reuses the shipped `services/agent/share.service.ts`:
 * `createShareToken` with scope `household_list`, stored in the existing
 * `share_tokens` table (scope_list_id + widened CHECK in pending 73) so the
 * public read-only `/api/share/:token` route resolves it with the same
 * passcode/expiry/revocation semantics as profile/tag shares.
 */

const log = createLogger('inventory-list');

export interface HouseholdList {
  id: number;
  name: string;
  note: string;
  itemCount: number;
  checkedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdListItem {
  id: number;
  listId: number;
  name: string;
  quantity: string;
  note: string;
  assignee: string;
  checked: boolean;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdListInput {
  name: string;
  note?: string;
}

export interface HouseholdListPatch {
  name?: string;
  note?: string;
}

export interface HouseholdListItemInput {
  name: string;
  quantity?: string;
  note?: string;
  assignee?: string;
}

export interface HouseholdListItemPatch {
  name?: string;
  quantity?: string;
  note?: string;
  assignee?: string;
}

export interface HouseholdListShareInput {
  expiresInDays?: number | null;
  passcode?: string | null;
  label?: string | null;
}

export interface HouseholdListDetail {
  list: HouseholdList;
  items: HouseholdListItem[];
}

export interface HouseholdListShare {
  token: string;
  url: string;
  view: ShareTokenView;
}

const LIST_BASE_COLUMNS = 'id, name, note, created_at, updated_at';
const LIST_AGG_COLUMNS = `l.id, l.name, l.note, l.created_at, l.updated_at,
  COUNT(i.id)::int AS item_count,
  COUNT(i.id) FILTER (WHERE i.checked)::int AS checked_count`;
const ITEM_COLUMNS = `i.id, i.list_id, i.name, i.quantity, i.note, i.assignee, i.checked,
  i.checked_at, i.created_at, i.updated_at`;

interface ListRow {
  id?: unknown;
  name?: unknown;
  note?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  item_count?: unknown;
  checked_count?: unknown;
}

interface ItemRow {
  id?: unknown;
  list_id?: unknown;
  name?: unknown;
  quantity?: unknown;
  note?: unknown;
  assignee?: unknown;
  checked?: unknown;
  checked_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowToList(row: ListRow): HouseholdList {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    note: String(row.note ?? ''),
    itemCount: row.item_count == null ? 0 : Number(row.item_count),
    checkedCount: row.checked_count == null ? 0 : Number(row.checked_count),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

function rowToItem(row: ItemRow): HouseholdListItem {
  return {
    id: Number(row.id),
    listId: Number(row.list_id),
    name: String(row.name ?? ''),
    quantity: String(row.quantity ?? ''),
    note: String(row.note ?? ''),
    assignee: String(row.assignee ?? ''),
    checked: row.checked === true,
    checkedAt: toIso(row.checked_at),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

async function listBelongsToUser(userId: number, listId: number): Promise<boolean> {
  const result = await query('SELECT 1 FROM household_lists WHERE id = $1 AND user_id = $2', [listId, userId]);
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// List CRUD
// ---------------------------------------------------------------------------

export async function createHouseholdList(userId: number, input: HouseholdListInput): Promise<HouseholdList> {
  const result = await query(
    `INSERT INTO household_lists (user_id, name, note) VALUES ($1, $2, $3) RETURNING ${LIST_BASE_COLUMNS}`,
    [userId, input.name, input.note ?? ''],
  );
  const list = rowToList(result.rows[0] as ListRow);
  log.info({ event: 'household_list.created', listId: list.id }, 'Household list created');
  return list;
}

export async function listHouseholdLists(userId: number): Promise<HouseholdList[]> {
  const result = await query(
    `SELECT ${LIST_AGG_COLUMNS}
     FROM household_lists l
     LEFT JOIN household_list_items i ON i.list_id = l.id
     WHERE l.user_id = $1
     GROUP BY l.id
     ORDER BY l.updated_at DESC, l.id DESC
     LIMIT 200`,
    [userId],
  );
  return (result.rows as ListRow[]).map(rowToList);
}

export async function getHouseholdList(userId: number, listId: number): Promise<HouseholdListDetail | null> {
  const listResult = await query(
    `SELECT ${LIST_AGG_COLUMNS}
     FROM household_lists l
     LEFT JOIN household_list_items i ON i.list_id = l.id
     WHERE l.id = $1 AND l.user_id = $2
     GROUP BY l.id`,
    [listId, userId],
  );
  const listRow = listResult.rows[0] as ListRow | undefined;
  if (!listRow) return null;

  const itemsResult = await query(
    `SELECT ${ITEM_COLUMNS} FROM household_list_items i
     WHERE i.list_id = $1
     ORDER BY i.checked ASC, i.created_at ASC, i.id ASC
     LIMIT 1000`,
    [listId],
  );
  return {
    list: rowToList(listRow),
    items: (itemsResult.rows as ItemRow[]).map(rowToItem),
  };
}

export async function updateHouseholdList(
  userId: number,
  listId: number,
  patch: HouseholdListPatch,
): Promise<HouseholdList | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.name !== undefined) {
    values.push(patch.name);
    sets.push(`name = $${values.length}`);
  }
  if (patch.note !== undefined) {
    values.push(patch.note);
    sets.push(`note = $${values.length}`);
  }
  if (sets.length === 0) {
    const detail = await getHouseholdList(userId, listId);
    return detail ? detail.list : null;
  }

  sets.push('updated_at = now()');
  values.push(listId);
  const idIndex = values.length;
  values.push(userId);
  const userIndex = values.length;

  const result = await query(
    `UPDATE household_lists SET ${sets.join(', ')} WHERE id = $${idIndex} AND user_id = $${userIndex} RETURNING ${LIST_BASE_COLUMNS}`,
    values,
  );
  if (result.rows.length === 0) return null;
  const detail = await getHouseholdList(userId, listId);
  return detail ? detail.list : null;
}

export async function deleteHouseholdList(userId: number, listId: number): Promise<boolean> {
  // Shares reference the list by scope_list_id (no FK): drop them with the list so
  // the public token cannot resolve a deleted list.
  await query(
    `DELETE FROM share_tokens WHERE user_id = $1 AND scope_type = 'household_list' AND scope_list_id = $2`,
    [userId, listId],
  ).catch((error) =>
    log.warn({ event: 'household_list.share_cleanup_failed', listId, err: error }, 'Share cleanup failed'),
  );
  const result = await query('DELETE FROM household_lists WHERE id = $1 AND user_id = $2', [listId, userId]);
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) log.info({ event: 'household_list.deleted', listId }, 'Household list deleted');
  return deleted;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function addHouseholdListItem(
  userId: number,
  listId: number,
  input: HouseholdListItemInput,
): Promise<HouseholdListItem | null> {
  if (!(await listBelongsToUser(userId, listId))) return null;
  const result = await query(
    `INSERT INTO household_list_items (list_id, name, quantity, note, assignee)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ITEM_COLUMNS}`,
    [listId, input.name, input.quantity ?? '', input.note ?? '', input.assignee ?? ''],
  );
  await touchList(listId);
  return rowToItem(result.rows[0] as ItemRow);
}

export async function updateHouseholdListItem(
  userId: number,
  listId: number,
  itemId: number,
  patch: HouseholdListItemPatch,
): Promise<HouseholdListItem | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.name !== undefined) {
    values.push(patch.name);
    sets.push(`i.name = $${values.length}`);
  }
  if (patch.quantity !== undefined) {
    values.push(patch.quantity);
    sets.push(`i.quantity = $${values.length}`);
  }
  if (patch.note !== undefined) {
    values.push(patch.note);
    sets.push(`i.note = $${values.length}`);
  }
  if (patch.assignee !== undefined) {
    values.push(patch.assignee);
    sets.push(`i.assignee = $${values.length}`);
  }
  if (sets.length === 0) {
    const current = await query(
      `SELECT ${ITEM_COLUMNS} FROM household_list_items i
       JOIN household_lists l ON l.id = i.list_id
       WHERE i.id = $1 AND i.list_id = $2 AND l.user_id = $3`,
      [itemId, listId, userId],
    );
    const row = current.rows[0] as ItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  sets.push('i.updated_at = now()');
  values.push(itemId);
  const idIndex = values.length;
  values.push(listId);
  const listIndex = values.length;
  values.push(userId);
  const userIndex = values.length;

  const result = await query(
    `UPDATE household_list_items i SET ${sets.join(', ')}
     WHERE i.id = $${idIndex} AND i.list_id = $${listIndex}
       AND EXISTS (SELECT 1 FROM household_lists l WHERE l.id = i.list_id AND l.user_id = $${userIndex})
     RETURNING ${ITEM_COLUMNS}`,
    values,
  );
  const row = result.rows[0] as ItemRow | undefined;
  if (!row) return null;
  await touchList(listId);
  return rowToItem(row);
}

/**
 * Idempotent check / uncheck. When the item is already in the target state the
 * UPDATE matches nothing, so `checked_at` / `updated_at` are untouched and the
 * current row is returned as-is (no-op, not an error).
 */
export async function setHouseholdListItemChecked(
  userId: number,
  listId: number,
  itemId: number,
  checked: boolean,
): Promise<HouseholdListItem | null> {
  const updated = await query(
    `UPDATE household_list_items i
     SET checked = $4, checked_at = CASE WHEN $4 THEN now() ELSE NULL END, updated_at = now()
     WHERE i.id = $3 AND i.list_id = $2 AND i.checked <> $4
       AND EXISTS (SELECT 1 FROM household_lists l WHERE l.id = i.list_id AND l.user_id = $1)
     RETURNING ${ITEM_COLUMNS}`,
    [userId, listId, itemId, checked],
  );
  const updatedRow = updated.rows[0] as ItemRow | undefined;
  if (updatedRow) {
    await touchList(listId);
    return rowToItem(updatedRow);
  }

  // Already in the target state (or missing): return the current row when it
  // belongs to the caller's list.
  const current = await query(
    `SELECT ${ITEM_COLUMNS} FROM household_list_items i
     JOIN household_lists l ON l.id = i.list_id
     WHERE i.id = $1 AND i.list_id = $2 AND l.user_id = $3`,
    [itemId, listId, userId],
  );
  const row = current.rows[0] as ItemRow | undefined;
  return row ? rowToItem(row) : null;
}

export async function deleteHouseholdListItem(
  userId: number,
  listId: number,
  itemId: number,
): Promise<boolean> {
  const result = await query(
    `DELETE FROM household_list_items i
     WHERE i.id = $1 AND i.list_id = $2
       AND EXISTS (SELECT 1 FROM household_lists l WHERE l.id = i.list_id AND l.user_id = $3)`,
    [itemId, listId, userId],
  );
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) await touchList(listId);
  return deleted;
}

/** Bump the parent list's updated_at so list views sort by recent activity. */
async function touchList(listId: number): Promise<void> {
  await query('UPDATE household_lists SET updated_at = now() WHERE id = $1', [listId]).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Sharing (reuses services/agent/share.service.ts)
// ---------------------------------------------------------------------------

export async function createHouseholdListShare(
  userId: number,
  listId: number,
  input: HouseholdListShareInput = {},
): Promise<HouseholdListShare | null> {
  const detail = await getHouseholdList(userId, listId);
  if (!detail) return null;
  const { token, view } = await createShareToken(userId, {
    scopeType: 'household_list',
    listId,
    label: input.label ?? detail.list.name,
    expiresInDays: input.expiresInDays ?? null,
    passcode: input.passcode ?? null,
  });
  log.info({ event: 'household_list.shared', listId, shareId: view.id }, 'Household list share created');
  return { token, url: `/share/${token}`, view };
}

export async function listHouseholdListShares(userId: number, listId: number): Promise<ShareTokenView[]> {
  const tokens = await listShareTokens(userId);
  return tokens.filter((token) => token.scopeType === 'household_list' && token.listId === listId);
}

export async function revokeHouseholdListShare(
  userId: number,
  listId: number,
  shareId: number,
): Promise<boolean> {
  const shares = await listHouseholdListShares(userId, listId);
  if (!shares.some((share) => share.id === shareId)) return false;
  return revokeShareToken(userId, shareId);
}
