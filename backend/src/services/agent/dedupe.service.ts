import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { proposeDecision, type ProposeDecisionResult } from './decision-card.service.js';

/**
 * Task 135 — duplicate detection + merge PROPOSAL, never a silent merge.
 *
 * Two scanners return a ranked candidate list where every candidate carries a
 * similarity score in [0,1] and the machine-readable reasons behind it:
 *
 *   findSimilarEvents()    same / near-duplicate title, same date or the same
 *                          month-day across years (the classic twice-entered
 *                          birthday), close dates, same type / person.
 *   findSimilarContacts()  same / near-duplicate name, identical normalised
 *                          phone digits (or a shared >=7-digit tail), identical
 *                          email, identical telegram/qq/wxpusher handle.
 *
 * Nothing here deletes anything. A contact duplicate can be escalated with
 * `proposeContactMerge()`, which opens a task-126 decision card
 * (subject_kind='merge_contacts', Approve/Edit/Reject). The shipped resolver in
 * decision-card.service.ts performs the merge only after approval — and task
 * 142's audit service records the pre-merge rows so the merge can be undone.
 * Events have no merge resolver yet, so event candidates are surface-only.
 */

const log = createLogger('agent.dedupe');

export const DEDUPE_EVENT_MIN_SCORE_DEFAULT = 0.55;
export const DEDUPE_CONTACT_MIN_SCORE_DEFAULT = 0.3;
export const DEDUPE_LIST_DEFAULT_LIMIT = 50;
export const DEDUPE_LIST_MAX_LIMIT = 200;
export const DEDUPE_DATE_WINDOW_ENV = 'DEDUPE_DATE_WINDOW_DAYS';
export const DEDUPE_DATE_WINDOW_DEFAULT_DAYS = 3;

const EVENT_SCAN_CAP = 400;
const CONTACT_SCAN_CAP = 500;

/** Date window (days) used for the "close dates" event signal. */
export function readDedupeDateWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt((env[DEDUPE_DATE_WINDOW_ENV] ?? '').trim(), 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 0), 30) : DEDUPE_DATE_WINDOW_DEFAULT_DAYS;
}

// ---------------------------------------------------------------------------
// Text / digit normalisation + similarity
// ---------------------------------------------------------------------------

/** NFKC, lowercase, punctuation/symbols/whitespace removed. */
export function normalizeTitle(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Digits only; a +86 country prefix on 11+ digit numbers is dropped. */
export function normalizeDigits(input: string): string {
  const digits = input.normalize('NFKC').replace(/\D+/g, '');
  if (digits.length > 11 && digits.startsWith('86')) return digits.slice(2);
  return digits;
}

export type PhoneMatch = 'exact' | 'tail' | null;

/** `exact` = identical digit strings, `tail` = shared last >=7 digits. */
export function phonesMatch(a: string, b: string): PhoneMatch {
  const left = normalizeDigits(a);
  const right = normalizeDigits(b);
  if (left.length < 5 || right.length < 5) return null;
  if (left === right) return 'exact';
  const tail = Math.min(7, left.length, right.length);
  if (tail >= 7 && left.slice(-tail) === right.slice(-tail)) return 'tail';
  return null;
}

function bigramCounts(normalized: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const gram = normalized.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function diceFromCounts(a: Map<string, number>, b: Map<string, number>): number {
  let overlap = 0;
  let total = 0;
  for (const [gram, count] of a) {
    total += count;
    overlap += Math.min(count, b.get(gram) ?? 0);
  }
  for (const count of b.values()) total += count;
  return total === 0 ? 0 : (2 * overlap) / total;
}

/** Sørensen–Dice bigram similarity of two raw strings in [0,1]. */
export function bigramDice(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (left === '' || right === '') return 0;
  if (left === right) return 1;
  return diceFromCounts(bigramCounts(left), bigramCounts(right));
}

interface TitleInfo {
  normalized: string;
  grams: Map<string, number>;
}

function prepareTitle(raw: string): TitleInfo {
  const normalized = normalizeTitle(raw);
  return { normalized, grams: bigramCounts(normalized) };
}

/** 1 = same title, 0.85 = one contains the other, else bigram Dice. */
function titleScore(a: TitleInfo, b: TitleInfo): number {
  if (a.normalized === '' || b.normalized === '') return 0;
  if (a.normalized === b.normalized) return 1;
  if (
    a.normalized.length >= 4 &&
    b.normalized.length >= 4 &&
    (a.normalized.includes(b.normalized) || b.normalized.includes(a.normalized))
  ) {
    return 0.85;
  }
  return diceFromCounts(a.grams, b.grams);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function readLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return DEDUPE_LIST_DEFAULT_LIMIT;
  return Math.min(Math.trunc(limit as number), DEDUPE_LIST_MAX_LIMIT);
}

function readMinScore(minScore: number | undefined, fallback: number): number {
  if (!Number.isFinite(minScore)) return fallback;
  return clamp01(minScore as number);
}

// ---------------------------------------------------------------------------
// Candidate model
// ---------------------------------------------------------------------------

export interface DedupeEntityRef {
  id: number;
  label: string;
  detail?: string;
}

export type DedupeSuggestedAction =
  | { type: 'review'; hint: string }
  | {
      type: 'propose_merge';
      subjectKind: 'merge_contacts';
      payload: { keepContactId: number; mergeContactId: number };
    };

export interface DedupeCandidate {
  kind: 'event' | 'contact';
  score: number;
  reasons: string[];
  summary: string;
  entities: [DedupeEntityRef, DedupeEntityRef];
  suggestedAction: DedupeSuggestedAction;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

interface EventDedupeRow {
  id: number;
  name: string;
  type: string | null;
  calendarType: string | null;
  ymd: string | null;
  epochDay: number | null;
  monthDay: string | null;
  personName: string | null;
  title: TitleInfo;
}

function toYmd(value: unknown): string | null {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function toEpochDay(ymd: string | null): number | null {
  if (ymd === null) return null;
  const parsed = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : Math.round(parsed / 86_400_000);
}

function mapEventRow(row: Record<string, unknown>): EventDedupeRow {
  const ymd = toYmd(row.date);
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    type: row.type == null ? null : String(row.type),
    calendarType: row.calendar_type == null ? null : String(row.calendar_type),
    ymd,
    epochDay: toEpochDay(ymd),
    monthDay: ymd === null ? null : ymd.slice(5),
    personName: row.person_name == null ? null : String(row.person_name),
    title: prepareTitle(String(row.name ?? '')),
  };
}

interface PairScore {
  score: number;
  reasons: string[];
}

function scoreEventPair(a: EventDedupeRow, b: EventDedupeRow, windowDays: number): PairScore {
  const reasons: string[] = [];
  let score = 0;

  const title = titleScore(a.title, b.title);
  if (title >= 0.999) {
    score += 0.45;
    reasons.push('same_title');
  } else if (title >= 0.8) {
    score += 0.35;
    reasons.push('near_duplicate_title');
  } else if (title >= 0.6) {
    score += 0.2;
    reasons.push('similar_title');
  }

  if (a.ymd !== null && b.ymd !== null) {
    if (a.ymd === b.ymd) {
      score += 0.35;
      reasons.push('same_date');
    } else if (a.monthDay === b.monthDay) {
      score += 0.3;
      reasons.push('same_month_day');
    } else if (a.epochDay !== null && b.epochDay !== null && Math.abs(a.epochDay - b.epochDay) <= windowDays) {
      score += 0.15;
      reasons.push(`date_within_${windowDays}_days`);
    }
  }

  if (a.type !== null && a.type === b.type) {
    score += 0.1;
    reasons.push('same_type');
  }
  if (a.personName && b.personName) {
    const person = titleScore(prepareTitle(a.personName), prepareTitle(b.personName));
    if (person >= 0.999) {
      score += 0.1;
      reasons.push('same_person');
    }
  }

  return { score: round2(clamp01(score)), reasons };
}

export interface EventDedupeOptions {
  limit?: number;
  minScore?: number;
}

/** Ranked duplicate-event candidates for the user; nothing is mutated. */
export async function findSimilarEvents(
  userId: number,
  options: EventDedupeOptions = {},
): Promise<DedupeCandidate[]> {
  const limit = readLimit(options.limit);
  const minScore = readMinScore(options.minScore, DEDUPE_EVENT_MIN_SCORE_DEFAULT);
  const windowDays = readDedupeDateWindowDays();
  const result = await query(
    `SELECT id, name, type, date, calendar_type, person_name
       FROM events
      WHERE user_id = $1
      ORDER BY id ASC
      LIMIT $2`,
    [userId, EVENT_SCAN_CAP],
  );
  const rows = result.rows.map((row) => mapEventRow(row as Record<string, unknown>));

  const candidates: DedupeCandidate[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      const scored = scoreEventPair(a, b, windowDays);
      if (scored.score < minScore || scored.reasons.length === 0) continue;
      candidates.push({
        kind: 'event',
        score: scored.score,
        reasons: scored.reasons,
        summary: `事件「${a.name}」与「${b.name}」可能重复`,
        entities: [
          { id: a.id, label: a.name, detail: `${a.ymd ?? '—'}${a.type ? ` · ${a.type}` : ''}` },
          { id: b.id, label: b.name, detail: `${b.ymd ?? '—'}${b.type ? ` · ${b.type}` : ''}` },
        ],
        suggestedAction: {
          type: 'review',
          hint: '重复事件需要人工确认；系统不会自动删除或合并',
        },
      });
    }
  }

  log.info({ userId, scanned: rows.length, candidates: candidates.length }, 'event dedupe scan complete');
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

interface ContactMethodEntry {
  label?: string;
  value: string;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** contact_methods JSONB -> { emails:[{value}], phones:[...], ... } */
export function parseContactMethods(raw: unknown): Record<string, ContactMethodEntry[]> {
  const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, ContactMethodEntry[]> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const entries: ContactMethodEntry[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed !== '') entries.push({ value: trimmed });
        continue;
      }
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        const text = typeof record.value === 'string' ? record.value.trim() : '';
        if (text === '') continue;
        entries.push(typeof record.label === 'string' ? { label: record.label, value: text } : { value: text });
      }
    }
    if (entries.length > 0) out[key] = entries;
  }
  return out;
}

interface ContactDedupeRow {
  id: number;
  name: string;
  title: TitleInfo;
  emails: string[];
  phones: string[];
  handles: string[];
  channelCount: number;
}

const HANDLE_SOURCES: ReadonlyArray<{ kind: string; legacy: string; method: string }> = [
  { kind: 'telegram', legacy: 'telegram_chat_id', method: 'telegrams' },
  { kind: 'qq', legacy: 'qq', method: 'qqs' },
  { kind: 'wxpusher', legacy: 'wxpusher_uid', method: 'wxpusherUids' },
];

function mapContactRow(row: Record<string, unknown>): ContactDedupeRow {
  const methods = parseContactMethods(row.contact_methods);
  const emails = new Set<string>();
  const phones: string[] = [];
  const handles = new Set<string>();

  const addEmail = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim().toLowerCase();
    if (trimmed !== '') emails.add(trimmed);
  };
  const addPhone = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed !== '') phones.push(trimmed);
  };
  const addHandle = (kind: string, value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim().toLowerCase();
    if (trimmed !== '') handles.add(`${kind}:${trimmed}`);
  };

  addEmail(row.email);
  addPhone(row.phone);
  for (const entry of methods.emails ?? []) addEmail(entry.value);
  for (const entry of methods.phones ?? []) addPhone(entry.value);
  for (const source of HANDLE_SOURCES) {
    addHandle(source.kind, row[source.legacy]);
    for (const entry of methods[source.method] ?? []) addHandle(source.kind, entry.value);
  }

  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    title: prepareTitle(String(row.name ?? '')),
    emails: [...emails],
    phones,
    handles: [...handles],
    channelCount: emails.size + phones.length + handles.size,
  };
}

function scoreContactPair(a: ContactDedupeRow, b: ContactDedupeRow): PairScore {
  const reasons: string[] = [];
  let score = 0;

  const name = titleScore(a.title, b.title);
  if (name >= 0.999) {
    score += 0.35;
    reasons.push('same_name');
  } else if (name >= 0.8) {
    score += 0.28;
    reasons.push('near_duplicate_name');
  } else if (name >= 0.6) {
    score += 0.18;
    reasons.push('similar_name');
  }

  let phoneMatch: PhoneMatch = null;
  outer: for (const left of a.phones) {
    for (const right of b.phones) {
      const match = phonesMatch(left, right);
      if (match === 'exact') {
        phoneMatch = 'exact';
        break outer;
      }
      if (match === 'tail') phoneMatch = 'tail';
    }
  }
  if (phoneMatch === 'exact') {
    score += 0.4;
    reasons.push('same_phone');
  } else if (phoneMatch === 'tail') {
    score += 0.25;
    reasons.push('phone_tail_match');
  }

  const emailOverlap = a.emails.find((email) => b.emails.includes(email));
  if (emailOverlap !== undefined) {
    score += 0.3;
    reasons.push('same_email');
  }

  const handleOverlap = a.handles.find((handle) => b.handles.includes(handle));
  if (handleOverlap !== undefined) {
    score += 0.15;
    reasons.push(`same_${handleOverlap.split(':')[0]}`);
  }

  return { score: round2(clamp01(score)), reasons };
}

/** Prefer the better-connected contact as the merge target (tie: lower id). */
function pickKeep(a: ContactDedupeRow, b: ContactDedupeRow): [ContactDedupeRow, ContactDedupeRow] {
  if (a.channelCount !== b.channelCount) return a.channelCount > b.channelCount ? [a, b] : [b, a];
  return a.id <= b.id ? [a, b] : [b, a];
}

export interface ContactDedupeOptions {
  limit?: number;
  minScore?: number;
}

/** Ranked duplicate-contact candidates; merge targets are suggestions only. */
export async function findSimilarContacts(
  userId: number,
  options: ContactDedupeOptions = {},
): Promise<DedupeCandidate[]> {
  const limit = readLimit(options.limit);
  const minScore = readMinScore(options.minScore, DEDUPE_CONTACT_MIN_SCORE_DEFAULT);
  const result = await query(
    `SELECT id, name, email, phone, contact_methods, telegram_chat_id, qq, wxpusher_uid
       FROM fixed_contacts
      WHERE user_id = $1
      ORDER BY id ASC
      LIMIT $2`,
    [userId, CONTACT_SCAN_CAP],
  );
  const rows = result.rows.map((row) => mapContactRow(row as Record<string, unknown>));

  const candidates: DedupeCandidate[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      const scored = scoreContactPair(a, b);
      if (scored.score < minScore || scored.reasons.length === 0) continue;
      const [keep, merge] = pickKeep(a, b);
      candidates.push({
        kind: 'contact',
        score: scored.score,
        reasons: scored.reasons,
        summary: `联系人「${a.name}」与「${b.name}」可能重复`,
        entities: [
          { id: a.id, label: a.name, detail: `${a.phones[0] ?? a.emails[0] ?? '—'}` },
          { id: b.id, label: b.name, detail: `${b.phones[0] ?? b.emails[0] ?? '—'}` },
        ],
        suggestedAction: {
          type: 'propose_merge',
          subjectKind: 'merge_contacts',
          payload: { keepContactId: keep.id, mergeContactId: merge.id },
        },
      });
    }
  }

  log.info({ userId, scanned: rows.length, candidates: candidates.length }, 'contact dedupe scan complete');
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Merge proposal (decision card — never applied directly)
// ---------------------------------------------------------------------------

export interface ProposeContactMergeInput {
  userId: number;
  keepContactId: number;
  mergeContactId: number;
  timezone?: string;
  now?: Date;
}

export type ProposeContactMergeStatus = 'proposed' | 'existing' | 'suppressed' | 'target_missing' | 'invalid';

export interface ProposeContactMergeResult {
  status: ProposeContactMergeStatus;
  cardId: number | null;
  created: boolean;
  message: string;
}

function mergeOutcomeMessage(outcome: ProposeDecisionResult['outcome']): { status: ProposeContactMergeStatus; message: string } {
  switch (outcome) {
    case 'created':
      return { status: 'proposed', message: '已创建合并决定卡；批准前不会修改任何数据' };
    case 'existing':
      return { status: 'existing', message: '相同的合并提议已存在，请在决定卡中审批' };
    case 'suppressed':
      return { status: 'suppressed', message: '该合并提议此前被拒绝，已按政策记忆抑制' };
  }
}

/**
 * Open a task-126 decision card proposing to merge two contacts. Nothing is
 * merged until the card is approved (or edited + approved); the shipped
 * `merge_contacts` resolver then performs the merge and records the task-142
 * audit snapshot for undo.
 */
export async function proposeContactMerge(
  input: ProposeContactMergeInput,
): Promise<ProposeContactMergeResult> {
  const keep = input.keepContactId;
  const merge = input.mergeContactId;
  if (!Number.isSafeInteger(keep) || keep <= 0 || !Number.isSafeInteger(merge) || merge <= 0 || keep === merge) {
    return { status: 'invalid', cardId: null, created: false, message: '需要两个不同的联系人 ID' };
  }

  const found = await query(
    `SELECT id, name FROM fixed_contacts WHERE user_id = $1 AND id = ANY($2::bigint[])`,
    [input.userId, [keep, merge]],
  );
  if (found.rows.length < 2) {
    return { status: 'target_missing', cardId: null, created: false, message: '联系人不存在或不属于当前用户' };
  }
  const names = new Map<number, string>();
  for (const row of found.rows as Array<Record<string, unknown>>) {
    names.set(Number(row.id), String(row.name ?? ''));
  }
  const label = (id: number): string => (names.get(id) ?? `#${id}`).slice(0, 60);

  const result = await proposeDecision({
    userId: input.userId,
    subjectKind: 'merge_contacts',
    subjectRef: `contact:${keep}+${merge}`,
    summary: `发现重复联系人：「${label(keep)}」与「${label(merge)}」。批准后合并到「${label(keep)}」并删除「${label(merge)}」。`,
    payload: { keepContactId: keep, mergeContactId: merge },
    idempotencyKey: `dedupe:merge:${keep}:${merge}`,
    timezone: input.timezone,
    now: input.now,
  });

  const mapped = mergeOutcomeMessage(result.outcome);
  return { status: mapped.status, cardId: result.card?.id ?? null, created: result.created, message: mapped.message };
}
