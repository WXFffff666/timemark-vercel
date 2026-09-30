import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

/**
 * Task 157: watch / read list with release reminders.
 *
 * Rows are films / series / books / games / other with a status lifecycle
 * (wanted -> in_progress -> done / dropped), an optional release date, source /
 * link, rating and note.
 *
 * Release reminders are NOT scheduled here: a row whose `status` is wanted or
 * in_progress and whose `release_date` is in the future is picked up by the
 * EXISTING minute-cron dated-reminder iterator (`jobs/tasks.ts`
 * `WATCHLIST_SOURCE` -> `sendWatchlistReminders`, registered inside
 * `sendReminders`). It reuses the same lead-day windows, channel resolution and
 * `reminder_send_claims` dedupe as expiry / inventory / maintenance / document
 * reminders - no second scheduler.
 *
 * `listUpcomingReleases` feeds the list view (next releases first, with
 * `daysUntil` computed for display).
 */

const log = createLogger('watchlist');

/** Default lead days used by the shared reminder iterator when a row has no reminder_config. */
export const WATCHLIST_REMINDER_LEAD_DAYS = [7, 1, 0] as const;

export const WATCHLIST_KINDS = ['film', 'series', 'book', 'game', 'other'] as const;
export type WatchlistKind = (typeof WATCHLIST_KINDS)[number];

export const WATCHLIST_STATUSES = ['wanted', 'in_progress', 'done', 'dropped'] as const;
export type WatchlistStatus = (typeof WATCHLIST_STATUSES)[number];

export function isWatchlistKind(value: unknown): value is WatchlistKind {
  return typeof value === 'string' && (WATCHLIST_KINDS as readonly string[]).includes(value);
}

export function isWatchlistStatus(value: unknown): value is WatchlistStatus {
  return typeof value === 'string' && (WATCHLIST_STATUSES as readonly string[]).includes(value);
}

export interface WatchlistItem {
  id: number;
  kind: WatchlistKind;
  title: string;
  status: WatchlistStatus;
  releaseDate: string | null;
  source: string | null;
  link: string | null;
  rating: number | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistItemInput {
  kind?: WatchlistKind;
  title: string;
  status?: WatchlistStatus;
  releaseDate?: string | null;
  source?: string | null;
  link?: string | null;
  rating?: number | null;
  note?: string;
}

export interface WatchlistItemPatch {
  kind?: WatchlistKind;
  title?: string;
  status?: WatchlistStatus;
  releaseDate?: string | null;
  source?: string | null;
  link?: string | null;
  rating?: number | null;
  note?: string;
}

export interface WatchlistFilters {
  kind?: WatchlistKind;
  status?: WatchlistStatus;
}

export interface WatchlistUpcoming extends WatchlistItem {
  /** Calendar days until the release date (0 = today). */
  daysUntil: number | null;
}

const ITEM_COLUMNS = `id, kind, title, status, to_char(release_date, 'YYYY-MM-DD') AS release_date,
  source, link, rating, note, created_at, updated_at`;

interface WatchlistRow {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  status?: unknown;
  release_date?: unknown;
  source?: unknown;
  link?: unknown;
  rating?: unknown;
  note?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowToItem(row: WatchlistRow): WatchlistItem {
  return {
    id: Number(row.id),
    kind: isWatchlistKind(row.kind) ? row.kind : 'other',
    title: String(row.title ?? ''),
    status: isWatchlistStatus(row.status) ? row.status : 'wanted',
    releaseDate: row.release_date == null ? null : String(row.release_date),
    source: row.source == null ? null : String(row.source),
    link: row.link == null ? null : String(row.link),
    rating: row.rating == null ? null : Number(row.rating),
    note: String(row.note ?? ''),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

function ymdToUtcMs(ymd: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Today's calendar date (YYYY-MM-DD) in Asia/Shanghai, matching the reminder cron. */
function todayYmd(nowMs: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(nowMs));
}

function normalizeRating(rating: number | null | undefined): number | null {
  if (rating == null) return null;
  return Math.min(10, Math.max(0, Math.trunc(rating)));
}

export async function createWatchlistItem(userId: number, input: WatchlistItemInput): Promise<WatchlistItem> {
  const result = await query(
    `INSERT INTO watchlist_items (user_id, kind, title, status, release_date, source, link, rating, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${ITEM_COLUMNS}`,
    [
      userId,
      input.kind ?? 'other',
      input.title,
      input.status ?? 'wanted',
      input.releaseDate ?? null,
      input.source ?? null,
      input.link ?? null,
      normalizeRating(input.rating),
      input.note ?? '',
    ],
  );
  const item = rowToItem(result.rows[0] as WatchlistRow);
  log.info({ event: 'watchlist.created', itemId: item.id, kind: item.kind, hasRelease: item.releaseDate != null }, 'Watchlist item created');
  return item;
}

export async function listWatchlistItems(userId: number, filters: WatchlistFilters = {}): Promise<WatchlistItem[]> {
  const where = ['user_id = $1'];
  const values: unknown[] = [userId];
  if (filters.kind) {
    values.push(filters.kind);
    where.push(`kind = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }
  const result = await query(
    `SELECT ${ITEM_COLUMNS} FROM watchlist_items WHERE ${where.join(' AND ')}
     ORDER BY CASE status
       WHEN 'in_progress' THEN 0
       WHEN 'wanted' THEN 1
       WHEN 'done' THEN 2
       ELSE 3
     END, release_date ASC NULLS LAST, updated_at DESC, id DESC
     LIMIT 500`,
    values,
  );
  return (result.rows as WatchlistRow[]).map(rowToItem);
}

export async function getWatchlistItem(userId: number, id: number): Promise<WatchlistItem | null> {
  const result = await query(`SELECT ${ITEM_COLUMNS} FROM watchlist_items WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  const row = result.rows[0] as WatchlistRow | undefined;
  return row ? rowToItem(row) : null;
}

export async function updateWatchlistItem(
  userId: number,
  id: number,
  patch: WatchlistItemPatch,
): Promise<WatchlistItem | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.kind !== undefined) {
    values.push(patch.kind);
    sets.push(`kind = $${values.length}`);
  }
  if (patch.title !== undefined) {
    values.push(patch.title);
    sets.push(`title = $${values.length}`);
  }
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
  }
  if (patch.releaseDate !== undefined) {
    values.push(patch.releaseDate);
    sets.push(`release_date = $${values.length}`);
  }
  if (patch.source !== undefined) {
    values.push(patch.source);
    sets.push(`source = $${values.length}`);
  }
  if (patch.link !== undefined) {
    values.push(patch.link);
    sets.push(`link = $${values.length}`);
  }
  if (patch.rating !== undefined) {
    values.push(normalizeRating(patch.rating));
    sets.push(`rating = $${values.length}`);
  }
  if (patch.note !== undefined) {
    values.push(patch.note);
    sets.push(`note = $${values.length}`);
  }
  if (sets.length === 0) return getWatchlistItem(userId, id);

  sets.push('updated_at = now()');
  values.push(id);
  const idIndex = values.length;
  values.push(userId);
  const userIndex = values.length;

  const result = await query(
    `UPDATE watchlist_items SET ${sets.join(', ')} WHERE id = $${idIndex} AND user_id = $${userIndex} RETURNING ${ITEM_COLUMNS}`,
    values,
  );
  const row = result.rows[0] as WatchlistRow | undefined;
  return row ? rowToItem(row) : null;
}

export async function deleteWatchlistItem(userId: number, id: number): Promise<boolean> {
  const result = await query('DELETE FROM watchlist_items WHERE id = $1 AND user_id = $2', [id, userId]);
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) log.info({ event: 'watchlist.deleted', itemId: id }, 'Watchlist item deleted');
  return deleted;
}

/**
 * Upcoming (not-yet-released) items with a concrete release date: wanted and
 * in_progress rows only, soonest first. `daysUntil` is the display countdown;
 * the same rows (release_date + active status) are what the reminder iterator
 * turns into notifications.
 */
export async function listUpcomingReleases(userId: number, nowMs: number = Date.now()): Promise<WatchlistUpcoming[]> {
  const today = todayYmd(nowMs);
  const result = await query(
    `SELECT ${ITEM_COLUMNS} FROM watchlist_items
     WHERE user_id = $1
       AND status IN ('wanted', 'in_progress')
       AND release_date IS NOT NULL
       AND release_date >= $2::date
     ORDER BY release_date ASC, id ASC
     LIMIT 100`,
    [userId, today],
  );
  const todayMs = ymdToUtcMs(today);
  return (result.rows as WatchlistRow[]).map((row) => {
    const item = rowToItem(row);
    const releaseMs = item.releaseDate ? ymdToUtcMs(item.releaseDate) : null;
    const daysUntil =
      releaseMs !== null && todayMs !== null ? Math.round((releaseMs - todayMs) / 86_400_000) : null;
    return { ...item, daysUntil };
  });
}
