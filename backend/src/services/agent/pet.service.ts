/**
 * Task 155: pet care records.
 *
 * Model:
 *  - `pets`: profile (name, species, breed, birth date, weight, notes).
 *  - `pet_logs`: weight / feeding / vet history (weight points feed the trend view).
 *  - `pet_schedules`: vaccination + deworming schedule. A one-shot row is retired
 *    via `completed_at`; a recurring row (`interval_days`) rolls `due_date` forward
 *    on completion, so the due-reminder scan always reads one due date.
 *
 * Reminder plumbing reuses the existing repo patterns where possible:
 *  - the same local-day helpers as the routines (`localDateIn` in local-day.ts,
 *    timezone resolved by the route through the existing getUserTimezone());
 *  - the same "upcoming window" semantics as `listUpcomingExpiryItems`
 *    (`due_date <= today + days`, overdue always included), with a per-schedule
 *    `reminder_days_before` lead;
 *  - `evaluatePetScheduleReminders` is pure, like `evaluateParcelReminders`, so a
 *    future cron/inbox dispatcher can consume it without DB access.
 *
 * All queries are user_id scoped; another user's pet is indistinguishable from a
 * missing one (404 at the route layer).
 */
import { query } from '../../db/index.js';
import { FALLBACK_TIMEZONE } from '../../utils/timezone.js';
import {
  addDaysYmd,
  isValidYmd,
  localDateIn,
  localMidnightMs,
  toIsoString,
  toYmdString,
  ymdDiffDays,
} from './local-day.js';
import { computeMeasureTrend, type MeasurePoint, type MeasureTrend } from './measure-trend.js';

export const PET_LOG_KINDS = ['weight', 'feeding', 'vet'] as const;
export type PetLogKind = (typeof PET_LOG_KINDS)[number];

export const PET_SCHEDULE_KINDS = ['vaccination', 'deworming'] as const;
export type PetScheduleKind = (typeof PET_SCHEDULE_KINDS)[number];

export const PET_LIST_LIMIT = 500;
export const DEFAULT_PET_REMINDER_WINDOW_DAYS = 30;

export type PetResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'not_found' }
  | { status: 'invalid'; reason: string };

export interface Pet {
  id: number;
  userId: number;
  name: string;
  species: string;
  breed: string;
  birthDate: string | null;
  weightKg: number | null;
  /** Latest kind='weight' log, falling back to the profile weight. */
  latestWeightKg: number | null;
  /** Human age derived from birthDate ("2岁3个月"); null when unknown. */
  ageDisplay: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface PetInput {
  name: string;
  species?: string;
  breed?: string;
  birthDate?: string | null;
  weightKg?: number | null;
  notes?: string;
}

export interface PetPatch {
  name?: string;
  species?: string;
  breed?: string;
  birthDate?: string | null;
  weightKg?: number | null;
  notes?: string;
}

export interface PetLog {
  id: number;
  userId: number;
  petId: number;
  kind: PetLogKind;
  loggedAt: string;
  weightKg: number | null;
  detail: string;
  createdAt: string;
}

export interface PetLogInput {
  kind: PetLogKind;
  loggedAt?: string;
  weightKg?: number | null;
  detail?: string;
}

export interface PetLogFilters {
  kind?: PetLogKind;
  from?: string;
  to?: string;
  limit?: number;
  timezone?: string;
}

export interface PetSchedule {
  id: number;
  userId: number;
  petId: number;
  petName: string | null;
  kind: PetScheduleKind;
  name: string;
  dueDate: string;
  intervalDays: number | null;
  reminderDaysBefore: number;
  completedAt: string | null;
  lastCompletedAt: string | null;
  completionCount: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface PetScheduleInput {
  kind: PetScheduleKind;
  name: string;
  dueDate: string;
  intervalDays?: number | null;
  reminderDaysBefore?: number;
  notes?: string;
}

export interface PetSchedulePatch {
  name?: string;
  dueDate?: string;
  intervalDays?: number | null;
  reminderDaysBefore?: number;
  notes?: string;
  /** true = mark complete now; false = clear completed_at (reopen a one-shot). */
  completed?: boolean;
}

export interface PetScheduleReminder {
  scheduleId: number;
  petId: number;
  petName: string;
  kind: PetScheduleKind;
  name: string;
  dueDate: string;
  /** due_date - today (negative = overdue). */
  daysUntil: number;
  status: 'overdue' | 'due_soon';
  reminderDaysBefore: number;
}

interface PetRow {
  id: unknown;
  user_id: unknown;
  name: string;
  species: string | null;
  breed: string | null;
  birth_date: unknown;
  weight_kg: unknown;
  notes: string | null;
  created_at: unknown;
  updated_at: unknown;
  latest_weight_kg?: unknown;
}

interface PetLogRow {
  id: unknown;
  user_id: unknown;
  pet_id: unknown;
  kind: string;
  logged_at: unknown;
  weight_kg: unknown;
  detail: string | null;
  created_at: unknown;
}

interface PetScheduleRow {
  id: unknown;
  user_id: unknown;
  pet_id: unknown;
  pet_name?: string | null;
  kind: string;
  name: string;
  due_date: unknown;
  interval_days: unknown;
  reminder_days_before: unknown;
  completed_at: unknown;
  last_completed_at: unknown;
  completion_count: unknown;
  notes: string | null;
  created_at: unknown;
  updated_at: unknown;
}

function isPetLogKind(value: string): value is PetLogKind {
  return (PET_LOG_KINDS as readonly string[]).includes(value);
}

function isPetScheduleKind(value: string): value is PetScheduleKind {
  return (PET_SCHEDULE_KINDS as readonly string[]).includes(value);
}

function toNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

/** Human age from a YYYY-MM-DD birth date as of a YYYY-MM-DD day. */
export function formatPetAge(birthDate: string | null, asOfYmd: string): string | null {
  if (!birthDate || !isValidYmd(birthDate) || !isValidYmd(asOfYmd)) return null;
  if (asOfYmd < birthDate) return null;
  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number);
  const [year, month, day] = asOfYmd.split('-').map(Number);
  let months = (year - birthYear) * 12 + (month - birthMonth);
  if (day < birthDay) months -= 1;
  if (months < 0) return null;
  if (months >= 12) {
    const years = Math.floor(months / 12);
    const rest = months % 12;
    return rest > 0 ? `${years}岁${rest}个月` : `${years}岁`;
  }
  if (months > 0) return `${months}个月`;
  return `${ymdDiffDays(birthDate, asOfYmd)}天`;
}

function rowToPet(row: PetRow, asOfYmd: string): Pet {
  const birthDate = toYmdString(row.birth_date);
  const weightKg = toNumber(row.weight_kg);
  const latestWeightKg = toNumber(row.latest_weight_kg);
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name,
    species: row.species ?? '',
    breed: row.breed ?? '',
    birthDate,
    weightKg,
    latestWeightKg: latestWeightKg ?? weightKg,
    ageDisplay: formatPetAge(birthDate, asOfYmd),
    notes: row.notes ?? '',
    createdAt: toIsoString(row.created_at) ?? '',
    updatedAt: toIsoString(row.updated_at) ?? '',
  };
}

function rowToPetLog(row: PetLogRow): PetLog {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    petId: Number(row.pet_id),
    kind: isPetLogKind(row.kind) ? row.kind : 'vet',
    loggedAt: toIsoString(row.logged_at) ?? '',
    weightKg: toNumber(row.weight_kg),
    detail: row.detail ?? '',
    createdAt: toIsoString(row.created_at) ?? '',
  };
}

function rowToSchedule(row: PetScheduleRow): PetSchedule {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    petId: Number(row.pet_id),
    petName: row.pet_name ?? null,
    kind: isPetScheduleKind(row.kind) ? row.kind : 'vaccination',
    name: row.name,
    dueDate: toYmdString(row.due_date) ?? '',
    intervalDays: toNumber(row.interval_days),
    reminderDaysBefore: Number(row.reminder_days_before ?? 0),
    completedAt: toIsoString(row.completed_at),
    lastCompletedAt: toIsoString(row.last_completed_at),
    completionCount: Number(row.completion_count ?? 0),
    notes: row.notes ?? '',
    createdAt: toIsoString(row.created_at) ?? '',
    updatedAt: toIsoString(row.updated_at) ?? '',
  };
}

function parseTimestamp(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/* ------------------------------------------------------------------ */
/* Pet profiles                                                       */
/* ------------------------------------------------------------------ */

const PET_SELECT = `SELECT p.*, (
  SELECT l.weight_kg FROM pet_logs l
  WHERE l.pet_id = p.id AND l.kind = 'weight' AND l.weight_kg IS NOT NULL
  ORDER BY l.logged_at DESC, l.id DESC LIMIT 1
) AS latest_weight_kg
FROM pets p`;

export async function listPets(
  userId: number,
  options: { timezone?: string; now?: Date } = {},
): Promise<Pet[]> {
  const asOfYmd = localDateIn(options.now ?? new Date(), options.timezone ?? FALLBACK_TIMEZONE);
  const result = await query(
    `${PET_SELECT} WHERE p.user_id = $1 ORDER BY p.created_at ASC, p.id ASC`,
    [userId],
  );
  return result.rows.map((row) => rowToPet(row as PetRow, asOfYmd));
}

export async function getPet(
  userId: number,
  id: number,
  options: { timezone?: string; now?: Date } = {},
): Promise<Pet | null> {
  const asOfYmd = localDateIn(options.now ?? new Date(), options.timezone ?? FALLBACK_TIMEZONE);
  const result = await query(`${PET_SELECT} WHERE p.id = $1 AND p.user_id = $2`, [id, userId]);
  return result.rows.length > 0 ? rowToPet(result.rows[0] as PetRow, asOfYmd) : null;
}

function validatePetNumbers(input: PetInput | PetPatch): string | null {
  if (input.birthDate != null && !isValidYmd(input.birthDate)) return 'birth_date';
  if (input.weightKg != null && (!Number.isFinite(input.weightKg) || input.weightKg < 0 || input.weightKg > 500)) {
    return 'weight_kg';
  }
  return null;
}

export async function createPet(userId: number, input: PetInput): Promise<PetResult<Pet>> {
  const name = input.name.trim();
  if (name === '') return { status: 'invalid', reason: 'name' };
  const invalid = validatePetNumbers(input);
  if (invalid) return { status: 'invalid', reason: invalid };

  const inserted = await query(
    `INSERT INTO pets (user_id, name, species, breed, birth_date, weight_kg, notes)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7)
     RETURNING *`,
    [
      userId,
      name,
      (input.species ?? '').trim(),
      (input.breed ?? '').trim(),
      input.birthDate ?? null,
      input.weightKg ?? null,
      (input.notes ?? '').trim(),
    ],
  );
  return { status: 'ok', data: rowToPet(inserted.rows[0] as PetRow, localDateIn(new Date(), FALLBACK_TIMEZONE)) };
}

export async function updatePet(userId: number, id: number, patch: PetPatch): Promise<PetResult<Pet>> {
  const invalid = validatePetNumbers(patch);
  if (invalid) return { status: 'invalid', reason: invalid };

  const sets: string[] = [];
  const params: unknown[] = [id, userId];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === '') return { status: 'invalid', reason: 'name' };
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.species !== undefined) {
    params.push(patch.species.trim());
    sets.push(`species = $${params.length}`);
  }
  if (patch.breed !== undefined) {
    params.push(patch.breed.trim());
    sets.push(`breed = $${params.length}`);
  }
  if (patch.birthDate !== undefined) {
    params.push(patch.birthDate);
    sets.push(`birth_date = $${params.length}::date`);
  }
  if (patch.weightKg !== undefined) {
    params.push(patch.weightKg);
    sets.push(`weight_kg = $${params.length}`);
  }
  if (patch.notes !== undefined) {
    params.push(patch.notes.trim());
    sets.push(`notes = $${params.length}`);
  }
  if (sets.length === 0) return { status: 'invalid', reason: 'empty' };
  sets.push('updated_at = now()');

  const result = await query(
    `UPDATE pets SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
    params,
  );
  if (result.rows.length === 0) return { status: 'not_found' };
  const updated = await getPet(userId, Number(result.rows[0].id), {});
  return updated ? { status: 'ok', data: updated } : { status: 'not_found' };
}

export async function deletePet(userId: number, id: number): Promise<boolean> {
  const result = await query('DELETE FROM pets WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return result.rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* Weight / feeding / vet history                                     */
/* ------------------------------------------------------------------ */

export async function createPetLog(
  userId: number,
  petId: number,
  input: PetLogInput,
): Promise<PetResult<PetLog>> {
  const pet = await getPet(userId, petId);
  if (!pet) return { status: 'not_found' };

  let loggedAt: string | null = null;
  if (input.loggedAt !== undefined) {
    loggedAt = parseTimestamp(input.loggedAt);
    if (!loggedAt) return { status: 'invalid', reason: 'logged_at' };
  }
  if (input.kind === 'weight' && (input.weightKg == null || !Number.isFinite(input.weightKg) || input.weightKg <= 0)) {
    return { status: 'invalid', reason: 'weight_kg' };
  }
  if (input.weightKg != null && (!Number.isFinite(input.weightKg) || input.weightKg < 0 || input.weightKg > 500)) {
    return { status: 'invalid', reason: 'weight_kg' };
  }

  const inserted = await query(
    `INSERT INTO pet_logs (user_id, pet_id, kind, logged_at, weight_kg, detail)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6)
     RETURNING *`,
    [userId, petId, input.kind, loggedAt, input.weightKg ?? null, (input.detail ?? '').trim()],
  );
  return { status: 'ok', data: rowToPetLog(inserted.rows[0] as PetLogRow) };
}

export async function listPetLogs(
  userId: number,
  petId: number,
  filters: PetLogFilters = {},
): Promise<PetLog[]> {
  const timezone = filters.timezone ?? FALLBACK_TIMEZONE;
  const conditions = ['user_id = $1', 'pet_id = $2'];
  const params: unknown[] = [userId, petId];
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
  const limit = Math.min(Math.max(Math.round(filters.limit ?? PET_LIST_LIMIT), 1), PET_LIST_LIMIT);
  const result = await query(
    `SELECT * FROM pet_logs
     WHERE ${conditions.join(' AND ')}
     ORDER BY logged_at DESC, id DESC LIMIT ${limit}`,
    params,
  );
  return result.rows.map((row) => rowToPetLog(row as PetLogRow));
}

export async function deletePetLog(userId: number, logId: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM pet_logs WHERE id = $1 AND user_id = $2 RETURNING id',
    [logId, userId],
  );
  return result.rows.length > 0;
}

export async function getPetWeightHistory(
  userId: number,
  petId: number,
  options: { from?: string; to?: string; timezone?: string } = {},
): Promise<PetResult<{ petId: number; timezone: string; trend: MeasureTrend }>> {
  const pet = await getPet(userId, petId);
  if (!pet) return { status: 'not_found' };

  const timezone = options.timezone ?? FALLBACK_TIMEZONE;
  const conditions = ['user_id = $1', 'pet_id = $2', "kind = 'weight'", 'weight_kg IS NOT NULL'];
  const params: unknown[] = [userId, petId];
  if (options.from) {
    params.push(new Date(localMidnightMs(options.from, timezone)).toISOString());
    conditions.push(`logged_at >= $${params.length}::timestamptz`);
  }
  if (options.to) {
    params.push(new Date(localMidnightMs(addDaysYmd(options.to, 1), timezone)).toISOString());
    conditions.push(`logged_at < $${params.length}::timestamptz`);
  }

  const result = await query(
    `SELECT * FROM pet_logs
     WHERE ${conditions.join(' AND ')}
     ORDER BY logged_at ASC, id ASC LIMIT ${PET_LIST_LIMIT}`,
    params,
  );
  const points: MeasurePoint[] = result.rows.map((row) => {
    const log = rowToPetLog(row as PetLogRow);
    return { at: log.loggedAt, value: log.weightKg ?? 0, unit: 'kg' };
  });

  return { status: 'ok', data: { petId, timezone, trend: computeMeasureTrend(points) } };
}

/* ------------------------------------------------------------------ */
/* Vaccination / deworming schedule                                   */
/* ------------------------------------------------------------------ */

export async function listPetSchedules(userId: number, petId?: number): Promise<PetSchedule[]> {
  const conditions = ['s.user_id = $1'];
  const params: unknown[] = [userId];
  if (petId !== undefined) {
    params.push(petId);
    conditions.push(`s.pet_id = $${params.length}`);
  }
  const result = await query(
    `SELECT s.*, p.name AS pet_name FROM pet_schedules s
     JOIN pets p ON p.id = s.pet_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.due_date ASC, s.id ASC LIMIT ${PET_LIST_LIMIT}`,
    params,
  );
  return result.rows.map((row) => rowToSchedule(row as PetScheduleRow));
}

export async function getPetSchedule(userId: number, id: number): Promise<PetSchedule | null> {
  const result = await query(
    `SELECT s.*, p.name AS pet_name FROM pet_schedules s
     JOIN pets p ON p.id = s.pet_id
     WHERE s.id = $1 AND s.user_id = $2`,
    [id, userId],
  );
  return result.rows.length > 0 ? rowToSchedule(result.rows[0] as PetScheduleRow) : null;
}

export async function createPetSchedule(
  userId: number,
  petId: number,
  input: PetScheduleInput,
): Promise<PetResult<PetSchedule>> {
  const pet = await getPet(userId, petId);
  if (!pet) return { status: 'not_found' };
  const name = input.name.trim();
  if (name === '') return { status: 'invalid', reason: 'name' };
  if (!isValidYmd(input.dueDate)) return { status: 'invalid', reason: 'due_date' };
  if (input.intervalDays != null && (!Number.isInteger(input.intervalDays) || input.intervalDays <= 0)) {
    return { status: 'invalid', reason: 'interval_days' };
  }
  if (
    input.reminderDaysBefore !== undefined &&
    (!Number.isInteger(input.reminderDaysBefore) || input.reminderDaysBefore < 0 || input.reminderDaysBefore > 365)
  ) {
    return { status: 'invalid', reason: 'reminder_days_before' };
  }

  const inserted = await query(
    `INSERT INTO pet_schedules
       (user_id, pet_id, kind, name, due_date, interval_days, reminder_days_before, notes)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8)
     RETURNING *`,
    [
      userId,
      petId,
      input.kind,
      name,
      input.dueDate,
      input.intervalDays ?? null,
      input.reminderDaysBefore ?? (input.kind === 'deworming' ? 3 : 14),
      (input.notes ?? '').trim(),
    ],
  );
  return { status: 'ok', data: rowToSchedule({ ...(inserted.rows[0] as PetScheduleRow), pet_name: pet.name }) };
}

export async function updatePetSchedule(
  userId: number,
  id: number,
  patch: PetSchedulePatch,
): Promise<PetResult<PetSchedule>> {
  const sets: string[] = [];
  const params: unknown[] = [id, userId];

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === '') return { status: 'invalid', reason: 'name' };
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.dueDate !== undefined) {
    if (!isValidYmd(patch.dueDate)) return { status: 'invalid', reason: 'due_date' };
    params.push(patch.dueDate);
    sets.push(`due_date = $${params.length}::date`);
  }
  if (patch.intervalDays !== undefined) {
    if (patch.intervalDays !== null && (!Number.isInteger(patch.intervalDays) || patch.intervalDays <= 0)) {
      return { status: 'invalid', reason: 'interval_days' };
    }
    params.push(patch.intervalDays);
    sets.push(`interval_days = $${params.length}`);
  }
  if (patch.reminderDaysBefore !== undefined) {
    if (!Number.isInteger(patch.reminderDaysBefore) || patch.reminderDaysBefore < 0 || patch.reminderDaysBefore > 365) {
      return { status: 'invalid', reason: 'reminder_days_before' };
    }
    params.push(patch.reminderDaysBefore);
    sets.push(`reminder_days_before = $${params.length}`);
  }
  if (patch.notes !== undefined) {
    params.push(patch.notes.trim());
    sets.push(`notes = $${params.length}`);
  }
  if (patch.completed !== undefined) {
    sets.push(patch.completed ? 'completed_at = now()' : 'completed_at = NULL');
  }
  if (sets.length === 0) return { status: 'invalid', reason: 'empty' };
  sets.push('updated_at = now()');

  const result = await query(
    `UPDATE pet_schedules SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2
     RETURNING *, (SELECT name FROM pets WHERE id = pet_id) AS pet_name`,
    params,
  );
  if (result.rows.length === 0) return { status: 'not_found' };
  return { status: 'ok', data: rowToSchedule(result.rows[0] as PetScheduleRow) };
}

/**
 * Complete a schedule. Recurring rows roll their due date forward (explicit
 * `nextDueDate` wins, otherwise due_date + interval_days); one-shot rows are
 * retired with completed_at.
 */
export async function completePetSchedule(
  userId: number,
  id: number,
  options: { at?: string; nextDueDate?: string } = {},
): Promise<PetResult<PetSchedule>> {
  const existing = await getPetSchedule(userId, id);
  if (!existing) return { status: 'not_found' };

  let atIso: string | null = null;
  if (options.at !== undefined) {
    atIso = parseTimestamp(options.at);
    if (!atIso) return { status: 'invalid', reason: 'at' };
  }
  if (options.nextDueDate !== undefined && !isValidYmd(options.nextDueDate)) {
    return { status: 'invalid', reason: 'next_due_date' };
  }

  if (existing.intervalDays === null) {
    const retired = await query(
      `UPDATE pet_schedules
       SET completed_at = COALESCE($3::timestamptz, now()),
           last_completed_at = COALESCE($3::timestamptz, now()),
           completion_count = completion_count + 1,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *, (SELECT name FROM pets WHERE id = pet_id) AS pet_name`,
      [id, userId, atIso],
    );
    return { status: 'ok', data: rowToSchedule(retired.rows[0] as PetScheduleRow) };
  }

  const nextDue = options.nextDueDate ?? addDaysYmd(existing.dueDate, existing.intervalDays);
  const rolled = await query(
    `UPDATE pet_schedules
     SET due_date = $3::date,
         last_completed_at = COALESCE($4::timestamptz, now()),
         completion_count = completion_count + 1,
         updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *, (SELECT name FROM pets WHERE id = pet_id) AS pet_name`,
    [id, userId, nextDue, atIso],
  );
  return { status: 'ok', data: rowToSchedule(rolled.rows[0] as PetScheduleRow) };
}

export async function deletePetSchedule(userId: number, id: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM pet_schedules WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId],
  );
  return result.rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* Due reminders (pure evaluation + DB wrapper)                       */
/* ------------------------------------------------------------------ */

/** Pure: schedules due within their per-row lead window (overdue always included). */
export function evaluatePetScheduleReminders(
  schedules: readonly PetSchedule[],
  todayYmd: string,
): PetScheduleReminder[] {
  const reminders: PetScheduleReminder[] = [];
  for (const schedule of schedules) {
    if (schedule.completedAt !== null || !isValidYmd(schedule.dueDate)) continue;
    const daysUntil = ymdDiffDays(todayYmd, schedule.dueDate);
    if (daysUntil > schedule.reminderDaysBefore) continue;
    reminders.push({
      scheduleId: schedule.id,
      petId: schedule.petId,
      petName: schedule.petName ?? '',
      kind: schedule.kind,
      name: schedule.name,
      dueDate: schedule.dueDate,
      daysUntil,
      status: daysUntil < 0 ? 'overdue' : 'due_soon',
      reminderDaysBefore: schedule.reminderDaysBefore,
    });
  }
  return reminders.sort((a, b) => a.daysUntil - b.daysUntil || a.scheduleId - b.scheduleId);
}

/** Reminders due for one user; window defaults to the next 30 local days. */
export async function listPetReminders(
  userId: number,
  options: { days?: number; timezone?: string; now?: Date } = {},
): Promise<PetScheduleReminder[]> {
  const timezone = options.timezone ?? FALLBACK_TIMEZONE;
  const rawDays = options.days ?? DEFAULT_PET_REMINDER_WINDOW_DAYS;
  const days = Number.isFinite(rawDays)
    ? Math.min(Math.max(Math.round(rawDays), 0), 366)
    : DEFAULT_PET_REMINDER_WINDOW_DAYS;
  const today = localDateIn(options.now ?? new Date(), timezone);
  const until = addDaysYmd(today, days);

  const schedules = await listPetSchedules(userId);
  const inWindow = schedules.filter(
    (schedule) => schedule.completedAt === null && schedule.dueDate <= until,
  );
  return evaluatePetScheduleReminders(inWindow, today);
}
