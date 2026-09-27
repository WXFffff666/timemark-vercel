import { createHash, randomBytes } from 'crypto';
import { createEvents, type EventAttributes } from 'ics';
import { query } from '../db/index.js';

/**
 * Checkbox 89: per-contact / per-category public ICS subscription feeds.
 *
 * A feed is a saved filter plus the SHA-256 HASH of a public token. The calendar
 * is regenerated on every read (no standing compute, no external calls) from the
 * user's events, active documents and active expiry items. Only the fields needed
 * for a VEVENT summary are selected and projected - document numbers, notes,
 * amounts, vendors, issuers and reminder configs never reach the builder.
 */

export const ICS_FEED_FILTER_TYPES = ['category', 'profile', 'contact'] as const;
export type IcsFeedFilterType = (typeof ICS_FEED_FILTER_TYPES)[number];

export interface IcsFeedFilter {
  type: IcsFeedFilterType;
  value: string | number;
}

/** Per-source item cap: one read stays cheap on the free tier. */
const MAX_ITEMS_PER_SOURCE = 500;
const MAX_FILTER_VALUE_LENGTH = 128;
const MAX_NAME_LENGTH = 80;

/** Shortest / longest accepted raw token (a lookup outside this is a 404). */
export const MIN_TOKEN_LENGTH = 20;
export const MAX_TOKEN_LENGTH = 128;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isFilterType(value: unknown): value is IcsFeedFilterType {
  return typeof value === 'string' && (ICS_FEED_FILTER_TYPES as readonly string[]).includes(value);
}

/**
 * Validate an untrusted `filter` value from the API / JSONB column.
 * Returns null for anything malformed: unknown filter type, empty value,
 * an oversized value, or a profile value that is not a positive integer.
 * A well-formed but unknown category/contact is accepted on purpose - it simply
 * matches nothing and yields a valid empty calendar.
 */
export function parseIcsFeedFilter(raw: unknown): IcsFeedFilter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isFilterType(record.type)) return null;

  if (record.type === 'profile') {
    const numeric = typeof record.value === 'number' ? record.value : Number(record.value);
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    return { type: 'profile', value: numeric };
  }

  if (typeof record.value !== 'string') return null;
  const value = record.value.trim();
  if (!value || value.length > MAX_FILTER_VALUE_LENGTH) return null;
  return { type: record.type, value };
}

/** Human-readable label used for the default feed name and the Settings list. */
export function defaultIcsFeedName(filter: IcsFeedFilter): string {
  if (filter.type === 'profile') return `家庭档案 ${filter.value}`;
  if (filter.type === 'contact') return `联系人 ${filter.value}`;
  return `分类 ${filter.value}`;
}

/** SHA-256 hash - the only representation of a feed token that is ever stored. */
export function hashFeedToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 256-bit URL-safe token; the raw value is returned once and never persisted. */
export function generateFeedToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashFeedToken(token) };
}

/**
 * Single-line, bounded text for ICS fields. Strips control characters (including
 * CR/LF) so a hostile feed name or title cannot break a header or inject a line;
 * the `ics` library additionally escapes `\`, `,`, `;` when serializing.
 */
export function sanitizeIcsText(value: unknown, maxLength = 200): string {
  return String(value ?? '')
    .replace(/[^\P{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function toYmd(value: unknown): string | null {
  if (value == null) return null;
  let text: string;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    text = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  } else {
    text = String(value).slice(0, 10);
  }
  if (!ISO_DATE.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }
  return text;
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return String(value);
}

export interface ActiveIcsFeed {
  id: number;
  userId: number;
  name: string;
  filter: IcsFeedFilter;
}

interface IcsFeedDbRow {
  id: unknown;
  user_id: unknown;
  name: unknown;
  filter: unknown;
  created_at?: unknown;
  last_access_at?: unknown;
  revoked_at?: unknown;
}

/**
 * Resolve a raw token to a live feed. Only the hash is compared; revoked feeds
 * and unknown tokens both return null (the route maps that to 404). A corrupt
 * stored filter also returns null - never a 500.
 */
export async function getActiveIcsFeedByToken(token: string): Promise<ActiveIcsFeed | null> {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const result = await query(
    `SELECT id, user_id, name, "filter" FROM ics_feeds
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashFeedToken(token)],
  );
  const row = result.rows[0] as IcsFeedDbRow | undefined;
  if (!row) return null;
  const filter = parseIcsFeedFilter(row.filter);
  if (!filter) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: sanitizeIcsText(row.name, MAX_NAME_LENGTH),
    filter,
  };
}

export async function touchIcsFeedAccess(id: number): Promise<void> {
  await query('UPDATE ics_feeds SET last_access_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
}

export interface IcsFeedItem {
  uid: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
  category: string;
}

interface FeedSource {
  table: 'events' | 'documents' | 'expiry_items';
  uidPrefix: string;
  titleColumn: string;
  kindColumn: string;
  dateColumn: string;
  /** Code-constant WHERE fragment, never user input. */
  extraWhere: string;
}

const FEED_SOURCES: readonly FeedSource[] = [
  {
    table: 'events',
    uidPrefix: 'event',
    titleColumn: 'name',
    kindColumn: 'type',
    dateColumn: 'date',
    extraWhere: '',
  },
  {
    table: 'documents',
    uidPrefix: 'document',
    titleColumn: 'title',
    kindColumn: 'kind',
    dateColumn: 'expires_at',
    extraWhere: 'AND is_active = TRUE AND expires_at IS NOT NULL',
  },
  {
    table: 'expiry_items',
    uidPrefix: 'expiry',
    titleColumn: 'title',
    kindColumn: 'kind',
    dateColumn: 'next_due_date',
    extraWhere: 'AND is_active = TRUE AND next_due_date IS NOT NULL',
  },
];

async function collectSource(
  source: FeedSource,
  userId: number,
  filter: IcsFeedFilter,
): Promise<IcsFeedItem[]> {
  // Contacts only exist on events; a contact feed must never pull in documents
  // or expiry items that happen to share a profile.
  if (filter.type === 'contact' && source.table !== 'events') return [];

  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (source.extraWhere) where += ` ${source.extraWhere}`;
  if (filter.type === 'contact') {
    params.push(filter.value);
    where += ` AND LOWER(person_name) = LOWER($${params.length})`;
  } else {
    params.push(filter.value);
    where += ` AND ${filter.type === 'category' ? source.kindColumn : 'profile_id'} = $${params.length}`;
  }

  const result = await query(
    `SELECT id, ${source.titleColumn} AS title, ${source.kindColumn} AS kind, ${source.dateColumn} AS due
       FROM ${source.table}
      WHERE ${where}
      ORDER BY ${source.dateColumn} ASC
      LIMIT ${MAX_ITEMS_PER_SOURCE}`,
    params,
  );

  const items: IcsFeedItem[] = [];
  for (const raw of result.rows) {
    const row = raw as { id: unknown; title: unknown; kind: unknown; due: unknown };
    const date = toYmd(row.due);
    if (!date) continue;
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    items.push({
      uid: `timemark-${source.uidPrefix}-${id}@timemark.app`,
      date,
      title: sanitizeIcsText(row.title) || 'TimeMark',
      category: sanitizeIcsText(row.kind, 64) || 'other',
    });
  }
  return items;
}

/** All calendar items matching the saved filter, regenerated on each read. */
export async function collectFeedItems(userId: number, filter: IcsFeedFilter): Promise<IcsFeedItem[]> {
  const items: IcsFeedItem[] = [];
  for (const source of FEED_SOURCES) {
    items.push(...(await collectSource(source, userId, filter)));
  }
  return items;
}

/**
 * Serialize items with the `ics` library itself, so the output is canonical ICS
 * produced by the same package the acceptance test uses. Never throws: a single
 * bad item degrades to an empty (still valid) calendar instead of a 500.
 */
export function buildIcsCalendar(items: IcsFeedItem[], calName: string): string {
  const safeName = sanitizeIcsText(calName, MAX_NAME_LENGTH) || 'TimeMark';
  const attributes: EventAttributes[] = items.map((item) => {
    const [year, month, day] = item.date.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    return {
      start: [year, month, day],
      // DTEND is exclusive for all-day events; the library emits VALUE=DATE.
      end: [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()],
      title: item.title,
      uid: item.uid,
      categories: [item.category],
    };
  });

  const result = createEvents(attributes, { calName: safeName });
  if (!result.error && result.value != null) return result.value;

  console.error('[ics-feed] calendar serialization failed:', result.error);
  const empty = createEvents([], { calName: safeName });
  if (!empty.error && empty.value != null) return empty.value;
  return 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//TimeMark//Feed//EN\r\nEND:VCALENDAR\r\n';
}

export interface IcsFeedSummary {
  id: number;
  name: string;
  filter: IcsFeedFilter | null;
  createdAt: string | null;
  lastAccessAt: string | null;
  revokedAt: string | null;
}

function toSummary(row: IcsFeedDbRow): IcsFeedSummary {
  return {
    id: Number(row.id),
    name: sanitizeIcsText(row.name, MAX_NAME_LENGTH),
    filter: parseIcsFeedFilter(row.filter),
    createdAt: toIsoOrNull(row.created_at),
    lastAccessAt: toIsoOrNull(row.last_access_at),
    revokedAt: toIsoOrNull(row.revoked_at),
  };
}

/** Feed list for Settings. Deliberately never selects `token_hash`. */
export async function listIcsFeeds(userId: number): Promise<IcsFeedSummary[]> {
  const result = await query(
    `SELECT id, name, "filter", created_at, last_access_at, revoked_at
       FROM ics_feeds
      WHERE user_id = $1
      ORDER BY id ASC`,
    [userId],
  );
  return result.rows.map((row) => toSummary(row as IcsFeedDbRow));
}

export async function createIcsFeed(
  userId: number,
  name: string,
  filter: IcsFeedFilter,
): Promise<{ feed: IcsFeedSummary; token: string }> {
  const { token, tokenHash } = generateFeedToken();
  const result = await query(
    `INSERT INTO ics_feeds (user_id, name, "filter", token_hash)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING id, name, "filter", created_at, last_access_at, revoked_at`,
    [userId, sanitizeIcsText(name, MAX_NAME_LENGTH) || defaultIcsFeedName(filter), JSON.stringify(filter), tokenHash],
  );
  return { feed: toSummary(result.rows[0] as IcsFeedDbRow), token };
}

/** Soft delete: keeps the hash forever so a revoked feed can never come back. */
export async function revokeIcsFeed(userId: number, id: number): Promise<boolean> {
  const result = await query(
    `UPDATE ics_feeds SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}
