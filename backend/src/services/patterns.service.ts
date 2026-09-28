import { query } from '../db/index.js';
import {
  dateStringInTimeZone,
  normalizeScheduleDays,
  shiftCalendarDays,
} from '@timemark/shared/habit-schedule';
import { toYmdString } from '@timemark/shared/event-schedule';

/**
 * Deterministic behavioural-pattern miner (checkbox 105).
 *
 * Everything here is derived from rows that ALREADY exist in the database with plain SQL
 * plus pure TypeScript: no LLM, no external API, nothing is sent off-box. The service is
 * consumed by the summary lanes (checkboxes 108/111) as structured priors - they may READ
 * these rows, while this service never calls an AI provider and imports nothing from the
 * backend AI gateway or any LLM client.
 *
 * ## Evidence and confidence
 * Every pattern stores the number of *consistent observations* behind it and maps that
 * count onto a confidence with `confidenceForEvidence()`:
 *   >= 10 -> 0.90; 5..9 -> 0.70..0.90 (0.05 step); 3..4 -> 0.50..0.60; 1..2 -> 0.30..0.40.
 * Rows below `SURFACED_MIN_CONFIDENCE` (0.5) are still STORED - they grow into real
 * preferences as evidence accumulates - but `listPatterns()` (the API) filters them out.
 *
 * ## Time zones
 * `event_trigger_logs.created_at` is an absolute instant; the hour bucket is computed in
 * the user's IANA timezone from `user_configs.timezone` (fallback `Asia/Shanghai`), never
 * from the host clock. A timezone change therefore re-buckets on the next recompute, and
 * the recompute deletes the user's old rows before writing the new ones so no stale bucket
 * survives the change.
 *
 * ## Reading `trigger_date` (migration 51 lesson)
 * `event_trigger_logs.trigger_date` is TEXT. Only normal dedup tokens
 * `YYYY-MM-DD#d<n>#tHH:mm` carry a calendar day; namespaced keys (`snooze:event#...`)
 * carry NO leading date and must be rejected by the strict token regex - never truncated
 * with `LEFT(..., 10)` and never cast to a date.
 */

/** Fallback when `user_configs.timezone` is missing or not a valid IANA name. */
export const DEFAULT_PATTERN_TIMEZONE = 'Asia/Shanghai';

/** Patterns at or above this confidence are returned by `GET /api/patterns`. */
export const SURFACED_MIN_CONFIDENCE = 0.5;

export const PATTERN_KINDS = [
  'reminder_time',
  'lead_time',
  'channel',
  'weekday_type',
  'snooze_frequency',
  'habit_weekday',
  'contact_cadence',
] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];

export interface ComputedPattern {
  kind: PatternKind;
  key: string;
  value: Record<string, unknown>;
  confidence: number;
  evidence_count: number;
}

export interface UserPattern extends ComputedPattern {
  id: number;
  user_id: number;
  computed_at: string | null;
}

interface TriggerRow {
  trigger_date: unknown;
  status: unknown;
  channel_results: unknown;
  created_at: unknown;
}

interface AccountRow {
  type: unknown;
  is_active: unknown;
  connection_status: unknown;
}

interface EventRow {
  event_type: unknown;
  date: unknown;
}

interface ClaimRow {
  trigger_date: unknown;
}

interface HabitRow {
  id: unknown;
  schedule_days: unknown;
  created_at: unknown;
}

interface HabitLogRow {
  habit_id: unknown;
  logged_on: unknown;
}

interface ContactRow {
  id: unknown;
  name: unknown;
  cadence_days: unknown;
}

interface InteractionRow {
  contact_id: unknown;
  occurred_at: unknown;
}

const DAY_MS = 86_400_000;

/** Habit completion rates are computed over a fixed trailing window. */
const HABIT_WINDOW_DAYS = 84;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Deterministic confidence from the evidence count (documented in the header). The bands
 * are deliberately coarse: the value is evidence STRENGTH, not a probability.
 */
export function confidenceForEvidence(count: number): number {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n >= 10) return 0.9;
  if (n >= 5) return round2(0.7 + (n - 5) * 0.05);
  if (n >= 3) return round2(0.5 + (n - 3) * 0.1);
  if (n >= 1) return round2(0.3 + (n - 1) * 0.1);
  return 0;
}

/** True when `timeZone` is a valid IANA name for `Intl` (never throws). */
export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch (error) {
    // An unknown IANA name is caller data, not a bug: report "unsupported" so the
    // caller falls back to DEFAULT_PATTERN_TIMEZONE.
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * `HH:00` wall-clock hour of `instant` in `timeZone`; null for an unparsable instant or
 * an unsupported timezone. `hourCycle: 'h23'` keeps midnight at `00`, not `24`.
 */
export function hourBucketInTimeZone(instant: unknown, timeZone: string): string | null {
  const date = instant instanceof Date ? instant : new Date(String(instant));
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = parts.find((part) => part.type === 'hour')?.value;
    return hour ? `${hour.padStart(2, '0')}:00` : null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * Normal reminder dedup token `YYYY-MM-DD#d<daysUntil>#t<HH:mm>`.
 * Namespaced keys (`snooze:event#...`, `med:snooze#...`) return null by construction.
 */
export function parseReminderTriggerToken(
  raw: unknown,
): { ymd: string; leadDays: number; time: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})#d(-?\d+)#t(\d{2}:\d{2})$/.exec(String(raw ?? ''));
  if (!match) return null;
  return { ymd: match[1], leadDays: Number(match[2]), time: match[3] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accepts the JSONB object the endpoint writes AND the legacy JSON-string shape; any
 * malformed payload degrades to `{}` (no evidence) and never crashes the nightly run.
 */
export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch (error) {
      if (error instanceof SyntaxError) return {};
      throw error;
    }
  }
  return isRecord(raw) ? raw : {};
}

/** One channel entry contributes evidence only when it carries a boolean `success`. */
function channelOutcome(raw: unknown): boolean | null {
  if (!isRecord(raw)) return null;
  return typeof raw.success === 'boolean' ? raw.success : null;
}

function weekdayOfYmd(ymd: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = String(value);
  if (text === '') return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function serializePattern(row: Record<string, unknown>): UserPattern {
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    kind: String(row.kind) as PatternKind,
    key: String(row.key),
    value: parseJsonObject(row.value),
    confidence: Number(row.confidence ?? 0),
    evidence_count: Number(row.evidence_count ?? 0),
    computed_at: toIsoOrNull(row.computed_at),
  };
}

interface ObservationBucket {
  total: number;
  success: number;
  failed: number;
}

function bumpBucket(
  buckets: Map<string, ObservationBucket>,
  key: string,
  success: boolean,
): void {
  const entry = buckets.get(key) ?? { total: 0, success: 0, failed: 0 };
  entry.total += 1;
  if (success) entry.success += 1;
  else entry.failed += 1;
  buckets.set(key, entry);
}

/**
 * Reminder-time preference: the hours at which reminders are actually DELIVERED
 * (`status = 'success'`) versus the hours where they pile up as undelivered
 * (`status = 'failed'`). Evidence = delivered count in the hour.
 */
function mineReminderTimes(rows: TriggerRow[], timeZone: string): ComputedPattern[] {
  const buckets = new Map<string, ObservationBucket>();
  for (const row of rows) {
    const token = parseReminderTriggerToken(row.trigger_date);
    if (!token) continue;
    const hour =
      hourBucketInTimeZone(row.created_at, timeZone) ?? `${token.time.slice(0, 2)}:00`;
    bumpBucket(buckets, hour, row.status === 'success');
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, entry]) => ({
      kind: 'reminder_time' as const,
      key: hour,
      value: {
        hour,
        total: entry.total,
        acted_on: entry.success,
        ignored: entry.failed,
        act_rate: entry.total > 0 ? round2(entry.success / entry.total) : 0,
        verdict: entry.success >= entry.failed ? 'acted_on' : 'ignored',
      },
      confidence: confidenceForEvidence(entry.success),
      evidence_count: entry.success,
    }));
}

/**
 * Lead-time habit: for every `#d<n>` lead day, how often the reminder at that lead was
 * delivered. Evidence = delivered count for the lead day.
 */
function mineLeadTimes(rows: TriggerRow[]): ComputedPattern[] {
  const buckets = new Map<string, ObservationBucket>();
  for (const row of rows) {
    const token = parseReminderTriggerToken(row.trigger_date);
    if (!token) continue;
    bumpBucket(buckets, `d${token.leadDays}`, row.status === 'success');
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => {
      const keepRate = entry.total > 0 ? round2(entry.success / entry.total) : 0;
      return {
        kind: 'lead_time' as const,
        key,
        value: {
          lead_days: Number(key.slice(1)),
          total: entry.total,
          kept: entry.success,
          missed: entry.failed,
          keep_rate: keepRate,
          verdict: keepRate >= 0.5 ? 'kept' : 'slipping',
        },
        confidence: confidenceForEvidence(entry.success),
        evidence_count: entry.success,
      };
    });
}

/**
 * Channel preference: per notification channel, delivered vs failed sends (from the
 * `channel_results` JSONB of the trigger logs) plus the number of accounts of that
 * channel type that are switched off / unhealthy. Evidence = delivered count.
 */
function mineChannels(rows: TriggerRow[], accounts: AccountRow[]): ComputedPattern[] {
  const buckets = new Map<string, { success: number; failed: number }>();
  for (const row of rows) {
    const results = parseJsonObject(row.channel_results);
    for (const [channel, raw] of Object.entries(results)) {
      const outcome = channelOutcome(raw);
      if (outcome === null) continue;
      const entry = buckets.get(channel) ?? { success: 0, failed: 0 };
      if (outcome) entry.success += 1;
      else entry.failed += 1;
      buckets.set(channel, entry);
    }
  }

  const disabled = new Map<string, number>();
  for (const account of accounts) {
    if (account.is_active === false || account.connection_status === 'unhealthy') {
      const type = String(account.type ?? '');
      if (type !== '') disabled.set(type, (disabled.get(type) ?? 0) + 1);
    }
  }

  const channels = [...new Set([...buckets.keys(), ...disabled.keys()])].sort();
  return channels.map((channel) => {
    const entry = buckets.get(channel) ?? { success: 0, failed: 0 };
    const attempts = entry.success + entry.failed;
    const disabledAccounts = disabled.get(channel) ?? 0;
    return {
      kind: 'channel' as const,
      key: channel,
      value: {
        channel,
        success: entry.success,
        failed: entry.failed,
        success_rate: attempts > 0 ? round2(entry.success / attempts) : 0,
        disabled_accounts: disabledAccounts,
        verdict:
          disabledAccounts > 0 && entry.success === 0
            ? 'disabled'
            : entry.success >= entry.failed
              ? 'reliable'
              : 'flaky',
      },
      confidence: confidenceForEvidence(entry.success),
      evidence_count: entry.success,
    };
  });
}

/**
 * Weekday/type distribution of the user's events (a date-only calendar property: the
 * weekday is intrinsic to the YYYY-MM-DD value, so no timezone is involved).
 * Evidence = number of events on that weekday.
 */
function mineWeekdayTypes(rows: EventRow[]): ComputedPattern[] {
  const buckets = new Map<number, { total: number; types: Map<string, number> }>();
  for (const row of rows) {
    const ymd = toYmdString(row.date);
    if (!ymd) continue;
    const weekday = weekdayOfYmd(ymd);
    if (weekday === null) continue;
    const entry = buckets.get(weekday) ?? { total: 0, types: new Map<string, number>() };
    entry.total += 1;
    const type = String(row.event_type ?? 'other');
    entry.types.set(type, (entry.types.get(type) ?? 0) + 1);
    buckets.set(weekday, entry);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([weekday, entry]) => ({
      kind: 'weekday_type' as const,
      key: String(weekday),
      value: {
        weekday,
        total: entry.total,
        types: Object.fromEntries([...entry.types.entries()].sort()),
      },
      confidence: confidenceForEvidence(entry.total),
      evidence_count: entry.total,
    }));
}

/**
 * Snooze frequency: how often event reminders were snoozed instead of fired as
 * scheduled. Evidence = number of observed event reminders (the opportunities).
 * Only `reminder_send_claims` keys that are event reminders are counted, so habit /
 * medication claims (`habit#...`, `med:snooze#...`) never leak in even when their
 * entity ids collide with an event id.
 */
function mineSnoozeFrequency(rows: ClaimRow[]): ComputedPattern[] {
  if (rows.length === 0) return [];
  let reminders = 0;
  let snoozes = 0;
  for (const row of rows) {
    const key = String(row.trigger_date ?? '');
    if (key.startsWith('snooze:')) snoozes += 1;
    else reminders += 1;
  }
  const rate = reminders > 0 ? round2(snoozes / reminders) : 0;
  return [
    {
      kind: 'snooze_frequency',
      key: 'event_reminders',
      value: {
        reminders,
        snoozes,
        snooze_rate: rate,
        verdict: rate >= 0.5 ? 'frequent' : 'rare',
      },
      confidence: confidenceForEvidence(reminders),
      evidence_count: reminders,
    },
  ];
}

/**
 * Habit completion rate per weekday over a fixed trailing window, honouring each
 * habit's `schedule_days` (empty = every day) and never counting days before the habit
 * was created. Evidence = scheduled habit-days observed for that weekday.
 */
function mineHabitWeekdays(
  habits: HabitRow[],
  logs: HabitLogRow[],
  timeZone: string,
  now: Date,
): ComputedPattern[] {
  if (habits.length === 0) return [];
  const endYmd = dateStringInTimeZone(now, timeZone);
  const logged = new Set<string>();
  for (const log of logs) {
    const ymd = toYmdString(log.logged_on);
    if (ymd) logged.add(`${Number(log.habit_id)}#${ymd}`);
  }

  const scheduled = new Array<number>(7).fill(0);
  const completed = new Array<number>(7).fill(0);
  for (const habit of habits) {
    const habitId = Number(habit.id);
    const schedule = normalizeScheduleDays(habit.schedule_days);
    const createdYmd = toYmdString(habit.created_at);
    for (let offset = 0; offset < HABIT_WINDOW_DAYS; offset += 1) {
      const ymd = shiftCalendarDays(endYmd, -offset);
      if (!ymd) continue;
      if (createdYmd && ymd < createdYmd) continue;
      const weekday = weekdayOfYmd(ymd);
      if (weekday === null) continue;
      if (schedule && !schedule.includes(weekday)) continue;
      scheduled[weekday] += 1;
      if (logged.has(`${habitId}#${ymd}`)) completed[weekday] += 1;
    }
  }

  const patterns: ComputedPattern[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    if (scheduled[weekday] === 0) continue;
    patterns.push({
      kind: 'habit_weekday',
      key: String(weekday),
      value: {
        weekday,
        scheduled: scheduled[weekday],
        completed: completed[weekday],
        completion_rate: round2(completed[weekday] / scheduled[weekday]),
      },
      confidence: confidenceForEvidence(scheduled[weekday]),
      evidence_count: scheduled[weekday],
    });
  }
  return patterns;
}

/**
 * Contact cadence drift: the average gap between consecutive logged interactions
 * compared with the contact's configured `cadence_days`. Positive drift = contacted
 * less often than configured. Evidence = number of observed gaps.
 */
function mineContactCadence(
  contacts: ContactRow[],
  interactions: InteractionRow[],
): ComputedPattern[] {
  const byContact = new Map<number, Date[]>();
  for (const row of interactions) {
    const contactId = Number(row.contact_id);
    const occurred = row.occurred_at instanceof Date
      ? row.occurred_at
      : new Date(String(row.occurred_at));
    if (!Number.isFinite(contactId) || Number.isNaN(occurred.getTime())) continue;
    const list = byContact.get(contactId) ?? [];
    list.push(occurred);
    byContact.set(contactId, list);
  }

  const patterns: ComputedPattern[] = [];
  for (const contact of contacts) {
    const contactId = Number(contact.id);
    const cadenceDays = Number(contact.cadence_days);
    if (!Number.isFinite(contactId) || !Number.isFinite(cadenceDays) || cadenceDays < 1) continue;
    const stamps = (byContact.get(contactId) ?? []).sort((a, b) => a.getTime() - b.getTime());

    let gapTotal = 0;
    let gaps = 0;
    for (let i = 1; i < stamps.length; i += 1) {
      const gapDays = (stamps[i].getTime() - stamps[i - 1].getTime()) / DAY_MS;
      if (gapDays <= 0) continue;
      gapTotal += gapDays;
      gaps += 1;
    }
    if (gaps === 0) continue;

    const avgGapDays = gapTotal / gaps;
    patterns.push({
      kind: 'contact_cadence',
      key: `contact:${contactId}`,
      value: {
        contact_id: contactId,
        name: contact.name == null ? null : String(contact.name),
        cadence_days: cadenceDays,
        avg_gap_days: round1(avgGapDays),
        drift_days: round1(avgGapDays - cadenceDays),
        samples: gaps,
      },
      confidence: confidenceForEvidence(gaps),
      evidence_count: gaps,
    });
  }
  return patterns;
}

async function loadTimezone(userId: number): Promise<string> {
  const result = await query('SELECT timezone FROM user_configs WHERE user_id = $1', [userId]);
  const raw = result.rows[0]?.timezone;
  const candidate = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_PATTERN_TIMEZONE;
  return isSupportedTimeZone(candidate) ? candidate : DEFAULT_PATTERN_TIMEZONE;
}

async function insertPattern(userId: number, pattern: ComputedPattern): Promise<void> {
  await query(
    `INSERT INTO user_patterns (user_id, kind, key, value, confidence, evidence_count, computed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, kind, key) DO UPDATE SET
       value = EXCLUDED.value,
       confidence = EXCLUDED.confidence,
       evidence_count = EXCLUDED.evidence_count,
       computed_at = CURRENT_TIMESTAMP`,
    [
      userId,
      pattern.kind,
      pattern.key,
      JSON.stringify(pattern.value),
      pattern.confidence,
      pattern.evidence_count,
    ],
  );
}

/**
 * Recomputes EVERY pattern for one user from existing logs and replaces the user's rows
 * (delete-then-insert inside one call, so a timezone change cannot leave both the old and
 * the new hour buckets behind). A user with no data produces zero patterns - and no error.
 */
export async function recomputePatterns(
  userId: number,
  now: Date = new Date(),
): Promise<ComputedPattern[]> {
  const timeZone = await loadTimezone(userId);

  const [
    triggerResult,
    accountResult,
    eventResult,
    claimResult,
    habitResult,
    habitLogResult,
    contactResult,
    interactionResult,
  ] = await Promise.all([
    query(
      'SELECT trigger_date, status, channel_results, created_at FROM event_trigger_logs WHERE user_id = $1',
      [userId],
    ),
    query(
      'SELECT type, is_active, connection_status FROM notification_accounts WHERE user_id = $1',
      [userId],
    ),
    query('SELECT event_type, date FROM events WHERE user_id = $1', [userId]),
    query(
      `SELECT DISTINCT c.trigger_date FROM reminder_send_claims c
       JOIN events e ON e.id = c.event_id
       WHERE e.user_id = $1
         AND (c.trigger_date LIKE 'snooze:event#%' OR c.trigger_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}#d')`,
      [userId],
    ),
    query(
      'SELECT id, schedule_days, created_at FROM habits WHERE user_id = $1 AND is_active = TRUE',
      [userId],
    ),
    query('SELECT habit_id, logged_on FROM habit_logs WHERE user_id = $1', [userId]),
    query(
      'SELECT id, name, cadence_days FROM fixed_contacts WHERE user_id = $1 AND cadence_days IS NOT NULL',
      [userId],
    ),
    query(
      'SELECT contact_id, occurred_at FROM interactions WHERE user_id = $1 ORDER BY contact_id, occurred_at',
      [userId],
    ),
  ]);

  const computed: ComputedPattern[] = [
    ...mineReminderTimes(triggerResult.rows as TriggerRow[], timeZone),
    ...mineLeadTimes(triggerResult.rows as TriggerRow[]),
    ...mineChannels(triggerResult.rows as TriggerRow[], accountResult.rows as AccountRow[]),
    ...mineWeekdayTypes(eventResult.rows as EventRow[]),
    ...mineSnoozeFrequency(claimResult.rows as ClaimRow[]),
    ...mineHabitWeekdays(
      habitResult.rows as HabitRow[],
      habitLogResult.rows as HabitLogRow[],
      timeZone,
      now,
    ),
    ...mineContactCadence(contactResult.rows as ContactRow[], interactionResult.rows as InteractionRow[]),
  ];

  await query('DELETE FROM user_patterns WHERE user_id = $1', [userId]);
  for (const pattern of computed) {
    await insertPattern(userId, pattern);
  }
  return computed;
}

/** Nightly entry point for daily-maintenance: recompute every user, one at a time. */
export async function recomputeAllUserPatterns(
  now: Date = new Date(),
): Promise<{ users: number; patterns: number }> {
  const result = await query('SELECT id FROM users ORDER BY id');
  let users = 0;
  let patterns = 0;
  for (const row of result.rows) {
    const userId = Number((row as { id?: unknown }).id);
    if (!Number.isFinite(userId)) continue;
    users += 1;
    patterns += (await recomputePatterns(userId, now)).length;
  }
  return { users, patterns };
}

/**
 * API read: only patterns at or above SURFACED_MIN_CONFIDENCE are returned; weaker rows
 * stay in the table for future recomputes but are never surfaced.
 */
export async function listPatterns(userId: number, kind?: PatternKind): Promise<UserPattern[]> {
  const params: unknown[] = [userId, SURFACED_MIN_CONFIDENCE];
  let sql = `SELECT id, user_id, kind, key, value, confidence, evidence_count, computed_at
             FROM user_patterns
             WHERE user_id = $1 AND confidence >= $2`;
  if (kind) {
    params.push(kind);
    sql += ` AND kind = $${params.length}`;
  }
  sql += ' ORDER BY kind ASC, confidence DESC, key ASC';
  const result = await query(sql, params);
  return result.rows.map((row) => serializePattern(row as Record<string, unknown>));
}
