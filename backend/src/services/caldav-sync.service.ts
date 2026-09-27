import axios, { type AxiosInstance } from 'axios';
import { createHash } from 'node:crypto';
import { query } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { isSafePublicUrl } from '../utils/url-safety.js';
import { decrypt } from '@timemark/shared/crypto';

const log = createLogger('caldav-sync');

function getMasterKey(): string {
  const key = process.env.MASTER_KEY;
  if (!key) throw new Error('MASTER_KEY not set');
  return key;
}

function decryptCalDavPassword(stored: string): string {
  if (!stored) return '';
  try {
    return decrypt(stored, getMasterKey());
  } catch {
    log.warn('CalDAV password decrypt failed; skipping sync for this credential');
    return '';
  }
}

/** CalDAV 只读订阅：拉取 calendar 集合并解析 VEVENT（最小实现） */
export async function syncAllCalDavSubscriptions(): Promise<{ synced: number }> {
  const users = await query(
    `SELECT user_id, caldav_url, caldav_username, caldav_password_encrypted
     FROM user_configs WHERE caldav_url IS NOT NULL AND caldav_url != ''`,
  );
  let synced = 0;
  for (const row of users.rows as Array<Record<string, unknown>>) {
    try {
      const url = String(row.caldav_url);
      const safe = await isSafePublicUrl(url);
      if (!safe.safe) continue;
      const username = String(row.caldav_username || '');
      const password = decryptCalDavPassword(String(row.caldav_password_encrypted || ''));
      if (row.caldav_password_encrypted && !password) continue;
      const res = await axios.get(url, {
        auth: username ? { username, password } : undefined,
        timeout: 15000,
        maxRedirects: 0,
        headers: { Accept: 'text/calendar' },
        validateStatus: (s) => s < 500,
      });
      if (res.status >= 400) continue;
      const body = String(res.data || '');
      const events = parseIcsEvents(body);
      const userId = row.user_id as number;
      for (const ev of events) {
        const exists = await query(
          `SELECT id FROM events WHERE user_id = $1 AND name = $2 AND date = $3 LIMIT 1`,
          [userId, ev.name, ev.date],
        );
        if (exists.rows.length > 0) continue;
        await query(
          `INSERT INTO events (user_id, name, type, date, calendar_type, reminder_config, notification_channels)
           VALUES ($1, $2, 'other', $3, 'gregorian', $4, '[]')`,
          // `importSource: 'caldav'` marks rows that entered through this read-only
          // subscription. The write-back loop guard (below) skips any entity that
          // carries an importSource, so an imported event can never be pushed back
          // into a calendar (including this one).
          [userId, ev.name, ev.date, JSON.stringify({ enabled: false, daysBeforeList: [], channels: [], accountIds: [], importSource: 'caldav' })],
        );
        synced++;
      }
    } catch (err) {
      log.warn({ userId: row.user_id, err }, 'CalDAV sync failed');
    }
  }
  return { synced };
}

function parseIcsEvents(ics: string): Array<{ name: string; date: string }> {
  const events: Array<{ name: string; date: string }> = [];
  const blocks = ics.split('BEGIN:VEVENT');
  for (const block of blocks.slice(1)) {
    const summary = block.match(/SUMMARY:([^\r\n]+)/)?.[1]?.replace(/\\n/g, ' ').trim();
    const dtstart = block.match(/DTSTART[^:]*:(\d{8})/)?.[1];
    if (!summary || !dtstart) continue;
    const date = `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}`;
    events.push({ name: summary, date });
  }
  return events;
}

/* ============================================================================
 * Opt-in CalDAV write-back (checkbox 86)
 *
 * Contract:
 *  - Default OFF: a user_configs row only participates when
 *    `caldav_writeback_enabled = TRUE` AND `caldav_writeback_url` is set.
 *  - Auth reuses the existing Basic-auth credentials (`caldav_username` /
 *    `caldav_password_encrypted`) - no new secret material.
 *  - One remote object per entity, addressed as `PUT {collection}/{uid}.ics`
 *    where `uid` is derived deterministically from (entity type, entity id).
 *  - Create  : PUT + `If-None-Match: *` (412 when it already exists).
 *  - Update  : PUT + `If-Match: <stored ETag>` (412 when the remote changed).
 *  - Delete  : DELETE + `If-Match: <stored ETag>` (412 when the remote changed).
 *  - A 412 triggers exactly one re-fetch (GET) + one retry; a second 412 is
 *    reported as an actionable error and local state is left untouched.
 *  - Loop guard: any entity whose reminder_config carries an `importSource`
 *    (external ICS / Google / CalDAV import) is never written back, and a user
 *    whose write-back URL equals an import URL is skipped entirely.
 *  - Unchanged entities are skipped via a content hash, so a re-run does not
 *    re-PUT and can never duplicate a VEVENT.
 *  - Bounded: at most CALDAV_WRITE_BACK_MAX_OPERATIONS_PER_USER mutating HTTP
 *    calls per user per cron invocation (the job itself runs only from the
 *    existing `/api/cron/caldav-sync` schedule).
 * ========================================================================== */

export type CalDavEntityType = 'event' | 'expiry_item';

export interface CalDavTarget {
  entityType: CalDavEntityType;
  entityId: number;
  uid: string;
}

export interface CalDavWriteBackItem extends CalDavTarget {
  /** Full VCALENDAR body sent to the collection. */
  ics: string;
  /** Stable hash of the semantic payload (excludes DTSTAMP), for skip-unchanged. */
  contentHash: string;
}

export interface StoredCalDavObject {
  etag: string | null;
  contentHash: string | null;
}

export interface StoredCalDavMapping extends StoredCalDavObject {
  entityType: CalDavEntityType;
  entityId: number;
  uid: string;
  collectionUrl: string;
}

export type CalDavWriteBackAction = 'created' | 'updated' | 'deleted' | 'skipped' | 'failed';

export interface CalDavWriteBackResult {
  action: CalDavWriteBackAction;
  etag: string | null;
  contentHash: string | null;
  error?: string;
}

export interface CalDavWriteBackStats {
  /** Users with the toggle ON and a collection URL configured. */
  users: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
  /** Entities (or whole users) skipped because they originate from an external sync. */
  loopGuardSkips: number;
  errors: string[];
}

/** Upper bound on mutating HTTP calls (create/update/delete) per user per run. */
export const CALDAV_WRITE_BACK_MAX_OPERATIONS_PER_USER = 100;

/** Upper bound on rows loaded per entity table per user per run. */
export const CALDAV_WRITE_BACK_MAX_ENTITY_ROWS = 200;

const ITEM_PRODID = '-//TimeMark//CalDAV Write-Back//EN';
const UID_DOMAIN = 'timemark.app';
const DEFAULT_SUMMARY = 'TimeMark 提醒';

const EVENT_TYPE_LABELS: Record<string, string> = {
  birthday: '生日',
  exam: '考试',
  anniversary: '纪念日',
  holiday: '节日',
  other: '其他',
  meeting: '会议',
  deadline: '截止日期',
  travel: '旅行',
  graduation: '毕业',
  wedding: '婚礼',
  medical: '医疗',
};

const EXPIRY_KIND_LABELS: Record<string, string> = {
  subscription: '订阅续费',
  bill: '账单',
  domain: '域名',
  insurance: '保险',
  warranty: '保修',
  custom: '到期提醒',
};

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Stable UID derived from the entity. Deliberately free of timestamps and
 * randomness: a re-run must address the same remote object instead of creating
 * a second VEVENT.
 */
export function deriveCalDavUid(entityType: CalDavEntityType, entityId: number): string {
  const prefix = entityType === 'event' ? 'event' : 'expiry';
  return `timemark-${prefix}-${entityId}@${UID_DOMAIN}`;
}

/** Strips trailing slashes; empty input stays empty. */
export function normalizeCollectionUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withoutTrailing = trimmed.replace(/\/+$/, '');
  return withoutTrailing || trimmed;
}

/**
 * Canonical form used for equality checks (lowercased host, no query/hash, no
 * trailing slash). Returns '' for anything that cannot be parsed as a URL.
 */
export function canonicalizeCollectionUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.search = '';
    const href = parsed.href;
    return href.endsWith('/') ? href.slice(0, -1) : href;
  } catch {
    return '';
  }
}

/**
 * `{collection}/{uid}.ics`. The UID is percent-encoded, so a UID containing a
 * slash (or any other reserved character) can never escape the collection path.
 */
export function buildCalDavItemUrl(collectionUrl: string, uid: string): string {
  const base = normalizeCollectionUrl(collectionUrl);
  return `${base}/${encodeURIComponent(uid)}.ics`;
}

/**
 * RFC 5545 TEXT escaping: backslash, CRLF/LF/CR (ICS body injection), semicolon
 * and comma. Other C0 control characters are replaced with a space.
 */
export function escapeIcsText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    // eslint-disable-next-line no-control-regex -- intentionally strips C0 control chars (RFC 5545)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/** reminder_config.daysBeforeList -> unique integers in [0, 365], ascending. */
export function sanitizeAlarmDays(days: unknown): number[] {
  if (!Array.isArray(days)) return [];
  const unique = new Set<number>();
  for (const raw of days) {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 365) continue;
    unique.add(value);
  }
  return [...unique].sort((a, b) => a - b);
}

/** Reads `daysBeforeList` out of a JSONB reminder_config value (object or text). */
export function readReminderDays(reminderConfig: unknown): number[] {
  const parsed = parseJsonObject(reminderConfig);
  if (!parsed) return [];
  return sanitizeAlarmDays(parsed.daysBeforeList);
}

/**
 * Loop guard primitive: a non-empty `importSource` means the entity was created
 * by an external sync (external ICS / Google / CalDAV read path), so write-back
 * must never touch it.
 */
export function readImportSource(reminderConfig: unknown): string {
  const parsed = parseJsonObject(reminderConfig);
  if (!parsed) return '';
  const raw = parsed.importSource;
  return typeof raw === 'string' ? raw.trim() : '';
}

export function isImportedEntity(reminderConfig: unknown): boolean {
  return readImportSource(reminderConfig).length > 0;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

export interface CalDavVeventDescriptor {
  uid: string;
  summary: string;
  description: string;
  /** `YYYY-MM-DD`; an unparseable date makes the builder return null. */
  date: string;
  categories: string;
  alarmDaysBefore: number[];
}

/**
 * Deterministic hash of the semantic payload. DTSTAMP is intentionally excluded
 * so an unchanged entity produces the same hash on every run and the sync can
 * skip the PUT entirely.
 */
export function computeCalDavContentHash(descriptor: CalDavVeventDescriptor): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        descriptor.uid,
        descriptor.summary,
        descriptor.description,
        descriptor.date,
        descriptor.categories,
        sanitizeAlarmDays(descriptor.alarmDaysBefore),
      ]),
    )
    .digest('hex');
}

/** Builds a single-VEVENT VCALENDAR; null when the date is not a valid YYYY-MM-DD. */
export function buildVeventIcs(descriptor: CalDavVeventDescriptor, now: Date = new Date()): string | null {
  const dates = formatDateRange(descriptor.date);
  if (!dates) return null;

  const summary = descriptor.summary.trim() ? descriptor.summary : DEFAULT_SUMMARY;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ITEM_PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(descriptor.uid)}`,
    `DTSTAMP:${toIcsTimestamp(now)}`,
    `DTSTART;VALUE=DATE:${dates.start}`,
    `DTEND;VALUE=DATE:${dates.end}`,
    `SUMMARY:${escapeIcsText(summary)}`,
  ];
  if (descriptor.description) lines.push(`DESCRIPTION:${escapeIcsText(descriptor.description)}`);
  if (descriptor.categories) lines.push(`CATEGORIES:${escapeIcsText(descriptor.categories)}`);
  lines.push('TRANSP:TRANSPARENT');
  for (const days of sanitizeAlarmDays(descriptor.alarmDaysBefore)) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(summary)}`,
      `TRIGGER:-P${days}D`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

function formatDateRange(date: string): { start: string; end: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const start = new Date(Date.UTC(year, month - 1, day));
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) {
    return null;
  }
  const end = new Date(start.getTime() + 86_400_000);
  return { start: toIcsDate(start), end: toIcsDate(end) };
}

function toIcsDate(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}${month}${day}`;
}

function toIcsTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface EventWriteBackRow {
  id: number;
  name: string;
  type: string;
  date: string;
  personName?: string | null;
  reminderConfig?: unknown;
}

export interface ExpiryWriteBackRow {
  id: number;
  title: string;
  kind: string;
  vendor?: string | null;
  nextDueDate: string;
  reminderConfig?: unknown;
}

export function buildEventWriteBackItem(row: EventWriteBackRow): CalDavWriteBackItem | null {
  const typeLabel = EVENT_TYPE_LABELS[row.type] ?? row.type;
  const parts = [`类型: ${typeLabel}`, `日期: ${row.date}`];
  if (row.personName) parts.push(`相关人: ${row.personName}`);
  const descriptor: CalDavVeventDescriptor = {
    uid: deriveCalDavUid('event', row.id),
    summary: row.name.trim() ? row.name : DEFAULT_SUMMARY,
    description: `TimeMark 提醒\n${parts.join('\n')}`,
    date: row.date,
    categories: typeLabel,
    alarmDaysBefore: readReminderDays(row.reminderConfig),
  };
  const ics = buildVeventIcs(descriptor);
  if (!ics) return null;
  return {
    entityType: 'event',
    entityId: row.id,
    uid: descriptor.uid,
    ics,
    contentHash: computeCalDavContentHash(descriptor),
  };
}

export function buildExpiryWriteBackItem(row: ExpiryWriteBackRow): CalDavWriteBackItem | null {
  const kindLabel = EXPIRY_KIND_LABELS[row.kind] ?? row.kind;
  const parts = [`类型: ${kindLabel}`, `到期日: ${row.nextDueDate}`];
  if (row.vendor) parts.push(`供应商: ${row.vendor}`);
  const title = row.title.trim() || DEFAULT_SUMMARY;
  const descriptor: CalDavVeventDescriptor = {
    uid: deriveCalDavUid('expiry_item', row.id),
    summary: `${title}（${kindLabel}）`,
    description: `TimeMark 到期提醒\n${parts.join('\n')}`,
    date: row.nextDueDate,
    categories: kindLabel,
    alarmDaysBefore: readReminderDays(row.reminderConfig),
  };
  const ics = buildVeventIcs(descriptor);
  if (!ics) return null;
  return {
    entityType: 'expiry_item',
    entityId: row.id,
    uid: descriptor.uid,
    ics,
    contentHash: computeCalDavContentHash(descriptor),
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP client (Basic auth, minimal CalDAV collection operations)             */
/* -------------------------------------------------------------------------- */

export interface CalDavHttpResponse {
  status: number;
  etag: string | null;
  body: string | null;
}

export interface CalDavPutPrecondition {
  /** Create-only semantics: `If-None-Match: *`. */
  ifNoneMatch?: '*';
  /** Update semantics: `If-Match: <etag>`. */
  ifMatch?: string;
}

export interface CalDavDeletePrecondition {
  ifMatch?: string;
}

export interface CalDavClient {
  readonly collectionUrl: string;
  put(uid: string, icsBody: string, precondition: CalDavPutPrecondition): Promise<CalDavHttpResponse>;
  get(uid: string): Promise<CalDavHttpResponse>;
  remove(uid: string, precondition: CalDavDeletePrecondition): Promise<CalDavHttpResponse>;
}

export class CalDavTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalDavTransportError';
  }
}

export function createCalDavClient(config: {
  collectionUrl: string;
  username: string;
  password: string;
  http?: AxiosInstance;
}): CalDavClient {
  const collectionUrl = normalizeCollectionUrl(config.collectionUrl);
  const http =
    config.http ??
    axios.create({
      timeout: 15000,
      maxRedirects: 0,
      proxy: false,
      validateStatus: () => true,
      auth: config.username ? { username: config.username, password: config.password } : undefined,
      headers: { 'User-Agent': 'TimeMark/2.17 CalDAVWriteBack' },
    });

  async function send(
    method: 'GET' | 'PUT' | 'DELETE',
    uid: string,
    body: string | undefined,
    headers: Record<string, string>,
  ): Promise<CalDavHttpResponse> {
    const url = buildCalDavItemUrl(collectionUrl, uid);
    try {
      const res = await http.request<string>({ method, url, data: body, headers, responseType: 'text' });
      const etagHeader: unknown = res.headers?.etag;
      return {
        status: res.status,
        etag: typeof etagHeader === 'string' && etagHeader.length > 0 ? etagHeader : null,
        body: typeof res.data === 'string' ? res.data : null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CalDavTransportError(`${method} ${url} failed: ${message}`);
    }
  }

  return {
    collectionUrl,
    put(uid, icsBody, precondition) {
      const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' };
      if (precondition.ifNoneMatch) headers['If-None-Match'] = precondition.ifNoneMatch;
      if (precondition.ifMatch) headers['If-Match'] = precondition.ifMatch;
      return send('PUT', uid, icsBody, headers);
    },
    get(uid) {
      return send('GET', uid, undefined, { Accept: 'text/calendar' });
    },
    remove(uid, precondition) {
      const headers: Record<string, string> = {};
      if (precondition.ifMatch) headers['If-Match'] = precondition.ifMatch;
      return send('DELETE', uid, undefined, headers);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Single-object push / delete with 412 recovery                              */
/* -------------------------------------------------------------------------- */

function isHttpSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function describeTarget(target: CalDavTarget): string {
  return `${target.entityType} ${target.entityId} (uid ${target.uid})`;
}

function writeBackFailure(target: CalDavTarget, detail: string): CalDavWriteBackResult {
  return {
    action: 'failed',
    etag: null,
    contentHash: null,
    error:
      `CalDAV write-back failed for ${describeTarget(target)}: ${detail}. ` +
      'Local state was NOT modified; re-run the caldav-sync cron job after checking the write-back ' +
      'collection URL and credentials.',
  };
}

function preconditionFailure(target: CalDavTarget, verb: string): CalDavWriteBackResult {
  return writeBackFailure(
    target,
    `${verb} returned 412 Precondition Failed after a re-fetch and exactly one retry - the remote ` +
      'calendar is changing concurrently or rejects this write',
  );
}

/** ETag from the response, or a follow-up GET when the server omitted it. */
async function resolveEtagForUid(client: CalDavClient, uid: string, res: CalDavHttpResponse): Promise<string | null> {
  if (res.etag) return res.etag;
  const fetched = await client.get(uid);
  return fetched.status === 200 ? fetched.etag : null;
}

async function putCreateOrRecover(client: CalDavClient, item: CalDavWriteBackItem): Promise<CalDavWriteBackResult> {
  const first = await client.put(item.uid, item.ics, { ifNoneMatch: '*' });
  if (isHttpSuccess(first.status)) {
    return { action: 'created', etag: await resolveEtagForUid(client, item.uid, first), contentHash: item.contentHash };
  }
  if (first.status !== 412) {
    return writeBackFailure(item, `PUT (If-None-Match: *) returned HTTP ${first.status}`);
  }

  // 412 here means the remote object already exists (e.g. a previous run crashed
  // before its mapping was stored). Re-fetch once, then retry once as an update.
  const current = await client.get(item.uid);
  if (current.status === 404) {
    const retry = await client.put(item.uid, item.ics, { ifNoneMatch: '*' });
    if (isHttpSuccess(retry.status)) {
      return { action: 'created', etag: await resolveEtagForUid(client, item.uid, retry), contentHash: item.contentHash };
    }
    return writeBackFailure(item, `retry PUT (If-None-Match: *) returned HTTP ${retry.status}`);
  }
  if (current.status !== 200 || !current.etag) {
    return writeBackFailure(item, `re-fetch after 412 returned HTTP ${current.status} without an ETag`);
  }
  const retry = await client.put(item.uid, item.ics, { ifMatch: current.etag });
  if (isHttpSuccess(retry.status)) {
    return { action: 'updated', etag: await resolveEtagForUid(client, item.uid, retry), contentHash: item.contentHash };
  }
  if (retry.status === 412) return preconditionFailure(item, 'retry PUT (If-Match)');
  return writeBackFailure(item, `retry PUT (If-Match) returned HTTP ${retry.status}`);
}

async function putWithStoredEtag(
  client: CalDavClient,
  item: CalDavWriteBackItem,
  storedEtag: string,
): Promise<CalDavWriteBackResult> {
  const res = await client.put(item.uid, item.ics, { ifMatch: storedEtag });
  if (isHttpSuccess(res.status)) {
    return { action: 'updated', etag: await resolveEtagForUid(client, item.uid, res), contentHash: item.contentHash };
  }
  if (res.status === 404) {
    // The remote object disappeared (deleted in the calendar app): recreate it.
    return putCreateOrRecover(client, item);
  }
  if (res.status !== 412) {
    return writeBackFailure(item, `PUT (If-Match) returned HTTP ${res.status}`);
  }

  const current = await client.get(item.uid);
  if (current.status === 404) return putCreateOrRecover(client, item);
  if (current.status !== 200 || !current.etag) {
    return writeBackFailure(item, `re-fetch after 412 returned HTTP ${current.status} without an ETag`);
  }
  const retry = await client.put(item.uid, item.ics, { ifMatch: current.etag });
  if (isHttpSuccess(retry.status)) {
    return { action: 'updated', etag: await resolveEtagForUid(client, item.uid, retry), contentHash: item.contentHash };
  }
  if (retry.status === 412) return preconditionFailure(item, 'retry PUT (If-Match)');
  return writeBackFailure(item, `retry PUT (If-Match) returned HTTP ${retry.status}`);
}

/**
 * Create or update one entity. `stored` comes from caldav_writeback_objects;
 * when unchanged (same content hash + an ETag) nothing is sent at all.
 */
export async function pushCalDavItem(
  client: CalDavClient,
  item: CalDavWriteBackItem,
  stored?: StoredCalDavObject,
): Promise<CalDavWriteBackResult> {
  const storedEtag = stored?.etag ?? null;
  if (storedEtag && stored?.contentHash === item.contentHash) {
    return { action: 'skipped', etag: storedEtag, contentHash: item.contentHash };
  }
  try {
    if (storedEtag) return await putWithStoredEtag(client, item, storedEtag);
    return await putCreateOrRecover(client, item);
  } catch (err) {
    return writeBackFailure(item, err instanceof Error ? err.message : String(err));
  }
}

async function deleteWithEtag(
  client: CalDavClient,
  target: CalDavTarget,
  etag: string,
): Promise<CalDavWriteBackResult> {
  const res = await client.remove(target.uid, { ifMatch: etag });
  if (isHttpSuccess(res.status) || res.status === 404) {
    return { action: 'deleted', etag: null, contentHash: null };
  }
  if (res.status !== 412) {
    return writeBackFailure(target, `DELETE (If-Match) returned HTTP ${res.status}`);
  }

  const current = await client.get(target.uid);
  if (current.status === 404) return { action: 'deleted', etag: null, contentHash: null };
  if (current.status !== 200 || !current.etag) {
    return writeBackFailure(target, `re-fetch after 412 returned HTTP ${current.status} without an ETag`);
  }
  const retry = await client.remove(target.uid, { ifMatch: current.etag });
  if (isHttpSuccess(retry.status) || retry.status === 404) {
    return { action: 'deleted', etag: null, contentHash: null };
  }
  if (retry.status === 412) return preconditionFailure(target, 'retry DELETE (If-Match)');
  return writeBackFailure(target, `retry DELETE (If-Match) returned HTTP ${retry.status}`);
}

/** Deletes the remote object for an entity that no longer qualifies. */
export async function removeCalDavItem(
  client: CalDavClient,
  target: CalDavTarget,
  stored: StoredCalDavObject,
): Promise<CalDavWriteBackResult> {
  try {
    const etag = stored.etag;
    if (!etag) {
      const current = await client.get(target.uid);
      if (current.status === 404) return { action: 'deleted', etag: null, contentHash: null };
      if (current.status === 200 && current.etag) return await deleteWithEtag(client, target, current.etag);
      return writeBackFailure(target, `DELETE precondition lookup returned HTTP ${current.status} without an ETag`);
    }
    return await deleteWithEtag(client, target, etag);
  } catch (err) {
    return writeBackFailure(target, err instanceof Error ? err.message : String(err));
  }
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

interface StaleEntityState {
  state: 'missing' | 'imported' | 'still_qualifying' | 'not_qualifying';
  reminderConfig: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object');
}

/** Accepts a JSONB array (already parsed or as text) and returns its strings. */
function asStringArray(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function mappingKey(entityType: CalDavEntityType, entityId: number): string {
  return `${entityType}:${entityId}`;
}

function isReminderEnabled(reminderConfig: unknown): boolean {
  const parsed = parseJsonObject(reminderConfig);
  if (!parsed || parsed.enabled === undefined) return true;
  return parsed.enabled === true || parsed.enabled === 'true';
}

async function classifyStaleEntity(userId: number, entityType: CalDavEntityType, entityId: number): Promise<StaleEntityState> {
  if (entityType === 'event') {
    const res = await query('SELECT id, reminder_config FROM events WHERE user_id = $1 AND id = $2', [userId, entityId]);
    const row = asRecordArray(res.rows)[0];
    if (!row) return { state: 'missing', reminderConfig: null };
    if (isImportedEntity(row.reminder_config)) return { state: 'imported', reminderConfig: row.reminder_config };
    return { state: isReminderEnabled(row.reminder_config) ? 'still_qualifying' : 'not_qualifying', reminderConfig: row.reminder_config };
  }
  const res = await query('SELECT id, is_active, reminder_config FROM expiry_items WHERE user_id = $1 AND id = $2', [userId, entityId]);
  const row = asRecordArray(res.rows)[0];
  if (!row) return { state: 'missing', reminderConfig: null };
  if (isImportedEntity(row.reminder_config)) return { state: 'imported', reminderConfig: row.reminder_config };
  return { state: row.is_active === true ? 'still_qualifying' : 'not_qualifying', reminderConfig: row.reminder_config };
}

async function upsertWriteBackObject(
  userId: number,
  item: CalDavWriteBackItem,
  collectionUrl: string,
  result: CalDavWriteBackResult,
): Promise<void> {
  await query(
    `INSERT INTO caldav_writeback_objects
       (user_id, entity_type, entity_id, uid, collection_url, etag, content_hash, last_pushed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET
       uid = EXCLUDED.uid,
       collection_url = EXCLUDED.collection_url,
       etag = EXCLUDED.etag,
       content_hash = EXCLUDED.content_hash,
       last_pushed_at = CURRENT_TIMESTAMP`,
    [userId, item.entityType, item.entityId, item.uid, collectionUrl, result.etag, result.contentHash],
  );
}

async function deleteWriteBackObject(userId: number, entityType: CalDavEntityType, entityId: number): Promise<void> {
  await query('DELETE FROM caldav_writeback_objects WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3', [
    userId,
    entityType,
    entityId,
  ]);
}

async function syncUserWriteBack(userId: number, row: Record<string, unknown>, stats: CalDavWriteBackStats): Promise<void> {
  const rawTarget = asString(row.caldav_writeback_url);
  const target = normalizeCollectionUrl(rawTarget);
  const canonicalTarget = canonicalizeCollectionUrl(rawTarget);
  if (!target || !canonicalTarget) {
    stats.errors.push(`user ${userId}: caldav_writeback_url is not a valid URL`);
    return;
  }

  // Loop guard (user level): never write into a collection we also import from.
  const importSources = [asString(row.caldav_url), ...asStringArray(row.external_calendar_urls)];
  for (const importRaw of importSources) {
    if (canonicalizeCollectionUrl(importRaw) === canonicalTarget) {
      stats.loopGuardSkips++;
      log.warn({ userId }, 'CalDAV write-back skipped: target collection is also an import source (loop guard)');
      return;
    }
  }

  const safe = await isSafePublicUrl(target);
  if (!safe.safe) {
    stats.errors.push(`user ${userId}: write-back URL rejected (${safe.reason ?? 'unsafe URL'})`);
    return;
  }

  const username = asString(row.caldav_username);
  const encryptedPassword = asString(row.caldav_password_encrypted);
  const password = decryptCalDavPassword(encryptedPassword);
  if (encryptedPassword && !password) {
    stats.errors.push(`user ${userId}: CalDAV password could not be decrypted`);
    return;
  }
  const client = createCalDavClient({ collectionUrl: target, username, password });

  const mappingsRes = await query(
    `SELECT entity_type, entity_id, uid, collection_url, etag, content_hash
       FROM caldav_writeback_objects WHERE user_id = $1`,
    [userId],
  );
  const mappings = new Map<string, StoredCalDavMapping>();
  for (const row_ of asRecordArray(mappingsRes.rows)) {
    const entityType = row_.entity_type === 'expiry_item' ? 'expiry_item' : 'event';
    const entityId = Number(row_.entity_id);
    if (!Number.isInteger(entityId)) continue;
    mappings.set(mappingKey(entityType, entityId), {
      entityType,
      entityId,
      uid: asString(row_.uid),
      collectionUrl: asString(row_.collection_url),
      etag: asNullableString(row_.etag),
      contentHash: asNullableString(row_.content_hash),
    });
  }

  const eventsRes = await query(
    `SELECT id, name, type, date::text AS date, person_name, reminder_config
       FROM events
      WHERE user_id = $1 AND COALESCE(reminder_config->>'enabled', 'true') = 'true'
      ORDER BY id
      LIMIT $2`,
    [userId, CALDAV_WRITE_BACK_MAX_ENTITY_ROWS],
  );
  const expiryRes = await query(
    `SELECT id, title, kind, vendor, next_due_date::text AS next_due_date, reminder_config
       FROM expiry_items
      WHERE user_id = $1 AND is_active = TRUE
      ORDER BY id
      LIMIT $2`,
    [userId, CALDAV_WRITE_BACK_MAX_ENTITY_ROWS],
  );

  const desired = new Map<string, CalDavWriteBackItem>();
  for (const raw of asRecordArray(eventsRes.rows)) {
    if (isImportedEntity(raw.reminder_config)) {
      stats.loopGuardSkips++;
      continue;
    }
    const item = buildEventWriteBackItem({
      id: Number(raw.id),
      name: asString(raw.name),
      type: asString(raw.type) || 'other',
      date: asString(raw.date),
      personName: asNullableString(raw.person_name),
      reminderConfig: raw.reminder_config,
    });
    if (!item) {
      stats.skipped++;
      continue;
    }
    desired.set(mappingKey(item.entityType, item.entityId), item);
  }
  for (const raw of asRecordArray(expiryRes.rows)) {
    if (isImportedEntity(raw.reminder_config)) {
      stats.loopGuardSkips++;
      continue;
    }
    const item = buildExpiryWriteBackItem({
      id: Number(raw.id),
      title: asString(raw.title),
      kind: asString(raw.kind) || 'custom',
      vendor: asNullableString(raw.vendor),
      nextDueDate: asString(raw.next_due_date),
      reminderConfig: raw.reminder_config,
    });
    if (!item) {
      stats.skipped++;
      continue;
    }
    desired.set(mappingKey(item.entityType, item.entityId), item);
  }

  let operations = 0;

  // Stale mappings first: the entity no longer qualifies (deleted / reminder off /
  // item inactive) - remove the remote object, guarded against imported rows.
  for (const mapping of mappings.values()) {
    if (desired.has(mappingKey(mapping.entityType, mapping.entityId))) continue;
    if (operations >= CALDAV_WRITE_BACK_MAX_OPERATIONS_PER_USER) {
      stats.skipped++;
      continue;
    }
    const classification = await classifyStaleEntity(userId, mapping.entityType, mapping.entityId);
    if (classification.state === 'imported') {
      stats.loopGuardSkips++;
      log.warn(
        { userId, entityType: mapping.entityType, entityId: mapping.entityId },
        'CalDAV write-back skipped a remote delete: entity originates from an external sync (loop guard)',
      );
      continue;
    }
    if (classification.state === 'still_qualifying') {
      // Loaded beyond CALDAV_WRITE_BACK_MAX_ENTITY_ROWS - leave it alone, no churn.
      stats.skipped++;
      continue;
    }
    if (canonicalizeCollectionUrl(mapping.collectionUrl) !== canonicalTarget) {
      // The remote object lives in a previously configured collection; we cannot
      // address it with the current URL, so leave both the object and the mapping.
      stats.skipped++;
      continue;
    }
    operations++;
    const result = await removeCalDavItem(
      client,
      { entityType: mapping.entityType, entityId: mapping.entityId, uid: mapping.uid },
      mapping,
    );
    if (result.action === 'deleted') {
      stats.deleted++;
      await deleteWriteBackObject(userId, mapping.entityType, mapping.entityId);
    } else if (result.action === 'failed') {
      stats.failed++;
      if (result.error) stats.errors.push(result.error);
    } else {
      stats.skipped++;
    }
  }

  // Then create/update the desired entities.
  for (const item of desired.values()) {
    if (operations >= CALDAV_WRITE_BACK_MAX_OPERATIONS_PER_USER) {
      stats.skipped++;
      continue;
    }
    const mapping = mappings.get(mappingKey(item.entityType, item.entityId));
    const stored =
      mapping && canonicalizeCollectionUrl(mapping.collectionUrl) === canonicalTarget
        ? { etag: mapping.etag, contentHash: mapping.contentHash }
        : undefined;
    operations++;
    const result = await pushCalDavItem(client, item, stored);
    if (result.action === 'created') stats.created++;
    else if (result.action === 'updated') stats.updated++;
    else if (result.action === 'skipped') stats.skipped++;

    if (result.action === 'created' || result.action === 'updated') {
      await upsertWriteBackObject(userId, item, canonicalTarget, result);
    } else if (result.action === 'failed') {
      // Deliberately no write to caldav_writeback_objects: the previous ETag /
      // hash stays intact so the next run retries the same precondition.
      stats.failed++;
      if (result.error) stats.errors.push(result.error);
      log.warn(
        { userId, entityType: item.entityType, entityId: item.entityId, uid: item.uid },
        'CalDAV write-back failed; local state left unchanged',
      );
    }
  }
}

/**
 * Opt-in write-back entry point, run from the existing `/api/cron/caldav-sync`
 * job. Users without the toggle are not even selected, so the default state
 * performs a single cheap SELECT.
 */
export async function syncCalDavWriteBack(): Promise<CalDavWriteBackStats> {
  const stats: CalDavWriteBackStats = {
    users: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    loopGuardSkips: 0,
    errors: [],
  };

  const users = await query(
    `SELECT user_id, caldav_username, caldav_password_encrypted, caldav_url,
            external_calendar_urls, caldav_writeback_url
       FROM user_configs
      WHERE caldav_writeback_enabled = TRUE
        AND caldav_writeback_url IS NOT NULL
        AND caldav_writeback_url != ''`,
  );

  for (const row of asRecordArray(users.rows)) {
    const userId = Number(row.user_id);
    if (!Number.isInteger(userId)) continue;
    stats.users++;
    try {
      await syncUserWriteBack(userId, row, stats);
    } catch (err) {
      stats.errors.push(`user ${userId}: write-back aborted (${err instanceof Error ? err.message : String(err)})`);
      log.warn({ userId, err }, 'CalDAV write-back aborted for user');
    }
  }

  if (stats.users > 0) {
    log.info(
      {
        users: stats.users,
        created: stats.created,
        updated: stats.updated,
        deleted: stats.deleted,
        skipped: stats.skipped,
        failed: stats.failed,
        loopGuardSkips: stats.loopGuardSkips,
      },
      'CalDAV write-back finished',
    );
  }
  return stats;
}
