import { createHash } from 'crypto';
import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { isSafePublicUrl } from '../../utils/url-safety.js';
import { createEgressGuard, EgressBlockedError } from './egress-guard.service.js';
import { createEvent } from '../event.service.js';

const log = createLogger('feed-ingest');

/** Hard caps (no unbounded buffering anywhere in this module). */
export const MAX_ICS_BYTES = 512 * 1024; // 512 KiB remote ICS response
export const MAX_MAIL_BYTES = 256 * 1024; // 256 KiB raw RFC822 payload
export const MAX_EVENTS_PER_SYNC = 200;
export const MAX_PROPOSALS_PER_SYNC = 200;
export const MAX_RRULE_OCCURRENCES = 24; // "RRULE-limited": expand at most this many
const RRULE_HORIZON_DAYS = 366; // ...and never past ~1 year from DTSTART
const FETCH_TIMEOUT_MS = 15_000;
const MAX_TITLE = 500;
const MAX_NOTES = 2000;

export type FeedSourceKind = 'ics' | 'mail';
export type FeedProposalKind = 'event_new' | 'event_changed' | 'contact_new';
export type FeedProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface FeedSourceRow {
  id: number;
  user_id: number;
  kind: FeedSourceKind;
  name: string;
  url: string | null;
  poll_interval_minutes: number;
  mail_address: string | null;
  enabled: boolean;
  trusted: boolean;
  last_synced_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeedProposalRow {
  id: number;
  user_id: number;
  source_id: number | null;
  source_kind: string;
  kind: FeedProposalKind;
  dedupe_key: string;
  title: string;
  payload: Record<string, unknown>;
  status: FeedProposalStatus;
  created_at: string;
  reviewed_at: string | null;
}

export type FeedIngestErrorCode =
  | 'not_found'
  | 'invalid_kind'
  | 'invalid_url'
  | 'invalid_input'
  | 'unsafe_url'
  | 'egress_blocked'
  | 'redirect_blocked'
  | 'http_error'
  | 'fetch_failed'
  | 'payload_too_large';

export class FeedIngestError extends Error {
  readonly code: FeedIngestErrorCode;
  constructor(code: FeedIngestErrorCode, message: string) {
    super(message);
    this.name = 'FeedIngestError';
    this.code = code;
  }
}

/** HTTP status the route layer should map a given ingest failure to. */
export function statusForFeedError(code: FeedIngestErrorCode): 400 | 403 | 404 | 413 | 502 {
  switch (code) {
    case 'not_found':
      return 404;
    case 'egress_blocked':
    case 'unsafe_url':
    case 'redirect_blocked':
      return 403;
    case 'payload_too_large':
      return 413;
    case 'fetch_failed':
    case 'http_error':
      return 502;
    default:
      return 400;
  }
}

// ---------------------------------------------------------------------------
// ICS parsing (RFC 5545 subset: SUMMARY / DTSTART / DTEND / RRULE-limited)
// ---------------------------------------------------------------------------

export interface ParsedIcsEvent {
  uid: string;
  summary: string;
  /** YYYY-MM-DD (all-day or the date component of a date-time). */
  startDate: string;
  /** HH:MM for date-time events, null for all-day events. */
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  /** Stable per-occurrence token used for the UID+DTSTART dedupe key. */
  startKey: string;
  location: string | null;
  rrule: string | null;
}

interface IcsDateValue {
  date: string;
  time: string | null;
  key: string;
}

interface IcsRrule {
  freq?: string;
  interval: number;
  count?: number;
  untilDate?: string;
  unsupported: boolean;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

/** RFC 5545 line unfolding: a CRLF/LF followed by SP/HTAB continues the value. */
function unfoldIcs(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines: string[] = [];
  for (const raw of normalized.split('\n')) {
    if (lines.length > 0 && /^[ \t]/.test(raw)) {
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }
  return lines;
}

function unescapeIcsText(value: string): string {
  return value.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}

function formatKey(date: string, time: string | null): string {
  const compact = date.replace(/-/g, '');
  return time ? `${compact}T${time.replace(/:/g, '')}00` : compact;
}

function parseIcsDateValue(raw: string | undefined): IcsDateValue | null {
  if (!raw) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = `${year}-${month}-${day}`;
  const time = hour ? `${hour}:${minute}` : null;
  return { date, time, key: formatKey(date, time) };
}

function parseIcsRrule(raw: string | undefined): IcsRrule | null {
  if (!raw) return null;
  const parts = new Map<string, string>();
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=');
    if (eq > 0) parts.set(segment.slice(0, eq).trim().toUpperCase(), segment.slice(eq + 1).trim());
  }
  const freq = parts.get('FREQ')?.toUpperCase();
  const unsupported = ['BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'BYYEARDAY', 'BYWEEKNO', 'WKST'].some((key) =>
    parts.has(key),
  );
  const interval = Number.parseInt(parts.get('INTERVAL') ?? '1', 10) || 1;
  const countRaw = Number.parseInt(parts.get('COUNT') ?? '', 10);
  const until = parts.get('UNTIL');
  const untilDate = parseIcsDateValue(until)?.date;
  return {
    freq,
    interval,
    ...(Number.isInteger(countRaw) && countRaw > 0 ? { count: countRaw } : {}),
    ...(untilDate ? { untilDate } : {}),
    unsupported,
  };
}

function addInterval(base: Date, freq: string, interval: number): Date {
  const next = new Date(base.getTime());
  if (freq === 'DAILY') next.setUTCDate(next.getUTCDate() + interval);
  else if (freq === 'WEEKLY') next.setUTCDate(next.getUTCDate() + 7 * interval);
  else if (freq === 'MONTHLY') next.setUTCMonth(next.getUTCMonth() + interval);
  else if (freq === 'YEARLY') next.setUTCFullYear(next.getUTCFullYear() + interval);
  return next;
}

/**
 * RRULE-limited expansion. Only FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with
 * INTERVAL/COUNT/UNTIL are expanded, and never past MAX_RRULE_OCCURRENCES or
 * ~1 year. Any BY* rule (BYDAY and friends) degrades safely to a single
 * occurrence rather than guessing a calendar the user did not ask for.
 */
function expandRrule(start: IcsDateValue, rrule: IcsRrule): IcsDateValue[] {
  const freq = rrule.freq;
  if (rrule.unsupported || !freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return [];
  const base = new Date(`${start.date}T00:00:00.000Z`);
  const horizon = base.getTime() + RRULE_HORIZON_DAYS * 86_400_000;
  const untilMs = rrule.untilDate ? new Date(`${rrule.untilDate}T23:59:59.999Z`).getTime() : null;
  const limit = rrule.count ? Math.min(rrule.count, MAX_RRULE_OCCURRENCES) : MAX_RRULE_OCCURRENCES;
  const out: IcsDateValue[] = [];
  let cursor = base;
  for (let produced = 1; produced < limit; produced += 1) {
    cursor = addInterval(cursor, freq, rrule.interval);
    if (cursor.getTime() > horizon) break;
    if (untilMs !== null && cursor.getTime() > untilMs) break;
    const date = cursor.toISOString().slice(0, 10);
    out.push({ date, time: start.time, key: formatKey(date, start.time) });
  }
  return out;
}

/**
 * Parse VEVENT blocks into one ParsedIcsEvent per (uid, DTSTART) occurrence.
 * UID is preserved verbatim when present (falls back to a content hash) so the
 * UID+DTSTART dedupe key is stable across re-syncs.
 */
export function parseIcsFeedEvents(icsText: string, maxEvents = MAX_EVENTS_PER_SYNC): ParsedIcsEvent[] {
  const lines = unfoldIcs(icsText);
  const out: ParsedIcsEvent[] = [];
  let current: Map<string, string> | null = null;

  const flush = (props: Map<string, string>): void => {
    const summary = unescapeIcsText(props.get('SUMMARY') ?? '').slice(0, MAX_TITLE) || '(无标题)';
    const start = parseIcsDateValue(props.get('DTSTART'));
    if (!start) return;
    const end = parseIcsDateValue(props.get('DTEND'));
    const location = props.has('LOCATION') ? unescapeIcsText(props.get('LOCATION') ?? '').slice(0, 300) : null;
    const rruleRaw = props.get('RRULE') ?? null;
    let uid = (props.get('UID') ?? '').trim();
    if (!uid) uid = `hash-${sha1(`${summary}|${start.key}`)}`;
    const base: ParsedIcsEvent = {
      uid,
      summary,
      startDate: start.date,
      startTime: start.time,
      endDate: end?.date ?? null,
      endTime: end?.time ?? null,
      startKey: start.key,
      location,
      rrule: rruleRaw,
    };
    out.push(base);
    const rrule = parseIcsRrule(rruleRaw ?? undefined);
    if (rrule) {
      for (const occurrence of expandRrule(start, rrule)) {
        out.push({ ...base, startDate: occurrence.date, startTime: occurrence.time, endDate: null, endTime: null, startKey: occurrence.key });
      }
    }
  };

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VEVENT' || upper.startsWith('BEGIN:VEVENT;')) {
      current = new Map<string, string>();
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) flush(current);
      current = null;
      if (out.length >= maxEvents) break;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(';')[0].trim().toUpperCase();
    const value = line.slice(colon + 1);
    if (!current.has(name)) current.set(name, value);
  }
  return out.slice(0, maxEvents);
}

export function icsDedupeKey(uid: string, startKey: string): string {
  return `${uid}|${startKey}`;
}

// ---------------------------------------------------------------------------
// RFC822 inbound mail contract
// ---------------------------------------------------------------------------

export interface ParsedMail {
  headers: Record<string, string>;
  body: string;
}

export interface MailCandidate {
  kind: 'event' | 'contact';
  dedupeKey: string;
  title: string;
  payload: Record<string, unknown>;
}

export interface IngestCandidateSet {
  messageId: string | null;
  candidates: MailCandidate[];
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodeTransfer(body: string, encoding: string | undefined): string {
  const normalized = (encoding ?? '').trim().toLowerCase();
  if (normalized === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  if (normalized === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function extractMultipartText(body: string, contentType: string): string {
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);
  if (!boundaryMatch) return body;
  const boundary = `--${boundaryMatch[1]}`;
  for (const part of body.split(boundary)) {
    const sep = part.search(/\r?\n\r?\n/);
    if (sep < 0) continue;
    const rawHead = part.slice(0, sep);
    if (/content-type:\s*multipart/i.test(rawHead)) continue;
    if (!/content-type:\s*text\/plain/i.test(rawHead)) continue;
    const encoding = /content-transfer-encoding:\s*(\S+)/i.exec(rawHead)?.[1];
    const payload = part.slice(sep).replace(/^\r?\n\r?\n/, '').replace(/\r?\n--\s*$/, '');
    return decodeTransfer(payload, encoding);
  }
  return body;
}

/**
 * Mail-ingest contract: parse a raw RFC822 payload into headers + decoded body.
 * Handles folded headers, quoted-printable/base64 transfer encodings, and the
 * first text/plain part of a multipart body. Never executes anything.
 */
export function parseRfc822(raw: string): ParsedMail {
  const normalized = raw.replace(/\r\n/g, '\n');
  const sep = normalized.indexOf('\n\n');
  const head = sep >= 0 ? normalized.slice(0, sep) : normalized;
  let body = sep >= 0 ? normalized.slice(sep + 2) : '';
  const unfolded = head.replace(/\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  body = decodeTransfer(body, headers['content-transfer-encoding']);
  if ((headers['content-type'] ?? '').toLowerCase().startsWith('multipart/')) {
    body = extractMultipartText(body, headers['content-type'] ?? '');
  }
  return { headers, body };
}

interface LooseDate {
  date: string;
  time: string | null;
}

function parseLooseDate(raw: string): LooseDate | null {
  const compact = /^(\d{4})(\d{2})(\d{2})(?:[T ]?(\d{2})(\d{2}))?/.exec(raw.trim());
  if (compact) {
    const [, y, m, d, hh, mm] = compact;
    return { date: `${y}-${m}-${d}`, time: hh ? `${hh}:${mm}` : null };
  }
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(raw.trim());
  if (iso) return { date: iso[1], time: iso[2] ?? null };
  const slash = /^(\d{4})\/(\d{2})\/(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(raw.trim());
  if (slash) return { date: `${slash[1]}-${slash[2]}-${slash[3]}`, time: slash[4] ?? null };
  return null;
}

function parseStructuredEventBlock(block: string): { title: string; date: string; time: string | null; endDate: string | null; location: string | null } | null {
  const fields: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const start = parseLooseDate(fields.start ?? fields.begin ?? fields.date ?? '');
  if (!start) return null;
  const end = parseLooseDate(fields.end ?? '');
  return {
    title: (fields.title ?? fields.summary ?? fields.subject ?? '').slice(0, MAX_TITLE),
    date: start.date,
    time: start.time,
    endDate: end?.date ?? null,
    location: fields.location ? fields.location.slice(0, 300) : null,
  };
}

/**
 * Extract candidate events + contacts from a parsed mail. Two event shapes are
 * recognised (documented contract):
 *   1. explicit `@@EVENT ... lines ... @@END` blocks with title/start/end/location;
 *   2. fallback: any ISO `YYYY-MM-DD[ HH:MM]` date in the body becomes an event
 *      titled with the mail subject.
 * Contacts come from `Name <email>` pairs in From/To and the body, plus any
 * `BEGIN:VCARD` blocks (FN / EMAIL / TEL).
 */
export function extractMailCandidates(mail: ParsedMail): IngestCandidateSet {
  const messageId = (mail.headers['message-id'] ?? '').trim() || `msg-${sha1(`${mail.headers.subject ?? ''}|${mail.body}`)}`;
  const subject = (mail.headers.subject ?? '').trim().slice(0, MAX_TITLE) || '(无主题邮件)';
  const candidates: MailCandidate[] = [];
  let index = 0;

  for (const match of mail.body.matchAll(/@@EVENT([\s\S]*?)@@END/gi)) {
    const parsed = parseStructuredEventBlock(match[1]);
    if (!parsed) continue;
    const title = parsed.title || subject;
    candidates.push({
      kind: 'event',
      dedupeKey: `${messageId}#e${index}`,
      title,
      payload: {
        uid: `${messageId}#e${index}`,
        summary: title,
        date: parsed.date,
        time: parsed.time,
        endDate: parsed.endDate,
        location: parsed.location,
        source: 'mail_block',
      },
    });
    index += 1;
  }

  if (candidates.length === 0) {
    let dateIndex = 0;
    for (const match of mail.body.matchAll(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/g)) {
      candidates.push({
        kind: 'event',
        dedupeKey: `${messageId}#e${index}`,
        title: subject,
        payload: {
          uid: `${messageId}#d${dateIndex}`,
          summary: subject,
          date: match[1],
          time: match[2] ?? null,
          endDate: null,
          location: null,
          source: 'mail_date',
        },
      });
      index += 1;
      dateIndex += 1;
    }
  }

  const vcardContacts: MailCandidate[] = [];
  for (const match of mail.body.matchAll(/BEGIN:VCARD([\s\S]*?)END:VCARD/gi)) {
    const block = match[1];
    const fn = /^FN[^:]*:(.+)$/im.exec(block)?.[1]?.trim();
    const email = /^EMAIL[^:]*:(.+)$/im.exec(block)?.[1]?.trim();
    const tel = /^TEL[^:]*:(.+)$/im.exec(block)?.[1]?.trim();
    if (!fn && !email && !tel) continue;
    vcardContacts.push({
      kind: 'contact',
      dedupeKey: `${messageId}#v${vcardContacts.length}`,
      title: fn || email || '未命名联系人',
      payload: { name: fn || null, email: email || null, phone: tel || null, notes: '由邮件 vCard 导入', source: 'mail_vcard' },
    });
  }

  const addressContacts: MailCandidate[] = [];
  if (vcardContacts.length === 0) {
    const sources = [mail.headers.from ?? '', mail.headers.to ?? '', mail.body].join('\n');
    const seen = new Set<string>();
    for (const match of sources.matchAll(/"?(?<name>[^"<,;\n]+?)"?\s*<(?<email>[^>\s]+@[^>\s]+)>/g)) {
      const email = (match.groups?.email ?? '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      const name = (match.groups?.name ?? '').trim();
      addressContacts.push({
        kind: 'contact',
        dedupeKey: `${messageId}#c${addressContacts.length}`,
        title: name || email,
        payload: { name: name || null, email, phone: null, notes: '由邮件地址导入', source: 'mail_address' },
      });
      if (addressContacts.length >= 20) break;
    }
  }

  return { messageId, candidates: [...candidates, ...vcardContacts, ...addressContacts] };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const stream = res.body;
  if (!stream) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new FeedIngestError('payload_too_large', `响应体超过 ${maxBytes} 字节上限`);
    }
    return text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FeedIngestError('payload_too_large', `响应体超过 ${maxBytes} 字节上限`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

export async function listFeedSources(userId: number): Promise<FeedSourceRow[]> {
  const result = await query(
    `SELECT * FROM feed_sources WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return result.rows as FeedSourceRow[];
}

export async function getFeedSource(userId: number, id: number): Promise<FeedSourceRow | null> {
  const result = await query(`SELECT * FROM feed_sources WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (result.rows[0] as FeedSourceRow | undefined) ?? null;
}

export async function createFeedSource(
  userId: number,
  input: { kind: FeedSourceKind; name: string; url?: string | null; pollIntervalMinutes?: number; mailAddress?: string | null; enabled?: boolean; trusted?: boolean },
): Promise<FeedSourceRow> {
  const result = await query(
    `INSERT INTO feed_sources (user_id, kind, name, url, poll_interval_minutes, mail_address, enabled, trusted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      userId,
      input.kind,
      input.name.slice(0, 120),
      input.url ?? null,
      input.pollIntervalMinutes ?? 360,
      input.mailAddress ?? null,
      input.enabled ?? true,
      input.trusted ?? false,
    ],
  );
  return result.rows[0] as FeedSourceRow;
}

export async function updateFeedSource(
  userId: number,
  id: number,
  patch: { name?: string; url?: string | null; pollIntervalMinutes?: number; mailAddress?: string | null; enabled?: boolean; trusted?: boolean },
): Promise<FeedSourceRow | null> {
  const result = await query(
    `UPDATE feed_sources SET
       name = COALESCE($3, name),
       url = COALESCE($4, url),
       poll_interval_minutes = COALESCE($5, poll_interval_minutes),
       mail_address = COALESCE($6, mail_address),
       enabled = COALESCE($7, enabled),
       trusted = COALESCE($8, trusted),
       updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [
      id,
      userId,
      patch.name === undefined ? null : patch.name.slice(0, 120),
      patch.url === undefined ? null : patch.url,
      patch.pollIntervalMinutes === undefined ? null : patch.pollIntervalMinutes,
      patch.mailAddress === undefined ? null : patch.mailAddress,
      patch.enabled === undefined ? null : patch.enabled,
      patch.trusted === undefined ? null : patch.trusted,
    ],
  );
  return (result.rows[0] as FeedSourceRow | undefined) ?? null;
}

export async function deleteFeedSource(userId: number, id: number): Promise<boolean> {
  const result = await query(`DELETE FROM feed_sources WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

export async function listProposals(
  userId: number,
  options: { status?: FeedProposalStatus; limit?: number } = {},
): Promise<FeedProposalRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  if (options.status) {
    const result = await query(
      `SELECT * FROM feed_ingest_proposals WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC, id DESC LIMIT $3`,
      [userId, options.status, limit],
    );
    return result.rows as FeedProposalRow[];
  }
  const result = await query(
    `SELECT * FROM feed_ingest_proposals WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [userId, limit],
  );
  return result.rows as FeedProposalRow[];
}

async function markSourceResult(sourceId: number, status: string, error: string | null): Promise<void> {
  await query(
    `UPDATE feed_sources SET last_synced_at = now(), last_status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
    [sourceId, status, error],
  ).catch(() => undefined);
}

async function seenExists(sourceId: number, dedupeKey: string): Promise<boolean> {
  const result = await query(`SELECT 1 FROM feed_ingest_seen WHERE source_id = $1 AND dedupe_key = $2 LIMIT 1`, [sourceId, dedupeKey]);
  return result.rows.length > 0;
}

async function priorSeenForUid(sourceId: number, uid: string): Promise<{ uid: string; dtstart_key: string | null; title: string } | null> {
  const result = await query(
    `SELECT uid, dtstart_key, title FROM feed_ingest_seen WHERE source_id = $1 AND uid = $2 LIMIT 1`,
    [sourceId, uid],
  );
  return (result.rows[0] as { uid: string; dtstart_key: string | null; title: string } | undefined) ?? null;
}

async function markSeen(
  userId: number,
  sourceId: number,
  sourceKind: string,
  dedupeKey: string,
  uid: string | null,
  dtstartKey: string | null,
  title: string,
): Promise<void> {
  await query(
    `INSERT INTO feed_ingest_seen (user_id, source_id, source_kind, dedupe_key, uid, dtstart_key, title)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_id, dedupe_key) DO UPDATE SET last_seen_at = now(), title = EXCLUDED.title`,
    [userId, sourceId, sourceKind, dedupeKey, uid, dtstartKey, title.slice(0, MAX_TITLE)],
  );
}

async function proposeIngest(
  userId: number,
  source: FeedSourceRow,
  kind: FeedProposalKind,
  dedupeKey: string,
  title: string,
  payload: Record<string, unknown>,
): Promise<number | null> {
  const result = await query(
    `INSERT INTO feed_ingest_proposals (user_id, source_id, source_kind, kind, dedupe_key, title, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (user_id, source_kind, dedupe_key) DO NOTHING RETURNING id`,
    [userId, source.id, source.kind, kind, dedupeKey, title.slice(0, MAX_TITLE), JSON.stringify(payload)],
  );
  const id = result.rows[0]?.id;
  return id === undefined ? null : Number(id);
}

async function applyProposalRow(userId: number, row: FeedProposalRow): Promise<void> {
  if (row.kind === 'contact_new') {
    const payload = row.payload as { name?: unknown; email?: unknown; phone?: unknown; notes?: unknown };
    const name = String(payload.name ?? '').trim() || String(row.title ?? '').trim() || '未命名联系人';
    await query(
      `INSERT INTO fixed_contacts (user_id, name, email, phone, notes) VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        name.slice(0, 200),
        payload.email ? String(payload.email).slice(0, 320) : null,
        payload.phone ? String(payload.phone).slice(0, 64) : null,
        payload.notes ? String(payload.notes).slice(0, MAX_NOTES) : null,
      ],
    );
    return;
  }

  const payload = row.payload as { date?: unknown; summary?: unknown };
  const date = String(payload.date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new FeedIngestError('invalid_input', '提议中的事件日期无效');
  }
  const name = String(payload.summary ?? row.title ?? '').trim().slice(0, MAX_TITLE) || '导入事件';
  await createEvent(String(userId), {
    name,
    type: 'other',
    date,
    calendarType: 'gregorian',
    reminderConfig: {
      enabled: false,
      daysBeforeList: [],
      emailRecipients: [],
      channels: [],
      accountIds: [],
      importSource: `feed:${row.source_id ?? 'unknown'}`,
    },
  });
}

/** Atomic pending->accepted claim, then apply. Reverts the claim if apply throws. */
async function claimAndApply(userId: number, proposalId: number): Promise<boolean> {
  const claim = await query(
    `UPDATE feed_ingest_proposals SET status = 'accepted', reviewed_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING *`,
    [proposalId, userId],
  );
  const row = claim.rows[0] as FeedProposalRow | undefined;
  if (!row) return false;
  try {
    await applyProposalRow(userId, row);
  } catch (error) {
    await query(
      `UPDATE feed_ingest_proposals SET status = 'pending', reviewed_at = NULL WHERE id = $1 AND user_id = $2`,
      [proposalId, userId],
    ).catch(() => undefined);
    throw error;
  }
  return true;
}

export type ProposalDecision = { ok: true; applied: boolean } | { ok: false; reason: 'not_found' | 'already_decided' };

export async function acceptProposal(userId: number, proposalId: number): Promise<ProposalDecision> {
  if (await claimAndApply(userId, proposalId)) return { ok: true, applied: true };
  const existing = await query(`SELECT 1 FROM feed_ingest_proposals WHERE id = $1 AND user_id = $2 LIMIT 1`, [proposalId, userId]);
  return existing.rows.length > 0 ? { ok: false, reason: 'already_decided' } : { ok: false, reason: 'not_found' };
}

export async function rejectProposal(userId: number, proposalId: number): Promise<ProposalDecision> {
  const result = await query(
    `UPDATE feed_ingest_proposals SET status = 'rejected', reviewed_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING 1`,
    [proposalId, userId],
  );
  if (result.rows.length > 0) return { ok: true, applied: false };
  const existing = await query(`SELECT 1 FROM feed_ingest_proposals WHERE id = $1 AND user_id = $2 LIMIT 1`, [proposalId, userId]);
  return existing.rows.length > 0 ? { ok: false, reason: 'already_decided' } : { ok: false, reason: 'not_found' };
}

// ---------------------------------------------------------------------------
// Sync / ingest entry points
// ---------------------------------------------------------------------------

export interface SyncResult {
  fetched: number;
  proposed: number;
  changed: number;
  applied: number;
  skipped: number;
}

/**
 * Poll one ICS source on demand and reconcile it against the UID+DTSTART dedupe
 * memory. The outbound fetch goes through the shared egress guard, so the ICS
 * host must be allowlisted (EGRESS_ALLOWED_HOSTS) or the call is blocked.
 */
export async function syncIcsSource(
  userId: number,
  sourceId: number,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SyncResult> {
  const source = await getFeedSource(userId, sourceId);
  if (!source) throw new FeedIngestError('not_found', '订阅源不存在');
  if (source.kind !== 'ics') throw new FeedIngestError('invalid_kind', '该订阅源不是 ICS 类型');
  if (!source.enabled) throw new FeedIngestError('invalid_input', '订阅源已停用');
  const url = (source.url ?? '').replace(/^webcal:\/\//i, 'https://').trim();
  if (!url) throw new FeedIngestError('invalid_url', '订阅源未配置 URL');
  const safe = await isSafePublicUrl(url);
  if (!safe.safe) {
    await markSourceResult(source.id, 'blocked', safe.reason ?? 'URL 不安全');
    throw new FeedIngestError('unsafe_url', safe.reason ?? 'URL 不安全');
  }

  let events: ParsedIcsEvent[];
  try {
    const guard = createEgressGuard(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
    const res = await guard.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'text/calendar' },
    });
    if (res.status >= 300 && res.status < 400) throw new FeedIngestError('redirect_blocked', '外部日历不允许重定向');
    if (!res.ok) throw new FeedIngestError('http_error', `HTTP ${res.status}`);
    const text = await readTextCapped(res, MAX_ICS_BYTES);
    events = parseIcsFeedEvents(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markSourceResult(source.id, 'error', message.slice(0, 500));
    if (error instanceof FeedIngestError) throw error;
    if (error instanceof EgressBlockedError) throw new FeedIngestError('egress_blocked', `出站被拦截：${message}`);
    throw new FeedIngestError('fetch_failed', message);
  }

  const result: SyncResult = { fetched: events.length, proposed: 0, changed: 0, applied: 0, skipped: 0 };
  for (const event of events) {
    if (result.proposed + result.applied >= MAX_PROPOSALS_PER_SYNC) break;
    const dedupeKey = icsDedupeKey(event.uid, event.startKey);
    if (await seenExists(source.id, dedupeKey)) {
      result.skipped += 1;
      continue;
    }
    const prior = await priorSeenForUid(source.id, event.uid);
    const changed = prior !== null;
    const kind: FeedProposalKind = changed ? 'event_changed' : 'event_new';
    const payload: Record<string, unknown> = {
      uid: event.uid,
      summary: event.summary,
      date: event.startDate,
      time: event.startTime,
      endDate: event.endDate,
      location: event.location,
      rrule: event.rrule,
      previous: changed ? { dtstart: prior?.dtstart_key, title: prior?.title } : null,
    };
    const proposalId = await proposeIngest(userId, source, kind, dedupeKey, event.summary, payload);
    await markSeen(userId, source.id, 'ics', dedupeKey, event.uid, event.startKey, event.summary);
    if (proposalId === null) {
      result.skipped += 1;
      continue;
    }
    if (changed) result.changed += 1;
    else result.proposed += 1;
    if (source.trusted && (await claimAndApply(userId, proposalId))) result.applied += 1;
  }

  await markSourceResult(source.id, 'ok', null);
  log.info(
    { event: 'feed.ics_sync', sourceId: source.id, fetched: result.fetched, proposed: result.proposed, changed: result.changed, applied: result.applied },
    'ICS feed synced',
  );
  return result;
}

async function ensureMailSource(userId: number): Promise<FeedSourceRow> {
  const existing = await query(
    `SELECT * FROM feed_sources WHERE user_id = $1 AND kind = 'mail' ORDER BY id ASC LIMIT 1`,
    [userId],
  );
  const row = existing.rows[0] as FeedSourceRow | undefined;
  if (row) return row;
  return createFeedSource(userId, { kind: 'mail', name: '入站邮件', trusted: false });
}

export interface MailIngestResult {
  messageId: string | null;
  candidates: number;
  proposed: number;
  applied: number;
  skipped: number;
}

/**
 * Ingest one raw RFC822 payload. Returns only after dedupe; untrusted sources
 * produce pending proposals (never silent writes), trusted sources apply them.
 */
export async function ingestRawMail(
  userId: number,
  raw: string,
  options: { sourceId?: number; trusted?: boolean } = {},
): Promise<MailIngestResult> {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MAIL_BYTES) {
    throw new FeedIngestError('payload_too_large', `邮件体超过 ${MAX_MAIL_BYTES} 字节上限`);
  }
  const parsed = parseRfc822(raw);
  const source = options.sourceId ? await getFeedSource(userId, options.sourceId) : await ensureMailSource(userId);
  if (!source) throw new FeedIngestError('not_found', '邮件接收源不存在');
  if (source.kind !== 'mail') throw new FeedIngestError('invalid_kind', '该订阅源不是邮件类型');
  const trusted = options.trusted ?? source.trusted;
  const { messageId, candidates } = extractMailCandidates(parsed);

  const result: MailIngestResult = { messageId, candidates: candidates.length, proposed: 0, applied: 0, skipped: 0 };
  for (const candidate of candidates) {
    if (result.proposed + result.applied >= MAX_PROPOSALS_PER_SYNC) break;
    if (await seenExists(source.id, candidate.dedupeKey)) {
      result.skipped += 1;
      continue;
    }
    const kind: FeedProposalKind = candidate.kind === 'event' ? 'event_new' : 'contact_new';
    const proposalId = await proposeIngest(userId, source, kind, candidate.dedupeKey, candidate.title, candidate.payload);
    await markSeen(userId, source.id, 'mail', candidate.dedupeKey, candidate.kind === 'event' ? candidate.dedupeKey : null, null, candidate.title);
    if (proposalId === null) {
      result.skipped += 1;
      continue;
    }
    result.proposed += 1;
    if (trusted && (await claimAndApply(userId, proposalId))) result.applied += 1;
  }

  log.info(
    { event: 'feed.mail_ingest', sourceId: source.id, candidates: result.candidates, proposed: result.proposed, applied: result.applied },
    'Inbound mail ingested',
  );
  return result;
}
