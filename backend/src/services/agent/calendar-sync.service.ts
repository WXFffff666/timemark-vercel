/**
 * Two-way calendar sync (task 159) - Outlook/Exchange + CalDAV write.
 *
 * A `calendar_sync_accounts` row is a per-user external target. The `kind` picks
 * the adapter: a real CalDAV client is built in (GET the collection / PUT an
 * iCalendar object), while Exchange is an adapter SEAM - the built-in Exchange
 * provider deliberately reports `unsupported` rather than faking a success. A
 * caller (worker/tests) can inject any `CalendarProvider` via the `provider`
 * option.
 *
 * Guarantees:
 *   - Idempotent pull. Imported objects are keyed by (account, calendar id,
 *     external UID) in `calendar_sync_events`; a re-pull updates the mapped row
 *     instead of inserting a duplicate event.
 *   - Every outbound host goes through the shipped egress guard
 *     (`egress-guard.service.ts`); a blocked host throws `EgressBlockedError`.
 *   - Credentials are AES-GCM encrypted at rest (shared crypto util / MASTER_KEY),
 *     decrypted only in memory, and NEVER logged or serialised into a view.
 *   - Conflict policy defaults to last-write-wins; the discarded version is
 *     recorded in `losing_version`.
 *   - `dryRun` performs no writes (no DB mutation, no PUT).
 *
 * Exports the default Hono-free service surface consumed by
 * `routes/calendar-sync.ts`.
 */
import { createHash } from 'crypto';
import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { encrypt, decrypt } from '@timemark/shared/crypto';
import { requireMasterKey } from '../../utils/secrets.js';
import { isSafePublicUrl } from '../../utils/url-safety.js';
import { createEvent } from '../event.service.js';
import { createEgressGuard, EgressBlockedError, type EgressGuard } from './egress-guard.service.js';

const log = createLogger('calendar-sync');

export const CALENDAR_SYNC_KINDS = ['caldav', 'exchange'] as const;
export type CalendarSyncKind = (typeof CALENDAR_SYNC_KINDS)[number];

export const CALENDAR_SYNC_DIRECTIONS = ['pull', 'push', 'both'] as const;
export type CalendarSyncDirection = (typeof CALENDAR_SYNC_DIRECTIONS)[number];

export const CONFLICT_POLICIES = ['last_write_wins', 'local_wins', 'remote_wins'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

/** External events imported from a sync account are tagged so they are not pushed back. */
const IMPORT_SOURCE = 'calendar_sync';
const MAX_EVENTS_PER_RUN = 500;

export class CalendarSyncError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CalendarSyncError';
    this.code = code;
  }
}

/** The remote adapter (or its transport) failed. */
export class CalendarProviderError extends CalendarSyncError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'CalendarProviderError';
  }
}

export class CalendarSyncAccountError extends CalendarSyncError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'CalendarSyncAccountError';
  }
}

// ---------------------------------------------------------------------------
// Provider seam
// ---------------------------------------------------------------------------

export interface ExternalCalendarEvent {
  uid: string;
  calendarId: string;
  name: string;
  date: string;
  /** ETag / Exchange changeKey / ICS LAST-MODIFIED marker. */
  version: string | null;
  updatedAt: string | null;
}

export interface OutboundCalendarEvent {
  uid: string;
  calendarId: string;
  name: string;
  date: string;
  /** Last remote version we saw; drives If-Match and conflict detection. */
  version: string | null;
}

export type ProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; unsupported: true; reason: string };

/** The guarded transport signature exposed by `EgressGuard.fetch`. */
export type GuardFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CalendarProvider {
  readonly kind: CalendarSyncKind;
  listEvents(account: ResolvedCalendarAccount): Promise<ProviderResult<ExternalCalendarEvent[]>>;
  putEvent(
    account: ResolvedCalendarAccount,
    event: OutboundCalendarEvent,
  ): Promise<ProviderResult<{ version: string | null }>>;
}

export interface ResolvedCalendarAccount {
  id: number;
  userId: number;
  kind: CalendarSyncKind;
  baseUrl: string;
  calendarId: string;
  direction: CalendarSyncDirection;
  conflictPolicy: ConflictPolicy;
  username: string | null;
  /** Decrypted in memory only. Never logged, never returned in a view. */
  credentials: string | null;
}

// ---------------------------------------------------------------------------
// Credential protection (encrypt at rest, decrypt in memory, never log)
// ---------------------------------------------------------------------------

export function encryptCalendarCredentials(plain: string | null | undefined): string | null {
  const trimmed = (plain ?? '').trim();
  if (!trimmed) return null;
  return encrypt(trimmed, requireMasterKey());
}

function decryptCalendarCredentials(ciphertext: unknown): string | null {
  if (ciphertext == null || String(ciphertext) === '') return null;
  try {
    return decrypt(String(ciphertext), requireMasterKey());
  } catch {
    throw new CalendarSyncAccountError('credentials_decrypt_failed', '凭据解密失败：MASTER_KEY 可能已更改');
  }
}

// ---------------------------------------------------------------------------
// ICS helpers (minimal, deterministic)
// ---------------------------------------------------------------------------

function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function normalizeIcsDate(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const y = digits.slice(0, 4);
  const m = digits.slice(4, 6);
  const d = digits.slice(6, 8);
  return `${y}-${m}-${d}`;
}

function icsDateToIso(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const date = new Date(
    Date.UTC(
      Number(digits.slice(0, 4)),
      Number(digits.slice(4, 6)) - 1,
      Number(digits.slice(6, 8)),
      digits.length >= 14 ? Number(digits.slice(8, 10)) : 0,
      digits.length >= 14 ? Number(digits.slice(10, 12)) : 0,
      digits.length >= 14 ? Number(digits.slice(12, 14)) : 0,
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Parse the VEVENTs of an iCalendar body into the external-event shape. */
export function parseIcsEvents(ics: string, calendarId: string): ExternalCalendarEvent[] {
  const out: ExternalCalendarEvent[] = [];
  const blocks = ics.split(/BEGIN:VEVENT/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/END:VEVENT/i)[0] ?? '';
    const get = (prop: string): string | null => {
      const match = body.match(new RegExp(`^${prop}[^:\\r\\n]*:(.*)$`, 'im'));
      return match ? match[1]!.trim() : null;
    };
    const uid = get('UID');
    const summary = get('SUMMARY');
    const dtstart = get('DTSTART');
    if (!uid || !summary || !dtstart) continue;
    const date = normalizeIcsDate(dtstart);
    if (!date) continue;
    const lastModified = get('LAST-MODIFIED');
    const etag = get('X-ETAG') ?? get('ETAG');
    const sequence = get('SEQUENCE');
    out.push({
      uid,
      calendarId,
      name: summary,
      date,
      version: etag ?? (lastModified ? `lm:${lastModified}` : sequence ? `seq:${sequence}` : null),
      updatedAt: lastModified ? icsDateToIso(lastModified) : null,
    });
  }
  return out;
}

export function buildIcsEvent(uid: string, name: string, date: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TimeMark//Calendar Sync 159//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(uid)}`,
    `DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${escapeIcsText(name)}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export function deriveExternalUid(accountId: number, localEventId: number): string {
  return `timemark-${accountId}-${localEventId}`;
}

function contentHash(name: string, date: string, type: string): string {
  return createHash('sha256').update(`${name}\u0000${date}\u0000${type}`).digest('hex').slice(0, 40);
}

function ensureCollectionUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function buildObjectUrl(baseUrl: string, uid: string): string {
  const base = ensureCollectionUrl(baseUrl);
  const safeUid = uid.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${base}${safeUid}.ics`;
}

function authHeaders(account: ResolvedCalendarAccount): Record<string, string> {
  if (!account.username || !account.credentials) return {};
  const token = Buffer.from(`${account.username}:${account.credentials}`, 'utf8').toString('base64');
  return { authorization: `Basic ${token}` };
}

// ---------------------------------------------------------------------------
// Built-in adapters
// ---------------------------------------------------------------------------

export class CaldavCalendarProvider implements CalendarProvider {
  readonly kind = 'caldav' as const;
  constructor(private readonly fetchImpl: GuardFetch) {}

  async listEvents(account: ResolvedCalendarAccount): Promise<ProviderResult<ExternalCalendarEvent[]>> {
    const url = ensureCollectionUrl(account.baseUrl);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'text/calendar, text/plain;q=0.5', ...authHeaders(account) },
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new CalendarProviderError('caldav_network_error', `CalDAV 请求失败：${errText(error)}`);
    }
    // A collection that refuses a plain GET is a real limitation, not a failure.
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return { ok: false, unsupported: true, reason: `CalDAV 服务器不支持集合 GET (HTTP ${res.status})` };
    }
    if (!res.ok) {
      throw new CalendarProviderError('caldav_http_error', `CalDAV 返回 HTTP ${res.status}`);
    }
    const text = await res.text();
    return { ok: true, value: parseIcsEvents(text, account.calendarId) };
  }

  async putEvent(
    account: ResolvedCalendarAccount,
    event: OutboundCalendarEvent,
  ): Promise<ProviderResult<{ version: string | null }>> {
    const url = buildObjectUrl(account.baseUrl, event.uid);
    const headers: Record<string, string> = {
      'content-type': 'text/calendar; charset=utf-8',
      ...authHeaders(account),
    };
    if (event.version) headers['if-match'] = event.version;
    else headers['if-none-match'] = '*';

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'PUT',
        headers,
        body: buildIcsEvent(event.uid, event.name, event.date),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new CalendarProviderError('caldav_network_error', `CalDAV PUT 失败：${errText(error)}`);
    }
    if (res.status === 405 || res.status === 501) {
      return { ok: false, unsupported: true, reason: `CalDAV 服务器不支持 PUT (HTTP ${res.status})` };
    }
    if (res.status === 412) {
      throw new CalendarProviderError('caldav_precondition_failed', '远程对象已变更（HTTP 412）');
    }
    if (!res.ok) {
      throw new CalendarProviderError('caldav_http_error', `CalDAV PUT 返回 HTTP ${res.status}`);
    }
    return { ok: true, value: { version: res.headers.get('etag') ?? event.version } };
  }
}

/**
 * Exchange/EWS/Graph adapter SEAM. No implementation is shipped, so it reports
 * `unsupported` - it must never pretend a write succeeded. Inject a real
 * provider through the `provider` option to enable Exchange.
 */
export class ExchangeCalendarProvider implements CalendarProvider {
  readonly kind = 'exchange' as const;
  async listEvents(): Promise<ProviderResult<ExternalCalendarEvent[]>> {
    return { ok: false, unsupported: true, reason: 'Exchange/EWS 适配器未注入（CalendarProvider seam）' };
  }
  async putEvent(): Promise<ProviderResult<{ version: string | null }>> {
    return { ok: false, unsupported: true, reason: 'Exchange/EWS 适配器未注入（CalendarProvider seam）' };
  }
}

export function defaultCalendarProvider(kind: CalendarSyncKind, fetchImpl: GuardFetch): CalendarProvider {
  return kind === 'exchange' ? new ExchangeCalendarProvider() : new CaldavCalendarProvider(fetchImpl);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Account CRUD (views never contain credentials)
// ---------------------------------------------------------------------------

export interface CalendarSyncAccountView {
  id: number;
  kind: CalendarSyncKind;
  baseUrl: string;
  username: string | null;
  calendarId: string;
  direction: CalendarSyncDirection;
  conflictPolicy: ConflictPolicy;
  enabled: boolean;
  hasCredentials: boolean;
  lastSyncedAt: string | null;
  createdAt: string | null;
}

interface CalendarSyncAccountRow {
  id: number | string;
  user_id: number;
  kind: CalendarSyncKind;
  base_url: string;
  username: string | null;
  credentials_encrypted: string | null;
  calendar_id: string;
  direction: CalendarSyncDirection;
  conflict_policy: ConflictPolicy;
  enabled: boolean;
  last_synced_at: string | Date | null;
  created_at: string | Date | null;
}

export interface CreateCalendarSyncAccountInput {
  kind: CalendarSyncKind;
  baseUrl: string;
  username?: string | null;
  credentials?: string | null;
  calendarId?: string | null;
  direction?: CalendarSyncDirection;
  conflictPolicy?: ConflictPolicy;
  enabled?: boolean;
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toAccountView(row: CalendarSyncAccountRow): CalendarSyncAccountView {
  return {
    id: Number(row.id),
    kind: row.kind,
    baseUrl: row.base_url,
    username: row.username,
    calendarId: row.calendar_id,
    direction: row.direction,
    conflictPolicy: row.conflict_policy,
    enabled: row.enabled,
    hasCredentials: row.credentials_encrypted != null && row.credentials_encrypted !== '',
    lastSyncedAt: toIso(row.last_synced_at),
    createdAt: toIso(row.created_at),
  };
}

async function loadAccountRow(userId: number, accountId: number): Promise<CalendarSyncAccountRow> {
  const result = await query('SELECT * FROM calendar_sync_accounts WHERE id = $1 AND user_id = $2', [
    accountId,
    userId,
  ]);
  const row = result.rows[0] as CalendarSyncAccountRow | undefined;
  if (!row) throw new CalendarSyncAccountError('account_not_found', '同步账户不存在');
  return row;
}

function resolveAccount(row: CalendarSyncAccountRow): ResolvedCalendarAccount {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    kind: row.kind,
    baseUrl: row.base_url,
    calendarId: row.calendar_id,
    direction: row.direction,
    conflictPolicy: row.conflict_policy,
    username: row.username,
    credentials: decryptCalendarCredentials(row.credentials_encrypted),
  };
}

export async function createCalendarSyncAccount(
  userId: number,
  input: CreateCalendarSyncAccountInput,
): Promise<CalendarSyncAccountView> {
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) throw new CalendarSyncAccountError('invalid_url', '日历地址不能为空');
  const safe = await isSafePublicUrl(baseUrl);
  if (!safe.safe) throw new CalendarSyncAccountError('unsafe_url', safe.reason ?? '日历地址不安全');

  const encrypted = encryptCalendarCredentials(input.credentials ?? null);
  const result = await query(
    `INSERT INTO calendar_sync_accounts
       (user_id, kind, base_url, username, credentials_encrypted, calendar_id, direction, conflict_policy, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      userId,
      input.kind,
      baseUrl,
      input.username?.trim() || null,
      encrypted,
      input.calendarId?.trim() || 'default',
      input.direction ?? 'both',
      input.conflictPolicy ?? 'last_write_wins',
      input.enabled ?? true,
    ],
  );
  log.info({ event: 'calendar_sync.account_created', userId, accountId: Number((result.rows[0] as CalendarSyncAccountRow).id), kind: input.kind }, 'calendar sync account created');
  return toAccountView(result.rows[0] as CalendarSyncAccountRow);
}

export async function listCalendarSyncAccounts(userId: number): Promise<CalendarSyncAccountView[]> {
  const result = await query(
    'SELECT * FROM calendar_sync_accounts WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100',
    [userId],
  );
  return result.rows.map((row) => toAccountView(row as CalendarSyncAccountRow));
}

export interface UpdateCalendarSyncAccountInput {
  username?: string | null;
  credentials?: string | null;
  calendarId?: string;
  direction?: CalendarSyncDirection;
  conflictPolicy?: ConflictPolicy;
  enabled?: boolean;
}

export async function updateCalendarSyncAccount(
  userId: number,
  accountId: number,
  patch: UpdateCalendarSyncAccountInput,
): Promise<CalendarSyncAccountView> {
  await loadAccountRow(userId, accountId);
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.username !== undefined) push('username', patch.username?.trim() || null);
  if (patch.credentials !== undefined) push('credentials_encrypted', encryptCalendarCredentials(patch.credentials));
  if (patch.calendarId !== undefined) push('calendar_id', patch.calendarId.trim() || 'default');
  if (patch.direction !== undefined) push('direction', patch.direction);
  if (patch.conflictPolicy !== undefined) push('conflict_policy', patch.conflictPolicy);
  if (patch.enabled !== undefined) push('enabled', patch.enabled);
  if (sets.length === 0) return toAccountView(await loadAccountRow(userId, accountId));

  params.push(accountId, userId);
  const result = await query(
    `UPDATE calendar_sync_accounts SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length - 1} AND user_id = $${params.length}
     RETURNING *`,
    params,
  );
  return toAccountView(result.rows[0] as CalendarSyncAccountRow);
}

export async function deleteCalendarSyncAccount(userId: number, accountId: number): Promise<boolean> {
  const result = await query('DELETE FROM calendar_sync_accounts WHERE id = $1 AND user_id = $2 RETURNING id', [
    accountId,
    userId,
  ]);
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Sync runs
// ---------------------------------------------------------------------------

export interface CalendarSyncRunOptions {
  dryRun?: boolean;
  provider?: CalendarProvider;
  guard?: EgressGuard;
  now?: () => number;
}

export interface CalendarSyncRunResult {
  accountId: number;
  direction: 'pull' | 'push';
  dryRun: boolean;
  imported: number;
  updated: number;
  skipped: number;
  conflicts: number;
  losingVersions: string[];
  unsupported: boolean;
  errors: string[];
}

interface SyncMappingRow {
  id: number | string;
  account_id: number | string;
  external_uid: string;
  calendar_id: string;
  local_event_id: number | null;
  external_version: string | null;
  local_version: string | null;
  last_synced_at: string | Date | null;
}

interface LocalEventRow {
  id: number;
  name: string;
  type: string;
  date: string | Date;
  import_source: string | null;
}

function isoDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function emptyRun(accountId: number, direction: 'pull' | 'push', dryRun: boolean): CalendarSyncRunResult {
  return { accountId, direction, dryRun, imported: 0, updated: 0, skipped: 0, conflicts: 0, losingVersions: [], unsupported: false, errors: [] };
}

function makeProvider(account: ResolvedCalendarAccount, options: CalendarSyncRunOptions): CalendarProvider {
  if (options.provider) return options.provider;
  const guard = options.guard ?? createEgressGuard();
  // Every outbound host is funnelled through the guard's fetch.
  return defaultCalendarProvider(account.kind, guard.fetch);
}

async function upsertMapping(
  userId: number,
  accountId: number,
  calendarId: string,
  uid: string,
  fields: {
    localEventId: number | null;
    externalVersion: string | null;
    localVersion: string | null;
    losingVersion: string | null;
    direction: string;
  },
): Promise<void> {
  await query(
    `INSERT INTO calendar_sync_events
       (user_id, account_id, external_uid, calendar_id, local_event_id, external_version, local_version, losing_version, last_direction, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (account_id, calendar_id, external_uid)
     DO UPDATE SET
       local_event_id = COALESCE(EXCLUDED.local_event_id, calendar_sync_events.local_event_id),
       external_version = EXCLUDED.external_version,
       local_version = EXCLUDED.local_version,
       losing_version = EXCLUDED.losing_version,
       last_direction = EXCLUDED.last_direction,
       last_synced_at = now(),
       updated_at = now()`,
    [userId, accountId, uid, calendarId, fields.localEventId, fields.externalVersion, fields.localVersion, fields.losingVersion, fields.direction],
  );
}

async function applyExternalToLocal(userId: number, localEventId: number, remote: ExternalCalendarEvent): Promise<void> {
  await query('UPDATE events SET name = $1, date = $2 WHERE id = $3 AND user_id = $4', [
    remote.name,
    remote.date,
    localEventId,
    userId,
  ]);
}

/**
 * Pull external events into the local calendar, idempotently. Dedupe key is
 * (account_id, calendar_id, external_uid): a re-pull of the same UID updates the
 * mapped event rather than inserting a second copy.
 */
export async function pullCalendarSync(
  userId: number,
  accountId: number,
  options: CalendarSyncRunOptions = {},
): Promise<CalendarSyncRunResult> {
  const dryRun = options.dryRun === true;
  const row = await loadAccountRow(userId, accountId);
  const account = resolveAccount(row);
  const result = emptyRun(accountId, 'pull', dryRun);
  if (account.direction === 'push') {
    result.errors.push('该账户方向为 push，跳过拉取');
    return result;
  }

  let provider: CalendarProvider;
  try {
    provider = makeProvider(account, options);
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      result.errors.push(`出站被拦截：${error.message}`);
      return result;
    }
    throw error;
  }

  let listed: ProviderResult<ExternalCalendarEvent[]>;
  try {
    listed = await provider.listEvents(account);
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      result.errors.push(`出站被拦截：${error.message}`);
      return result;
    }
    if (error instanceof CalendarProviderError) {
      result.errors.push(error.message);
      return result;
    }
    throw error;
  }
  if (!listed.ok) {
    result.unsupported = true;
    result.errors.push(listed.reason);
    return result;
  }

  const mappings = await query(
    'SELECT * FROM calendar_sync_events WHERE account_id = $1 AND calendar_id = $2',
    [accountId, account.calendarId],
  );
  const byUid = new Map<string, SyncMappingRow>();
  for (const mapping of mappings.rows as SyncMappingRow[]) byUid.set(mapping.external_uid, mapping);

  for (const remote of listed.value.slice(0, MAX_EVENTS_PER_RUN)) {
    const existing = byUid.get(remote.uid);
    try {
      if (existing) {
        if (existing.external_version === remote.version) {
          result.skipped++;
          continue;
        }
        if (!dryRun && existing.local_event_id != null) {
          await applyExternalToLocal(userId, existing.local_event_id, remote);
          await upsertMapping(userId, accountId, account.calendarId, remote.uid, {
            localEventId: existing.local_event_id,
            externalVersion: remote.version,
            localVersion: contentHash(remote.name, remote.date, 'other'),
            losingVersion: existing.external_version,
            direction: 'pull',
          });
        }
        result.updated++;
        continue;
      }

      if (dryRun) {
        result.imported++;
        continue;
      }
      const localVersion = contentHash(remote.name, remote.date, 'other');
      const created = await createEvent(String(userId), {
        name: remote.name,
        type: 'other',
        date: remote.date,
        calendarType: 'gregorian',
        reminderConfig: {
          enabled: false,
          daysBeforeList: [],
          emailRecipients: [],
          channels: [],
          accountIds: [],
          importSource: IMPORT_SOURCE,
        },
      });
      const localEventId = Number(created.id);
      await upsertMapping(userId, accountId, account.calendarId, remote.uid, {
        localEventId,
        externalVersion: remote.version,
        localVersion,
        losingVersion: null,
        direction: 'pull',
      });
      byUid.set(remote.uid, { id: 0, account_id: accountId, external_uid: remote.uid, calendar_id: account.calendarId, local_event_id: localEventId, external_version: remote.version, local_version: localVersion, last_synced_at: null });
      result.imported++;
    } catch (error) {
      if (error instanceof EgressBlockedError) {
        result.errors.push(`出站被拦截：${error.message}`);
        break;
      }
      result.errors.push(errText(error));
    }
  }

  if (!dryRun) {
    await query('UPDATE calendar_sync_accounts SET last_synced_at = now(), updated_at = now() WHERE id = $1', [accountId]);
  }
  log.info({ event: 'calendar_sync.pull', userId, accountId, dryRun, imported: result.imported, updated: result.updated, skipped: result.skipped }, 'calendar sync pull complete');
  return result;
}

/** Last-write-wins ordering between a remote write and the common ancestor (last sync). */
export function decideConflictWinner(
  policy: ConflictPolicy,
  remoteUpdatedAt: string | null,
  lastSyncedAt: string | null,
): 'local' | 'remote' {
  if (policy === 'local_wins') return 'local';
  if (policy === 'remote_wins') return 'remote';
  const remoteMs = remoteUpdatedAt ? Date.parse(remoteUpdatedAt) : NaN;
  const syncMs = lastSyncedAt ? Date.parse(lastSyncedAt) : NaN;
  if (Number.isFinite(remoteMs) && Number.isFinite(syncMs)) return remoteMs > syncMs ? 'remote' : 'local';
  if (Number.isFinite(remoteMs)) return 'remote';
  return 'local';
}

/**
 * Push local events to the remote. Conflict policy defaults to last-write-wins;
 * `losing_version` records the discarded side. `dryRun` performs no PUT and no DB
 * write.
 */
export async function pushCalendarSync(
  userId: number,
  accountId: number,
  options: CalendarSyncRunOptions = {},
): Promise<CalendarSyncRunResult> {
  const dryRun = options.dryRun === true;
  const row = await loadAccountRow(userId, accountId);
  const account = resolveAccount(row);
  const result = emptyRun(accountId, 'push', dryRun);
  if (account.direction === 'pull') {
    result.errors.push('该账户方向为 pull，跳过推送');
    return result;
  }

  let provider: CalendarProvider;
  let remotes: Map<string, ExternalCalendarEvent>;
  try {
    provider = makeProvider(account, options);
    const listed = await provider.listEvents(account);
    if (!listed.ok) {
      result.unsupported = true;
      result.errors.push(listed.reason);
      return result;
    }
    remotes = new Map(listed.value.map((event) => [event.uid, event]));
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      result.errors.push(`出站被拦截：${error.message}`);
      return result;
    }
    if (error instanceof CalendarProviderError) {
      result.errors.push(error.message);
      return result;
    }
    throw error;
  }

  const localRows = await query(
    `SELECT id, name, type, date, COALESCE(reminder_config->>'importSource', '') AS import_source
       FROM events WHERE user_id = $1 ORDER BY id ASC LIMIT ${MAX_EVENTS_PER_RUN}`,
    [userId],
  );
  const mappingRows = await query('SELECT * FROM calendar_sync_events WHERE account_id = $1', [accountId]);
  const byLocalId = new Map<number, SyncMappingRow>();
  for (const mapping of mappingRows.rows as SyncMappingRow[]) {
    if (mapping.local_event_id != null) byLocalId.set(Number(mapping.local_event_id), mapping);
  }

  let putUnsupported = false;
  for (const local of localRows.rows as LocalEventRow[]) {
    if (local.import_source === IMPORT_SOURCE) continue; // don't echo external imports
    const dateIso = isoDate(local.date);
    const uid = deriveExternalUid(accountId, local.id);
    const mapping = byLocalId.get(local.id) ?? null;
    const remote = remotes.get(uid) ?? null;
    const localVersion = contentHash(local.name, dateIso, local.type);

    let losingVersion: string | null = null;
    try {
      if (mapping) {
        const externalChanged = remote != null && (remote.version ?? null) !== (mapping.external_version ?? null);
        const localChanged = localVersion !== (mapping.local_version ?? '');
        if (externalChanged && localChanged) {
          result.conflicts++;
          const winner = decideConflictWinner(account.conflictPolicy, remote.updatedAt, toIso(mapping.last_synced_at));
          if (winner === 'remote') {
            losingVersion = localVersion;
            result.losingVersions.push(losingVersion);
            if (!dryRun && mapping.local_event_id != null) {
              await applyExternalToLocal(userId, mapping.local_event_id, remote);
              await upsertMapping(userId, accountId, account.calendarId, uid, {
                localEventId: mapping.local_event_id,
                externalVersion: remote.version,
                localVersion: contentHash(remote.name, remote.date, local.type),
                losingVersion,
                direction: 'push',
              });
            }
            result.updated++;
            continue;
          }
          losingVersion = remote.version;
          result.losingVersions.push(losingVersion ?? '(remote version)');
        } else if (externalChanged && !localChanged) {
          // Remote-only change: adopt it instead of overwriting.
          if (!dryRun && mapping.local_event_id != null) {
            await applyExternalToLocal(userId, mapping.local_event_id, remote);
            await upsertMapping(userId, accountId, account.calendarId, uid, {
              localEventId: mapping.local_event_id,
              externalVersion: remote.version,
              localVersion: contentHash(remote.name, remote.date, local.type),
              losingVersion: null,
              direction: 'push',
            });
          }
          result.updated++;
          continue;
        }
      }

      if (dryRun) {
        result.imported++;
        continue;
      }

      const put = await provider.putEvent(account, {
        uid,
        calendarId: account.calendarId,
        name: local.name,
        date: dateIso,
        version: remote?.version ?? null,
      });
      if (!put.ok) {
        putUnsupported = true;
        result.unsupported = true;
        result.errors.push(put.reason);
        break;
      }
      await upsertMapping(userId, accountId, account.calendarId, uid, {
        localEventId: local.id,
        externalVersion: put.value.version,
        localVersion,
        losingVersion,
        direction: 'push',
      });
      result.imported++;
    } catch (error) {
      if (error instanceof EgressBlockedError) {
        result.errors.push(`出站被拦截：${error.message}`);
        break;
      }
      result.errors.push(errText(error));
    }
  }
  if (putUnsupported) result.unsupported = true;

  if (!dryRun && !result.unsupported) {
    await query('UPDATE calendar_sync_accounts SET last_synced_at = now(), updated_at = now() WHERE id = $1', [accountId]);
  }
  log.info({ event: 'calendar_sync.push', userId, accountId, dryRun, pushed: result.imported, updated: result.updated, conflicts: result.conflicts, unsupported: result.unsupported }, 'calendar sync push complete');
  return result;
}
