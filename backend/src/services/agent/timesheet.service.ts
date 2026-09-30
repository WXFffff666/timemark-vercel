/**
 * Task 153: attendance / timesheet tracking.
 *
 * Session model: one row per work session (`timesheet_sessions`), keyed by
 * `clock_in` / `clock_out` TIMESTAMPTZ. A NULL `clock_out` is the single open
 * session per user — enforced by the partial unique index
 * `uq_timesheet_open_session (user_id) WHERE clock_out IS NULL` (migration 72),
 * so a second clock-in can never create an open duplicate; the route answers 409
 * through `TimesheetConflictError`.
 *
 * Overnight handling: totals never attribute a whole session to its start day.
 * Sessions are split at local midnights (`splitSessionMs`) and each slice is
 * credited to its own local date, so 22:00 -> 06:00 yields 2h on day 1 and 6h on
 * day 2. Day/week totals and the overtime view all consume the same split.
 *
 * All queries are user_id scoped; another user's row is indistinguishable from
 * a missing row (404 at the route layer).
 */
import { query } from '../../db/index.js';
import { FALLBACK_TIMEZONE } from '../../utils/timezone.js';
import {
  addDaysYmd,
  isValidYmd,
  localDateIn,
  localMidnightMs,
  startOfWeekYmd,
  toIsoString,
  toYmdString,
  ymdDiffDays,
} from './local-day.js';

export const TIMESHEET_LEAVE_KINDS = ['absence', 'leave', 'sick', 'holiday', 'other'] as const;
export type TimesheetLeaveKind = (typeof TIMESHEET_LEAVE_KINDS)[number];

export const DEFAULT_OVERTIME_THRESHOLD_MINUTES = 8 * 60;
export const TIMESHEET_MAX_RANGE_DAYS = 366;
export const TIMESHEET_LIST_LIMIT = 500;

export class TimesheetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimesheetValidationError';
  }
}

export class TimesheetConflictError extends Error {
  constructor(readonly openSession: TimesheetSession | null) {
    super('timesheet.open_session_exists');
    this.name = 'TimesheetConflictError';
  }
}

export interface TimesheetSession {
  id: number;
  userId: number;
  clockIn: string;
  clockOut: string | null;
  note: string;
  location: string;
  createdAt: string;
  updatedAt: string;
  /** Completed duration; null while the session stays open. */
  durationMinutes: number | null;
  open: boolean;
}

export interface TimesheetLeave {
  id: number;
  userId: number;
  kind: TimesheetLeaveKind;
  startDate: string;
  endDate: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** Inclusive number of calendar days covered. */
  days: number;
}

export interface ClockInInput {
  note?: string;
  location?: string;
  /** ISO timestamp override; defaults to now(). */
  at?: string;
}

export interface ClockOutInput {
  note?: string;
  at?: string;
  sessionId?: number;
}

export interface SessionPatch {
  clockIn?: string;
  clockOut?: string | null;
  note?: string;
  location?: string;
}

export interface ListSessionsOptions {
  from?: string;
  to?: string;
}

export interface ClockOutOk {
  status: 'ok';
  session: TimesheetSession;
}
export type ClockOutResult =
  | ClockOutOk
  | { status: 'no_open_session' }
  | { status: 'not_found' }
  | { status: 'already_closed'; session: TimesheetSession }
  | { status: 'invalid'; reason: string };

export type UpdateSessionResult =
  | { status: 'ok'; session: TimesheetSession }
  | { status: 'not_found' }
  | { status: 'invalid'; reason: string }
  | { status: 'conflict'; openSession: TimesheetSession | null };

export type LeaveResult =
  | { status: 'ok'; leave: TimesheetLeave }
  | { status: 'not_found' }
  | { status: 'invalid'; reason: string };

export interface TimesheetDayTotal {
  date: string;
  minutes: number;
  /** Sessions contributing minutes to this date (overnight sessions count on both days). */
  sessionCount: number;
  /** Elapsed minutes contributed by a still-open session (subset of minutes). */
  openMinutes: number;
}

export interface TimesheetWeekTotal {
  weekStart: string;
  weekEnd: string;
  label: string;
  minutes: number;
  sessionCount: number;
  days: TimesheetDayTotal[];
}

export interface TimesheetOvertimeDay {
  date: string;
  workedMinutes: number;
  overtimeMinutes: number;
  thresholdMinutes: number;
}

export interface TimesheetOvertimeView {
  thresholdMinutes: number;
  totalOvertimeMinutes: number;
  days: TimesheetOvertimeDay[];
}

export interface TimesheetSummary {
  from: string;
  to: string;
  timezone: string;
  totalMinutes: number;
  sessionCount: number;
  openMinutes: number;
  days: TimesheetDayTotal[];
  weeks: TimesheetWeekTotal[];
  overtime: TimesheetOvertimeView;
  leaves: TimesheetLeave[];
  openSession: TimesheetSession | null;
}

interface SessionRow {
  id: unknown;
  user_id: unknown;
  clock_in: unknown;
  clock_out: unknown;
  note: string | null;
  location: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface LeaveRow {
  id: unknown;
  user_id: unknown;
  kind: string;
  start_date: unknown;
  end_date: unknown;
  note: string | null;
  created_at: unknown;
  updated_at: unknown;
}

function parseIsoDateTime(value: string): Date | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function parseClockTimestamp(value: string): Date | null {
  return parseIsoDateTime(value);
}

function rowToSession(row: SessionRow): TimesheetSession {
  const clockIn = toIsoString(row.clock_in) ?? new Date(0).toISOString();
  const clockOut = toIsoString(row.clock_out);
  const durationMinutes = clockOut
    ? Math.max(0, Math.round((Date.parse(clockOut) - Date.parse(clockIn)) / 60_000))
    : null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    clockIn,
    clockOut,
    note: row.note ?? '',
    location: row.location ?? '',
    createdAt: toIsoString(row.created_at) ?? clockIn,
    updatedAt: toIsoString(row.updated_at) ?? clockIn,
    durationMinutes,
    open: clockOut === null,
  };
}

function rowToLeave(row: LeaveRow): TimesheetLeave {
  const startDate = toYmdString(row.start_date) ?? '';
  const endDate = toYmdString(row.end_date) ?? startDate;
  const kind = (TIMESHEET_LEAVE_KINDS as readonly string[]).includes(row.kind)
    ? (row.kind as TimesheetLeaveKind)
    : 'other';
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    kind,
    startDate,
    endDate,
    note: row.note ?? '',
    createdAt: toIsoString(row.created_at) ?? '',
    updatedAt: toIsoString(row.updated_at) ?? '',
    days: isValidYmd(startDate) && isValidYmd(endDate) ? ymdDiffDays(startDate, endDate) + 1 : 0,
  };
}

function normalizeThresholdMinutes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_OVERTIME_THRESHOLD_MINUTES;
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 1440) return DEFAULT_OVERTIME_THRESHOLD_MINUTES;
  return rounded;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                           */
/* ------------------------------------------------------------------ */

export async function getSession(userId: number, id: number): Promise<TimesheetSession | null> {
  const result = await query(
    'SELECT * FROM timesheet_sessions WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rows.length > 0 ? rowToSession(result.rows[0] as SessionRow) : null;
}

export async function getOpenSession(userId: number): Promise<TimesheetSession | null> {
  const result = await query(
    `SELECT * FROM timesheet_sessions
     WHERE user_id = $1 AND clock_out IS NULL
     ORDER BY clock_in DESC LIMIT 1`,
    [userId],
  );
  return result.rows.length > 0 ? rowToSession(result.rows[0] as SessionRow) : null;
}

export async function listSessions(
  userId: number,
  options: ListSessionsOptions = {},
  timezone: string = FALLBACK_TIMEZONE,
): Promise<TimesheetSession[]> {
  const conditions = ['user_id = $1'];
  const params: unknown[] = [userId];
  if (options.to) {
    params.push(new Date(localMidnightMs(addDaysYmd(options.to, 1), timezone)).toISOString());
    conditions.push(`clock_in < $${params.length}::timestamptz`);
  }
  if (options.from) {
    params.push(new Date(localMidnightMs(options.from, timezone)).toISOString());
    conditions.push(`(clock_out IS NULL OR clock_out >= $${params.length}::timestamptz)`);
  }
  const result = await query(
    `SELECT * FROM timesheet_sessions
     WHERE ${conditions.join(' AND ')}
     ORDER BY clock_in DESC LIMIT ${TIMESHEET_LIST_LIMIT}`,
    params,
  );
  return result.rows.map((row) => rowToSession(row as SessionRow));
}

/**
 * Start a session. A second clock-in while a session is open is rejected by the
 * partial unique index (and pre-checked for the friendly 409) — never a duplicate.
 */
export async function clockIn(userId: number, input: ClockInInput = {}): Promise<TimesheetSession> {
  let atIso: string | null = null;
  if (input.at !== undefined) {
    const at = parseIsoDateTime(input.at);
    if (!at) throw new TimesheetValidationError('clock_in 时间无效');
    atIso = at.toISOString();
  }
  const inserted = await query(
    `INSERT INTO timesheet_sessions (user_id, clock_in, note, location)
     VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [userId, atIso, (input.note ?? '').trim(), (input.location ?? '').trim()],
  );
  if (inserted.rows.length > 0) {
    return rowToSession(inserted.rows[0] as SessionRow);
  }
  throw new TimesheetConflictError(await getOpenSession(userId));
}

/** Close the open session (or an explicit one); no open session is a 409 at the route. */
export async function clockOut(userId: number, input: ClockOutInput = {}): Promise<ClockOutResult> {
  let target: TimesheetSession | null;
  if (input.sessionId !== undefined) {
    if (!Number.isInteger(input.sessionId) || input.sessionId <= 0) {
      return { status: 'invalid', reason: 'session_id' };
    }
    target = await getSession(userId, input.sessionId);
    if (!target) return { status: 'not_found' };
    if (!target.open) return { status: 'already_closed', session: target };
  } else {
    target = await getOpenSession(userId);
    if (!target) return { status: 'no_open_session' };
  }

  let atIso: string | null = null;
  if (input.at !== undefined) {
    const at = parseIsoDateTime(input.at);
    if (!at) return { status: 'invalid', reason: 'clock_out' };
    atIso = at.toISOString();
  }
  const effectiveOut = atIso ?? new Date().toISOString();
  if (Date.parse(effectiveOut) <= Date.parse(target.clockIn)) {
    return { status: 'invalid', reason: 'clock_out_before_clock_in' };
  }

  const updated = await query(
    `UPDATE timesheet_sessions
     SET clock_out = COALESCE($3::timestamptz, now()),
         note = COALESCE($4, note),
         updated_at = now()
     WHERE id = $1 AND user_id = $2 AND clock_out IS NULL
     RETURNING *`,
    [target.id, userId, atIso, input.note !== undefined ? input.note.trim() : null],
  );
  if (updated.rows.length === 0) {
    const current = await getSession(userId, target.id);
    if (!current) return { status: 'not_found' };
    return { status: 'already_closed', session: current };
  }
  return { status: 'ok', session: rowToSession(updated.rows[0] as SessionRow) };
}

/** Edit a session (timestamps / note / location). Reopening is guarded by the open-session index. */
export async function updateSession(
  userId: number,
  id: number,
  patch: SessionPatch,
): Promise<UpdateSessionResult> {
  const existing = await getSession(userId, id);
  if (!existing) return { status: 'not_found' };

  const nextIn = patch.clockIn !== undefined ? parseIsoDateTime(patch.clockIn) : new Date(existing.clockIn);
  if (!nextIn) return { status: 'invalid', reason: 'clock_in' };

  let nextOut: Date | null;
  if (patch.clockOut === undefined) {
    nextOut = existing.clockOut ? new Date(existing.clockOut) : null;
  } else if (patch.clockOut === null) {
    nextOut = null;
  } else {
    nextOut = parseIsoDateTime(patch.clockOut);
    if (!nextOut) return { status: 'invalid', reason: 'clock_out' };
  }
  if (nextOut && nextOut.getTime() <= nextIn.getTime()) {
    return { status: 'invalid', reason: 'clock_out_before_clock_in' };
  }

  if (patch.clockOut === null && existing.clockOut !== null) {
    const otherOpen = await getOpenSession(userId);
    if (otherOpen && otherOpen.id !== id) {
      return { status: 'conflict', openSession: otherOpen };
    }
  }

  const updated = await query(
    `UPDATE timesheet_sessions
     SET clock_in = $3::timestamptz,
         clock_out = $4::timestamptz,
         note = CASE WHEN $5::boolean THEN $6 ELSE note END,
         location = CASE WHEN $7::boolean THEN $8 ELSE location END,
         updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      id,
      userId,
      nextIn.toISOString(),
      nextOut ? nextOut.toISOString() : null,
      patch.note !== undefined,
      (patch.note ?? '').trim(),
      patch.location !== undefined,
      (patch.location ?? '').trim(),
    ],
  );
  if (updated.rows.length === 0) return { status: 'not_found' };
  return { status: 'ok', session: rowToSession(updated.rows[0] as SessionRow) };
}

export async function deleteSession(userId: number, id: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM timesheet_sessions WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId],
  );
  return result.rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* Day / week / overtime aggregation (overnight-aware)                */
/* ------------------------------------------------------------------ */

interface SessionSlice {
  date: string;
  ms: number;
}

interface DayAccumulator {
  ms: number;
  openMs: number;
  sessionCount: number;
}

/** Split a session interval at each local midnight; each slice belongs to one local date. */
function splitSessionMs(startMs: number, endMs: number, timezone: string): SessionSlice[] {
  const slices: SessionSlice[] = [];
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs && guard < 1000) {
    const date = localDateIn(new Date(cursor), timezone);
    const nextMidnight = localMidnightMs(addDaysYmd(date, 1), timezone);
    const segmentEnd = Math.min(endMs, nextMidnight > cursor ? nextMidnight : endMs);
    slices.push({ date, ms: segmentEnd - cursor });
    cursor = segmentEnd;
    guard += 1;
  }
  return slices;
}

async function collectDayAccumulators(
  userId: number,
  from: string,
  to: string,
  timezone: string,
  nowMs: number,
): Promise<Map<string, DayAccumulator>> {
  const fromMs = localMidnightMs(from, timezone);
  const toMs = localMidnightMs(addDaysYmd(to, 1), timezone);
  const result = await query(
    `SELECT * FROM timesheet_sessions
     WHERE user_id = $1
       AND clock_in < $3::timestamptz
       AND (clock_out IS NULL OR clock_out >= $2::timestamptz)
     ORDER BY clock_in ASC
     LIMIT 5000`,
    [userId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );

  const map = new Map<string, DayAccumulator>();
  for (const row of result.rows as SessionRow[]) {
    const session = rowToSession(row);
    const startMs = Date.parse(session.clockIn);
    const endMs = session.clockOut ? Date.parse(session.clockOut) : nowMs;
    if (!Number.isFinite(startMs) || endMs <= startMs) continue;
    for (const slice of splitSessionMs(startMs, Math.min(endMs, toMs), timezone)) {
      if (slice.date < from || slice.date > to) continue;
      const acc = map.get(slice.date) ?? { ms: 0, openMs: 0, sessionCount: 0 };
      acc.ms += slice.ms;
      if (session.open) acc.openMs += slice.ms;
      acc.sessionCount += 1;
      map.set(slice.date, acc);
    }
  }
  return map;
}

export async function getDayTotals(
  userId: number,
  from: string,
  to: string,
  options: { timezone?: string; now?: Date } = {},
): Promise<TimesheetDayTotal[]> {
  const timezone = options.timezone ?? FALLBACK_TIMEZONE;
  const nowMs = (options.now ?? new Date()).getTime();
  const accumulator = await collectDayAccumulators(userId, from, to, timezone, nowMs);

  const days: TimesheetDayTotal[] = [];
  let date = from;
  let guard = 0;
  while (date <= to && guard <= TIMESHEET_MAX_RANGE_DAYS) {
    const acc = accumulator.get(date);
    days.push({
      date,
      minutes: acc ? Math.round(acc.ms / 60_000) : 0,
      sessionCount: acc?.sessionCount ?? 0,
      openMinutes: acc ? Math.round(acc.openMs / 60_000) : 0,
    });
    date = addDaysYmd(date, 1);
    guard += 1;
  }
  return days;
}

function buildOvertime(days: readonly TimesheetDayTotal[], thresholdMinutes: number): TimesheetOvertimeView {
  const over = days
    .filter((day) => day.minutes > thresholdMinutes)
    .map((day) => ({
      date: day.date,
      workedMinutes: day.minutes,
      overtimeMinutes: day.minutes - thresholdMinutes,
      thresholdMinutes,
    }));
  return {
    thresholdMinutes,
    totalOvertimeMinutes: over.reduce((sum, day) => sum + day.overtimeMinutes, 0),
    days: over,
  };
}

/** Days/weeks where worked minutes exceed the daily overtime threshold. */
export async function getOvertimeView(
  userId: number,
  from: string,
  to: string,
  options: { thresholdMinutes?: number; timezone?: string; now?: Date } = {},
): Promise<TimesheetOvertimeView> {
  const thresholdMinutes = normalizeThresholdMinutes(options.thresholdMinutes);
  const days = await getDayTotals(userId, from, to, options);
  return buildOvertime(days, thresholdMinutes);
}

/**
 * `GET /api/timesheet/summary` payload: per-day + per-week totals (overnight
 * shifts split at local midnight), the overtime view, overlapping leaves and the
 * current open session.
 */
export async function getTimesheetSummary(
  userId: number,
  options: { from: string; to: string; thresholdMinutes?: number; timezone?: string; now?: Date },
): Promise<TimesheetSummary> {
  const timezone = options.timezone ?? FALLBACK_TIMEZONE;
  const now = options.now ?? new Date();
  const days = await getDayTotals(userId, options.from, options.to, { timezone, now });

  const weekMap = new Map<string, TimesheetDayTotal[]>();
  for (const day of days) {
    const weekStart = startOfWeekYmd(day.date);
    const list = weekMap.get(weekStart) ?? [];
    list.push(day);
    weekMap.set(weekStart, list);
  }
  const weeks: TimesheetWeekTotal[] = [...weekMap.entries()].map(([weekStart, weekDays]) => {
    const weekEnd = addDaysYmd(weekStart, 6);
    return {
      weekStart,
      weekEnd,
      label: `${weekStart} ~ ${weekEnd}`,
      minutes: weekDays.reduce((sum, day) => sum + day.minutes, 0),
      sessionCount: weekDays.reduce((sum, day) => sum + day.sessionCount, 0),
      days: weekDays,
    };
  });

  const fromMs = localMidnightMs(options.from, timezone);
  const toMs = localMidnightMs(addDaysYmd(options.to, 1), timezone);
  const countResult = await query(
    `SELECT COUNT(*)::int AS count FROM timesheet_sessions
     WHERE user_id = $1
       AND clock_in < $3::timestamptz
       AND (clock_out IS NULL OR clock_out >= $2::timestamptz)`,
    [userId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );

  return {
    from: options.from,
    to: options.to,
    timezone,
    totalMinutes: days.reduce((sum, day) => sum + day.minutes, 0),
    sessionCount: Number(countResult.rows[0]?.count ?? 0),
    openMinutes: days.reduce((sum, day) => sum + day.openMinutes, 0),
    days,
    weeks,
    overtime: buildOvertime(days, normalizeThresholdMinutes(options.thresholdMinutes)),
    leaves: await listLeaves(userId, { from: options.from, to: options.to }),
    openSession: await getOpenSession(userId),
  };
}

/* ------------------------------------------------------------------ */
/* Absence / leave records                                            */
/* ------------------------------------------------------------------ */

export async function createLeave(
  userId: number,
  input: { kind?: string; startDate: string; endDate: string; note?: string },
): Promise<LeaveResult> {
  if (!isValidYmd(input.startDate) || !isValidYmd(input.endDate)) {
    return { status: 'invalid', reason: 'date' };
  }
  if (input.endDate < input.startDate) return { status: 'invalid', reason: 'range' };
  if (input.kind !== undefined && !(TIMESHEET_LEAVE_KINDS as readonly string[]).includes(input.kind)) {
    return { status: 'invalid', reason: 'kind' };
  }
  const inserted = await query(
    `INSERT INTO timesheet_leaves (user_id, kind, start_date, end_date, note)
     VALUES ($1, $2, $3::date, $4::date, $5)
     RETURNING *`,
    [userId, input.kind ?? 'leave', input.startDate, input.endDate, (input.note ?? '').trim()],
  );
  return { status: 'ok', leave: rowToLeave(inserted.rows[0] as LeaveRow) };
}

export async function listLeaves(
  userId: number,
  options: { from?: string; to?: string } = {},
): Promise<TimesheetLeave[]> {
  const conditions = ['user_id = $1'];
  const params: unknown[] = [userId];
  if (options.to) {
    params.push(options.to);
    conditions.push(`start_date <= $${params.length}::date`);
  }
  if (options.from) {
    params.push(options.from);
    conditions.push(`end_date >= $${params.length}::date`);
  }
  const result = await query(
    `SELECT * FROM timesheet_leaves
     WHERE ${conditions.join(' AND ')}
     ORDER BY start_date DESC, id DESC LIMIT ${TIMESHEET_LIST_LIMIT}`,
    params,
  );
  return result.rows.map((row) => rowToLeave(row as LeaveRow));
}

export async function deleteLeave(userId: number, id: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM timesheet_leaves WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId],
  );
  return result.rows.length > 0;
}
