/**
 * Task 154: child / elder care records.
 *
 * Model:
 *  - `care_profiles`: the care recipient (name, relationship, DOB, allergies, notes).
 *  - `care_logs`: timestamped care events (feeding / dose / vitals / mood / incident).
 *    The table name is deliberately `care_logs` so it cannot collide with the
 *    existing medications/doses domain. `label` / `value` / `unit` carry the
 *    measurement history (e.g. 体温 36.8 C, 体重 12.5 kg) consumed by the trend view.
 *  - Daily log: the events of one local day plus a preformatted `text` block that a
 *    client can print as-is.
 *
 * All queries are user_id scoped; another user's profile is indistinguishable from
 * a missing one (404 at the route layer).
 */
import { query } from '../../db/index.js';
import { FALLBACK_TIMEZONE } from '../../utils/timezone.js';
import { addDaysYmd, isValidYmd, localMidnightMs, toIsoString, toYmdString } from './local-day.js';
import { computeMeasureTrend, type MeasurePoint, type MeasureTrend } from './measure-trend.js';

export const CARE_LOG_KINDS = ['feeding', 'dose', 'vitals', 'mood', 'incident'] as const;
export type CareLogKind = (typeof CARE_LOG_KINDS)[number];

export const CARE_LOG_KIND_LABELS: Record<CareLogKind, string> = {
  feeding: '喂养',
  dose: '用药',
  vitals: '测量',
  mood: '情绪',
  incident: '异常',
};

export const CARE_LIST_LIMIT = 500;

export type CareResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'not_found' }
  | { status: 'invalid'; reason: string };

export interface CareProfile {
  id: number;
  userId: number;
  name: string;
  relationship: string;
  dateOfBirth: string | null;
  allergies: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface CareProfileInput {
  name: string;
  relationship?: string;
  dateOfBirth?: string | null;
  allergies?: string;
  notes?: string;
}

export interface CareProfilePatch {
  name?: string;
  relationship?: string;
  dateOfBirth?: string | null;
  allergies?: string;
  notes?: string;
}

export interface CareLog {
  id: number;
  userId: number;
  profileId: number;
  kind: CareLogKind;
  loggedAt: string;
  label: string;
  value: number | null;
  unit: string;
  detail: string;
  createdAt: string;
}

export interface CareLogInput {
  kind: CareLogKind;
  loggedAt?: string;
  label?: string;
  value?: number | null;
  unit?: string;
  detail?: string;
}

export interface CareLogPatch {
  kind?: CareLogKind;
  loggedAt?: string;
  label?: string;
  value?: number | null;
  unit?: string;
  detail?: string;
}

export interface CareLogFilters {
  kind?: CareLogKind;
  from?: string;
  to?: string;
  limit?: number;
  timezone?: string;
  order?: 'asc' | 'desc';
}

export interface CareDailyLog {
  profile: CareProfile;
  date: string;
  timezone: string;
  events: CareLog[];
  totals: Record<CareLogKind, number>;
  /** Print-ready monospace text rendering of the day. */
  text: string;
}

export interface CareMeasurementTrend {
  profileId: number;
  label: string | null;
  from: string | null;
  to: string | null;
  timezone: string;
  trend: MeasureTrend;
}

interface ProfileRow {
  id: unknown;
  user_id: unknown;
  name: string;
  relationship: string | null;
  date_of_birth: unknown;
  allergies: string | null;
  notes: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface LogRow {
  id: unknown;
  user_id: unknown;
  profile_id: unknown;
  kind: string;
  logged_at: unknown;
  label: string | null;
  value: unknown;
  unit: string | null;
  detail: string | null;
  created_at: unknown;
}

function isCareLogKind(value: string): value is CareLogKind {
  return (CARE_LOG_KINDS as readonly string[]).includes(value);
}

function rowToProfile(row: ProfileRow): CareProfile {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name,
    relationship: row.relationship ?? '',
    dateOfBirth: toYmdString(row.date_of_birth),
    allergies: row.allergies ?? '',
    notes: row.notes ?? '',
    createdAt: toIsoString(row.created_at) ?? '',
    updatedAt: toIsoString(row.updated_at) ?? '',
  };
}

function rowToLog(row: LogRow): CareLog {
  const kind = isCareLogKind(row.kind) ? row.kind : 'mood';
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    profileId: Number(row.profile_id),
    kind,
    loggedAt: toIsoString(row.logged_at) ?? '',
    label: row.label ?? '',
    value: row.value == null ? null : Number(row.value),
    unit: row.unit ?? '',
    detail: row.detail ?? '',
    createdAt: toIsoString(row.created_at) ?? '',
  };
}

function countByKind(events: readonly CareLog[]): Record<CareLogKind, number> {
  const totals: Record<CareLogKind, number> = { feeding: 0, dose: 0, vitals: 0, mood: 0, incident: 0 };
  for (const event of events) totals[event.kind] += 1;
  return totals;
}

function formatTimeInZone(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** Print-ready plain-text daily log (UTF-8, monospace friendly). */
export function formatCareDailyLog(
  profile: CareProfile,
  date: string,
  events: readonly CareLog[],
  timezone: string,
): string {
  const title = `照护日志 · ${profile.name}${profile.relationship ? `（${profile.relationship}）` : ''} · ${date}`;
  const lines = [title, '='.repeat(32)];
  if (events.length === 0) lines.push('（当天暂无记录）');
  for (const event of events) {
    const parts = [
      formatTimeInZone(event.loggedAt, timezone).padEnd(5),
      CARE_LOG_KIND_LABELS[event.kind],
      event.label,
      event.value !== null ? `${event.value}${event.unit}` : '',
      event.detail,
    ].filter((part) => part !== '');
    lines.push(parts.join('  '));
  }
  const totals = countByKind(events);
  lines.push('-'.repeat(32));
  lines.push(CARE_LOG_KINDS.map((kind) => `${CARE_LOG_KIND_LABELS[kind]} ${totals[kind]}`).join(' · '));
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Profiles                                                           */
/* ------------------------------------------------------------------ */

export async function listCareProfiles(userId: number): Promise<CareProfile[]> {
  const result = await query(
    'SELECT * FROM care_profiles WHERE user_id = $1 ORDER BY created_at ASC, id ASC',
    [userId],
  );
  return result.rows.map((row) => rowToProfile(row as ProfileRow));
}

export async function getCareProfile(userId: number, id: number): Promise<CareProfile | null> {
  const result = await query(
    'SELECT * FROM care_profiles WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rows.length > 0 ? rowToProfile(result.rows[0] as ProfileRow) : null;
}

export async function createCareProfile(
  userId: number,
  input: CareProfileInput,
): Promise<CareResult<CareProfile>> {
  const name = input.name.trim();
  if (name === '') return { status: 'invalid', reason: 'name' };
  if (input.dateOfBirth != null && !isValidYmd(input.dateOfBirth)) {
    return { status: 'invalid', reason: 'date_of_birth' };
  }
  const inserted = await query(
    `INSERT INTO care_profiles (user_id, name, relationship, date_of_birth, allergies, notes)
     VALUES ($1, $2, $3, $4::date, $5, $6)
     RETURNING *`,
    [
      userId,
      name,
      (input.relationship ?? '').trim(),
      input.dateOfBirth ?? null,
      (input.allergies ?? '').trim(),
      (input.notes ?? '').trim(),
    ],
  );
  return { status: 'ok', data: rowToProfile(inserted.rows[0] as ProfileRow) };
}

export async function updateCareProfile(
  userId: number,
  id: number,
  patch: CareProfilePatch,
): Promise<CareResult<CareProfile>> {
  const sets: string[] = [];
  const params: unknown[] = [id, userId];

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === '') return { status: 'invalid', reason: 'name' };
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.relationship !== undefined) {
    params.push(patch.relationship.trim());
    sets.push(`relationship = $${params.length}`);
  }
  if (patch.dateOfBirth !== undefined) {
    if (patch.dateOfBirth !== null && !isValidYmd(patch.dateOfBirth)) {
      return { status: 'invalid', reason: 'date_of_birth' };
    }
    params.push(patch.dateOfBirth);
    sets.push(`date_of_birth = $${params.length}::date`);
  }
  if (patch.allergies !== undefined) {
    params.push(patch.allergies.trim());
    sets.push(`allergies = $${params.length}`);
  }
  if (patch.notes !== undefined) {
    params.push(patch.notes.trim());
    sets.push(`notes = $${params.length}`);
  }
  if (sets.length === 0) return { status: 'invalid', reason: 'empty' };
  sets.push('updated_at = now()');

  const result = await query(
    `UPDATE care_profiles SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
    params,
  );
  if (result.rows.length === 0) return { status: 'not_found' };
  return { status: 'ok', data: rowToProfile(result.rows[0] as ProfileRow) };
}

export async function deleteCareProfile(userId: number, id: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM care_profiles WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId],
  );
  return result.rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* Care events (care_logs)                                            */
/* ------------------------------------------------------------------ */

function parseLoggedAt(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function queryLogs(
  userId: number,
  profileId: number,
  filters: CareLogFilters,
): Promise<CareLog[]> {
  const timezone = filters.timezone ?? FALLBACK_TIMEZONE;
  const conditions = ['user_id = $1', 'profile_id = $2'];
  const params: unknown[] = [userId, profileId];

  if (filters.kind) {
    params.push(filters.kind);
    conditions.push(`kind = $${params.length}`);
  }
  if (filters.from) {
    params.push(new Date(localMidnightMs(filters.from, timezone)).toISOString());
    conditions.push(`logged_at >= $${params.length}::timestamptz`);
  }
  if (filters.to) {
    params.push(new Date(localMidnightMs(addDaysYmd(filters.to, 1), timezone)).toISOString());
    conditions.push(`logged_at < $${params.length}::timestamptz`);
  }

  const limitRaw = filters.limit ?? CARE_LIST_LIMIT;
  const limit = Math.min(Math.max(Math.round(limitRaw), 1), CARE_LIST_LIMIT);
  const order = filters.order === 'asc' ? 'ASC' : 'DESC';
  const result = await query(
    `SELECT * FROM care_logs
     WHERE ${conditions.join(' AND ')}
     ORDER BY logged_at ${order}, id ${order} LIMIT ${limit}`,
    params,
  );
  return result.rows.map((row) => rowToLog(row as LogRow));
}

export async function createCareLog(
  userId: number,
  profileId: number,
  input: CareLogInput,
): Promise<CareResult<CareLog>> {
  const profile = await getCareProfile(userId, profileId);
  if (!profile) return { status: 'not_found' };

  let loggedAt: string | null = null;
  if (input.loggedAt !== undefined) {
    loggedAt = parseLoggedAt(input.loggedAt);
    if (!loggedAt) return { status: 'invalid', reason: 'logged_at' };
  }
  if (input.value !== undefined && input.value !== null && !Number.isFinite(input.value)) {
    return { status: 'invalid', reason: 'value' };
  }

  const inserted = await query(
    `INSERT INTO care_logs (user_id, profile_id, kind, logged_at, label, value, unit, detail)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6, $7, $8)
     RETURNING *`,
    [
      userId,
      profileId,
      input.kind,
      loggedAt,
      (input.label ?? '').trim(),
      input.value ?? null,
      (input.unit ?? '').trim(),
      (input.detail ?? '').trim(),
    ],
  );
  return { status: 'ok', data: rowToLog(inserted.rows[0] as LogRow) };
}

export async function listCareLogs(
  userId: number,
  profileId: number,
  filters: CareLogFilters = {},
): Promise<CareLog[]> {
  return queryLogs(userId, profileId, filters);
}

export async function updateCareLog(
  userId: number,
  logId: number,
  patch: CareLogPatch,
): Promise<CareResult<CareLog>> {
  const sets: string[] = [];
  const params: unknown[] = [logId, userId];

  if (patch.kind !== undefined) {
    params.push(patch.kind);
    sets.push(`kind = $${params.length}`);
  }
  if (patch.loggedAt !== undefined) {
    const loggedAt = parseLoggedAt(patch.loggedAt);
    if (!loggedAt) return { status: 'invalid', reason: 'logged_at' };
    params.push(loggedAt);
    sets.push(`logged_at = $${params.length}::timestamptz`);
  }
  if (patch.label !== undefined) {
    params.push(patch.label.trim());
    sets.push(`label = $${params.length}`);
  }
  if (patch.value !== undefined) {
    if (patch.value !== null && !Number.isFinite(patch.value)) {
      return { status: 'invalid', reason: 'value' };
    }
    params.push(patch.value);
    sets.push(`value = $${params.length}`);
  }
  if (patch.unit !== undefined) {
    params.push(patch.unit.trim());
    sets.push(`unit = $${params.length}`);
  }
  if (patch.detail !== undefined) {
    params.push(patch.detail.trim());
    sets.push(`detail = $${params.length}`);
  }
  if (sets.length === 0) return { status: 'invalid', reason: 'empty' };

  const result = await query(
    `UPDATE care_logs SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
    params,
  );
  if (result.rows.length === 0) return { status: 'not_found' };
  return { status: 'ok', data: rowToLog(result.rows[0] as LogRow) };
}

export async function deleteCareLog(userId: number, logId: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM care_logs WHERE id = $1 AND user_id = $2 RETURNING id',
    [logId, userId],
  );
  return result.rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* Measurement trend + printable daily log                            */
/* ------------------------------------------------------------------ */

export async function getCareMeasurementTrend(
  userId: number,
  profileId: number,
  options: { label?: string; from?: string; to?: string; timezone?: string } = {},
): Promise<CareResult<CareMeasurementTrend>> {
  const profile = await getCareProfile(userId, profileId);
  if (!profile) return { status: 'not_found' };

  const timezone = options.timezone ?? FALLBACK_TIMEZONE;
  const conditions = ['user_id = $1', 'profile_id = $2', 'value IS NOT NULL'];
  const params: unknown[] = [userId, profileId];
  if (options.label) {
    params.push(options.label.trim());
    conditions.push(`label = $${params.length}`);
  }
  if (options.from) {
    params.push(new Date(localMidnightMs(options.from, timezone)).toISOString());
    conditions.push(`logged_at >= $${params.length}::timestamptz`);
  }
  if (options.to) {
    params.push(new Date(localMidnightMs(addDaysYmd(options.to, 1), timezone)).toISOString());
    conditions.push(`logged_at < $${params.length}::timestamptz`);
  }

  const result = await query(
    `SELECT * FROM care_logs
     WHERE ${conditions.join(' AND ')}
     ORDER BY logged_at ASC, id ASC LIMIT ${CARE_LIST_LIMIT}`,
    params,
  );
  const points: MeasurePoint[] = result.rows.map((row) => {
    const log = rowToLog(row as LogRow);
    return { at: log.loggedAt, value: log.value ?? 0, unit: log.unit === '' ? null : log.unit };
  });

  return {
    status: 'ok',
    data: {
      profileId,
      label: options.label ?? null,
      from: options.from ?? null,
      to: options.to ?? null,
      timezone,
      trend: computeMeasureTrend(points),
    },
  };
}

export async function getCareDailyLog(
  userId: number,
  profileId: number,
  date: string,
  options: { timezone?: string } = {},
): Promise<CareDailyLog | null> {
  const profile = await getCareProfile(userId, profileId);
  if (!profile) return null;

  const timezone = options.timezone ?? FALLBACK_TIMEZONE;
  const events = await queryLogs(userId, profileId, {
    from: date,
    to: date,
    timezone,
    order: 'asc',
  });
  const totals = countByKind(events);
  return {
    profile,
    date,
    timezone,
    events,
    totals,
    text: formatCareDailyLog(profile, date, events, timezone),
  };
}
