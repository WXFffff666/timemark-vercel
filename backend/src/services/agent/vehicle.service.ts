import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

/**
 * Task 156: vehicle fuel & maintenance ledger.
 *
 * One `vehicles` row per vehicle (make/model/year/plate + current odometer).
 * Fuel records carry quantity (litres or kWh), unit price, total cost and the
 * odometer reading. Consumption (L/100km or kWh/100km) and cost per km are
 * DERIVED from the distance to the previous odometer reading (tank-to-tank),
 * plus a ledger-level rolling summary.
 *
 * Maintenance records carry item/date/odometer/cost and an optional next-due
 * date and/or next-due odometer. `listVehicleDueReminders` evaluates those two
 * dimensions against a due-soon window (30 days / 500 km) - the same computed
 * reminder style as `parcel.service.ts`; no scheduler is involved.
 *
 * Privacy: the plate is partially identifying, so every log line only ever
 * carries `maskPlate(...)` output.
 */

const log = createLogger('vehicle');

export const DEFAULT_REMINDER_TIMEZONE = 'Asia/Shanghai';
export const VEHICLE_DUE_SOON_DAYS = 30;
export const VEHICLE_DUE_SOON_KM = 500;

export type FuelEnergyType = 'fuel' | 'electric';

export function isFuelEnergyType(value: unknown): value is FuelEnergyType {
  return value === 'fuel' || value === 'electric';
}

/** Mask a plate for logs/reminders: keep at most the last 2 characters. */
export function maskPlate(plate: string): string {
  const value = plate.trim();
  if (value.length === 0) return '**';
  if (value.length <= 2) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.min(8, value.length - 2))}${value.slice(-2)}`;
}

export interface Vehicle {
  id: number;
  make: string;
  model: string;
  year: number | null;
  plate: string;
  /** `****12` form - the only form that may appear in logs. */
  plateMasked: string;
  odometer: number;
  createdAt: string;
  updatedAt: string;
}

export interface VehicleInput {
  make: string;
  model?: string;
  year?: number | null;
  plate?: string;
  odometer?: number;
}

export interface VehiclePatch {
  make?: string;
  model?: string;
  year?: number | null;
  plate?: string;
  odometer?: number;
}

export type FuelUnit = 'L' | 'kWh';

export interface FuelRecord {
  id: number;
  vehicleId: number;
  date: string;
  energyType: FuelEnergyType;
  unit: FuelUnit;
  quantity: number;
  unitPrice: number;
  totalCost: number;
  odometer: number;
  note: string;
  createdAt: string;
}

export interface FuelRecordComputed extends FuelRecord {
  /** Distance since the previous odometer reading; null for the first record. */
  distanceKm: number | null;
  /** Litres (or kWh) per 100 km; null when there is no measurable distance. */
  consumptionPer100: number | null;
  /** Currency per km; null when there is no measurable distance. */
  costPerKm: number | null;
}

export interface FuelSummary {
  recordCount: number;
  totalQuantity: number;
  totalCost: number;
  totalDistanceKm: number;
  averageConsumptionPer100: number | null;
  averageCostPerKm: number | null;
}

export interface FuelLedger {
  records: FuelRecordComputed[];
  summary: FuelSummary;
}

export interface MaintenanceInput {
  item: string;
  date: string;
  odometer?: number | null;
  cost?: number;
  nextDueDate?: string | null;
  nextDueOdometer?: number | null;
  note?: string;
}

export interface MaintenanceRecord {
  id: number;
  vehicleId: number;
  item: string;
  date: string;
  odometer: number | null;
  cost: number;
  nextDueDate: string | null;
  nextDueOdometer: number | null;
  note: string;
  createdAt: string;
}

/** `ok` = outside the window, `due_soon` = inside it, `overdue` = past due. */
export type DueSeverity = 'ok' | 'due_soon' | 'overdue';

export interface MaintenanceRecordComputed extends MaintenanceRecord {
  dueStatus: DueSeverity;
  /** Calendar days until the next-due date (negative = overdue); null when unset. */
  daysUntilDue: number | null;
  /** Kilometres until the next-due odometer (negative = overdue); null when unset. */
  kmUntilDue: number | null;
}

export interface VehicleDueReminder {
  vehicleId: number;
  vehicleLabel: string;
  maintenanceId: number;
  item: string;
  dimension: 'date' | 'odometer';
  severity: 'due_soon' | 'overdue';
  dueDate: string | null;
  dueOdometer: number | null;
  currentOdometer: number;
  daysUntil: number | null;
  kmUntil: number | null;
  detail: string;
}

export interface MaintenanceLedger {
  records: MaintenanceRecordComputed[];
}

const VEHICLE_COLUMNS = 'id, make, model, year, plate, odometer, created_at, updated_at';
const FUEL_COLUMNS = `id, vehicle_id, to_char(recorded_on, 'YYYY-MM-DD') AS recorded_on, energy_type,
  quantity, unit_price, total_cost, odometer, note, created_at`;
const MAINTENANCE_COLUMNS = `id, vehicle_id, item, to_char(serviced_on, 'YYYY-MM-DD') AS serviced_on, odometer, cost,
  to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date, next_due_odometer, note, created_at`;

interface VehicleRow {
  id?: unknown;
  make?: unknown;
  model?: unknown;
  year?: unknown;
  plate?: unknown;
  odometer?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface FuelRow {
  id?: unknown;
  vehicle_id?: unknown;
  recorded_on?: unknown;
  energy_type?: unknown;
  quantity?: unknown;
  unit_price?: unknown;
  total_cost?: unknown;
  odometer?: unknown;
  note?: unknown;
  created_at?: unknown;
}

interface MaintenanceRow {
  id?: unknown;
  vehicle_id?: unknown;
  item?: unknown;
  serviced_on?: unknown;
  odometer?: unknown;
  cost?: unknown;
  next_due_date?: unknown;
  next_due_odometer?: unknown;
  note?: unknown;
  created_at?: unknown;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function rowToVehicle(row: VehicleRow): Vehicle {
  const plate = String(row.plate ?? '');
  return {
    id: Number(row.id),
    make: String(row.make ?? ''),
    model: String(row.model ?? ''),
    year: row.year == null ? null : Number(row.year),
    plate,
    plateMasked: maskPlate(plate),
    odometer: Number(row.odometer ?? 0),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

function rowToFuelRecord(row: FuelRow): FuelRecord {
  const energyType = isFuelEnergyType(row.energy_type) ? row.energy_type : 'fuel';
  return {
    id: Number(row.id),
    vehicleId: Number(row.vehicle_id),
    date: String(row.recorded_on ?? ''),
    energyType,
    unit: energyType === 'electric' ? 'kWh' : 'L',
    quantity: Number(row.quantity ?? 0),
    unitPrice: Number(row.unit_price ?? 0),
    totalCost: Number(row.total_cost ?? 0),
    odometer: Number(row.odometer ?? 0),
    note: String(row.note ?? ''),
    createdAt: toIso(row.created_at) ?? '',
  };
}

function rowToMaintenanceRecord(row: MaintenanceRow): MaintenanceRecord {
  return {
    id: Number(row.id),
    vehicleId: Number(row.vehicle_id),
    item: String(row.item ?? ''),
    date: String(row.serviced_on ?? ''),
    odometer: row.odometer == null ? null : Number(row.odometer),
    cost: Number(row.cost ?? 0),
    nextDueDate: row.next_due_date == null ? null : String(row.next_due_date),
    nextDueOdometer: row.next_due_odometer == null ? null : Number(row.next_due_odometer),
    note: String(row.note ?? ''),
    createdAt: toIso(row.created_at) ?? '',
  };
}

function ascendingByOdometer<T extends { odometer: number; date: string; id: number }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => a.odometer - b.odometer || a.date.localeCompare(b.date) || a.id - b.id);
}

function ymdToUtcMs(ymd: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Today's calendar date (YYYY-MM-DD) in the reminder timezone. */
export function todayYmd(nowMs: number = Date.now(), timeZone: string = DEFAULT_REMINDER_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(nowMs));
}

/**
 * Derive per-record distance / consumption / cost-per-km from consecutive
 * odometer readings. Consumption of a fill-up = its quantity over the distance
 * since the previous fill-up (tank-to-tank): `quantity / distance * 100`.
 * Cost per km = its total cost over the same distance. The first record only
 * establishes the baseline, so its distance and both derived values are null; a
 * non-increasing odometer is likewise not measurable instead of dividing by 0.
 *
 * `records` may arrive in display order (newest first); the returned array keeps
 * that order while the math runs on the odometer-ascending copy.
 */
export function computeFuelRecords(records: readonly FuelRecord[]): FuelRecordComputed[] {
  const ascending = ascendingByOdometer(records);
  const computed = new Map<number, FuelRecordComputed>();
  for (let i = 0; i < ascending.length; i++) {
    const record = ascending[i];
    const previous = i > 0 ? ascending[i - 1] : undefined;
    const distanceKm = previous ? record.odometer - previous.odometer : null;
    const measurable = distanceKm !== null && distanceKm > 0;
    computed.set(record.id, {
      ...record,
      distanceKm: measurable ? distanceKm : null,
      consumptionPer100: measurable ? round2((record.quantity / distanceKm) * 100) : null,
      costPerKm: measurable ? round2(record.totalCost / distanceKm) : null,
    });
  }
  return records.map(
    (record) =>
      computed.get(record.id) ?? { ...record, distanceKm: null, consumptionPer100: null, costPerKm: null },
  );
}

/**
 * Ledger summary. Both averages exclude the baseline fill-up (the odometer-ascending
 * first record) so quantity and cost cover exactly the measured distance.
 */
export function summarizeFuelRecords(records: readonly FuelRecord[]): FuelSummary {
  if (records.length === 0) {
    return {
      recordCount: 0,
      totalQuantity: 0,
      totalCost: 0,
      totalDistanceKm: 0,
      averageConsumptionPer100: null,
      averageCostPerKm: null,
    };
  }
  const ascending = ascendingByOdometer(records);
  const first = ascending[0];
  const last = ascending[ascending.length - 1];
  const tracked = ascending.slice(1);
  const totalDistanceKm = Math.max(0, last.odometer - first.odometer);
  const totalQuantity = round2(records.reduce((sum, record) => sum + record.quantity, 0));
  const totalCost = round2(records.reduce((sum, record) => sum + record.totalCost, 0));
  const trackedQuantity = tracked.reduce((sum, record) => sum + record.quantity, 0);
  const trackedCost = tracked.reduce((sum, record) => sum + record.totalCost, 0);
  return {
    recordCount: records.length,
    totalQuantity,
    totalCost,
    totalDistanceKm,
    averageConsumptionPer100:
      totalDistanceKm > 0 ? round2((trackedQuantity / totalDistanceKm) * 100) : null,
    averageCostPerKm: totalDistanceKm > 0 ? round2(trackedCost / totalDistanceKm) : null,
  };
}

function evaluateDueDimensions(
  record: Pick<MaintenanceRecord, 'nextDueDate' | 'nextDueOdometer'>,
  currentOdometer: number,
  today: string,
): { daysUntil: number | null; kmUntil: number | null; dateSeverity: DueSeverity; odometerSeverity: DueSeverity } {
  let daysUntil: number | null = null;
  let dateSeverity: DueSeverity = 'ok';
  if (record.nextDueDate) {
    const dueMs = ymdToUtcMs(record.nextDueDate);
    const todayMs = ymdToUtcMs(today);
    if (dueMs !== null && todayMs !== null) {
      daysUntil = Math.round((dueMs - todayMs) / 86_400_000);
      dateSeverity = daysUntil < 0 ? 'overdue' : daysUntil <= VEHICLE_DUE_SOON_DAYS ? 'due_soon' : 'ok';
    }
  }
  let kmUntil: number | null = null;
  let odometerSeverity: DueSeverity = 'ok';
  if (record.nextDueOdometer != null) {
    kmUntil = record.nextDueOdometer - currentOdometer;
    odometerSeverity = kmUntil <= 0 ? 'overdue' : kmUntil <= VEHICLE_DUE_SOON_KM ? 'due_soon' : 'ok';
  }
  return { daysUntil, kmUntil, dateSeverity, odometerSeverity };
}

function worseSeverity(a: DueSeverity, b: DueSeverity): DueSeverity {
  if (a === 'overdue' || b === 'overdue') return 'overdue';
  if (a === 'due_soon' || b === 'due_soon') return 'due_soon';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Vehicle CRUD
// ---------------------------------------------------------------------------

export async function createVehicle(userId: number, input: VehicleInput): Promise<Vehicle> {
  const result = await query(
    `INSERT INTO vehicles (user_id, make, model, year, plate, odometer)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${VEHICLE_COLUMNS}`,
    [userId, input.make, input.model ?? '', input.year ?? null, input.plate ?? '', input.odometer ?? 0],
  );
  const vehicle = rowToVehicle(result.rows[0] as VehicleRow);
  log.info({ event: 'vehicle.created', vehicleId: vehicle.id, plate: vehicle.plateMasked }, 'Vehicle created');
  return vehicle;
}

export async function listVehicles(userId: number): Promise<Vehicle[]> {
  const result = await query(
    `SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE user_id = $1 ORDER BY updated_at DESC, id DESC`,
    [userId],
  );
  return (result.rows as VehicleRow[]).map(rowToVehicle);
}

export async function getVehicle(userId: number, id: number): Promise<Vehicle | null> {
  const result = await query(`SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  const row = result.rows[0] as VehicleRow | undefined;
  return row ? rowToVehicle(row) : null;
}

export async function updateVehicle(userId: number, id: number, patch: VehiclePatch): Promise<Vehicle | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.make !== undefined) {
    values.push(patch.make);
    sets.push(`make = $${values.length}`);
  }
  if (patch.model !== undefined) {
    values.push(patch.model);
    sets.push(`model = $${values.length}`);
  }
  if (patch.year !== undefined) {
    values.push(patch.year);
    sets.push(`year = $${values.length}`);
  }
  if (patch.plate !== undefined) {
    values.push(patch.plate);
    sets.push(`plate = $${values.length}`);
  }
  if (patch.odometer !== undefined) {
    values.push(patch.odometer);
    sets.push(`odometer = $${values.length}`);
  }
  if (sets.length === 0) return getVehicle(userId, id);

  sets.push('updated_at = now()');
  values.push(id);
  const idIndex = values.length;
  values.push(userId);
  const userIndex = values.length;

  const result = await query(
    `UPDATE vehicles SET ${sets.join(', ')} WHERE id = $${idIndex} AND user_id = $${userIndex} RETURNING ${VEHICLE_COLUMNS}`,
    values,
  );
  const row = result.rows[0] as VehicleRow | undefined;
  if (!row) return null;
  log.info(
    { event: 'vehicle.updated', vehicleId: id, plate: maskPlate(String(row.plate ?? '')) },
    'Vehicle updated',
  );
  return rowToVehicle(row);
}

export async function deleteVehicle(userId: number, id: number): Promise<boolean> {
  const result = await query('DELETE FROM vehicles WHERE id = $1 AND user_id = $2', [id, userId]);
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) log.info({ event: 'vehicle.deleted', vehicleId: id }, 'Vehicle deleted');
  return deleted;
}

/** Keep the vehicle profile's odometer at the highest reading ever recorded. */
async function bumpVehicleOdometer(userId: number, vehicleId: number, odometer: number): Promise<void> {
  await query(
    'UPDATE vehicles SET odometer = GREATEST(odometer, $3), updated_at = now() WHERE id = $1 AND user_id = $2',
    [vehicleId, userId, odometer],
  ).catch((error) =>
    log.warn({ event: 'vehicle.odometer_bump_failed', vehicleId, err: error }, 'Odometer bump failed'),
  );
}

// ---------------------------------------------------------------------------
// Fuel ledger
// ---------------------------------------------------------------------------

export async function createFuelRecord(
  userId: number,
  vehicleId: number,
  input: {
    date: string;
    energyType?: FuelEnergyType;
    quantity: number;
    unitPrice?: number;
    totalCost?: number;
    odometer: number;
    note?: string;
  },
): Promise<FuelRecord | null> {
  const vehicle = await getVehicle(userId, vehicleId);
  if (!vehicle) return null;

  const energyType = input.energyType ?? 'fuel';
  const totalCost = input.totalCost ?? round2(input.quantity * (input.unitPrice ?? 0));
  const result = await query(
    `INSERT INTO vehicle_fuel_records
       (user_id, vehicle_id, recorded_on, energy_type, quantity, unit_price, total_cost, odometer, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${FUEL_COLUMNS}`,
    [
      userId,
      vehicleId,
      input.date,
      energyType,
      input.quantity,
      input.unitPrice ?? 0,
      totalCost,
      input.odometer,
      input.note ?? '',
    ],
  );
  await bumpVehicleOdometer(userId, vehicleId, input.odometer);
  const record = rowToFuelRecord(result.rows[0] as FuelRow);
  log.info(
    { event: 'vehicle.fuel_created', vehicleId, recordId: record.id, unit: record.unit },
    'Fuel record created',
  );
  return record;
}

export async function getFuelLedger(userId: number, vehicleId: number): Promise<FuelLedger | null> {
  const vehicle = await getVehicle(userId, vehicleId);
  if (!vehicle) return null;
  const result = await query(
    `SELECT ${FUEL_COLUMNS} FROM vehicle_fuel_records
     WHERE user_id = $1 AND vehicle_id = $2
     ORDER BY recorded_on DESC, id DESC`,
    [userId, vehicleId],
  );
  const records = (result.rows as FuelRow[]).map(rowToFuelRecord);
  return { records: computeFuelRecords(records), summary: summarizeFuelRecords(records) };
}

export async function deleteFuelRecord(
  userId: number,
  vehicleId: number,
  recordId: number,
): Promise<boolean> {
  const result = await query(
    'DELETE FROM vehicle_fuel_records WHERE id = $1 AND vehicle_id = $2 AND user_id = $3',
    [recordId, vehicleId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Maintenance ledger
// ---------------------------------------------------------------------------

export async function createMaintenanceRecord(
  userId: number,
  vehicleId: number,
  input: MaintenanceInput,
): Promise<MaintenanceRecord | null> {
  const vehicle = await getVehicle(userId, vehicleId);
  if (!vehicle) return null;

  const result = await query(
    `INSERT INTO vehicle_maintenance_records
       (user_id, vehicle_id, item, serviced_on, odometer, cost, next_due_date, next_due_odometer, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${MAINTENANCE_COLUMNS}`,
    [
      userId,
      vehicleId,
      input.item,
      input.date,
      input.odometer ?? null,
      input.cost ?? 0,
      input.nextDueDate ?? null,
      input.nextDueOdometer ?? null,
      input.note ?? '',
    ],
  );
  if (input.odometer != null) await bumpVehicleOdometer(userId, vehicleId, input.odometer);
  const record = rowToMaintenanceRecord(result.rows[0] as MaintenanceRow);
  log.info(
    { event: 'vehicle.maintenance_created', vehicleId, recordId: record.id, hasNextDue: record.nextDueDate != null || record.nextDueOdometer != null },
    'Maintenance record created',
  );
  return record;
}

export async function getMaintenanceLedger(
  userId: number,
  vehicleId: number,
  nowMs: number = Date.now(),
): Promise<MaintenanceLedger | null> {
  const vehicle = await getVehicle(userId, vehicleId);
  if (!vehicle) return null;
  const result = await query(
    `SELECT ${MAINTENANCE_COLUMNS} FROM vehicle_maintenance_records
     WHERE user_id = $1 AND vehicle_id = $2
     ORDER BY serviced_on DESC, id DESC`,
    [userId, vehicleId],
  );
  const today = todayYmd(nowMs);
  const records = (result.rows as MaintenanceRow[]).map((row) => {
    const record = rowToMaintenanceRecord(row);
    const { daysUntil, kmUntil, dateSeverity, odometerSeverity } = evaluateDueDimensions(
      record,
      vehicle.odometer,
      today,
    );
    return {
      ...record,
      dueStatus: worseSeverity(dateSeverity, odometerSeverity),
      daysUntilDue: daysUntil,
      kmUntilDue: kmUntil,
    };
  });
  return { records };
}

export async function deleteMaintenanceRecord(
  userId: number,
  vehicleId: number,
  recordId: number,
): Promise<boolean> {
  const result = await query(
    'DELETE FROM vehicle_maintenance_records WHERE id = $1 AND vehicle_id = $2 AND user_id = $3',
    [recordId, vehicleId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Due/overdue maintenance across all vehicles, evaluated against the clock. */
export async function listVehicleDueReminders(
  userId: number,
  nowMs: number = Date.now(),
): Promise<VehicleDueReminder[]> {
  const result = await query(
    `SELECT v.id AS vehicle_id, v.make, v.model, v.odometer AS current_odometer,
            m.id AS maintenance_id, m.item,
            to_char(m.next_due_date, 'YYYY-MM-DD') AS next_due_date, m.next_due_odometer
     FROM vehicles v
     JOIN vehicle_maintenance_records m ON m.vehicle_id = v.id AND m.user_id = v.user_id
     WHERE v.user_id = $1 AND (m.next_due_date IS NOT NULL OR m.next_due_odometer IS NOT NULL)
     ORDER BY v.id ASC, m.next_due_date ASC NULLS LAST, m.id ASC`,
    [userId],
  );

  const today = todayYmd(nowMs);
  const reminders: VehicleDueReminder[] = [];

  for (const raw of result.rows as Array<Record<string, unknown>>) {
    const vehicleId = Number(raw.vehicle_id);
    const maintenanceId = Number(raw.maintenance_id);
    const item = String(raw.item ?? '');
    const currentOdometer = Number(raw.current_odometer ?? 0);
    const dueDate = raw.next_due_date == null ? null : String(raw.next_due_date);
    const dueOdometer = raw.next_due_odometer == null ? null : Number(raw.next_due_odometer);
    const vehicleLabel = `${String(raw.make ?? '')} ${String(raw.model ?? '')}`.trim() || `车辆 #${vehicleId}`;
    const { daysUntil, kmUntil, dateSeverity, odometerSeverity } = evaluateDueDimensions(
      { nextDueDate: dueDate, nextDueOdometer: dueOdometer },
      currentOdometer,
      today,
    );

    if (dateSeverity !== 'ok') {
      reminders.push({
        vehicleId,
        vehicleLabel,
        maintenanceId,
        item,
        dimension: 'date',
        severity: dateSeverity,
        dueDate,
        dueOdometer,
        currentOdometer,
        daysUntil,
        kmUntil,
        detail:
          dateSeverity === 'overdue'
            ? `保养「${item}」已于 ${dueDate} 到期`
            : `保养「${item}」还有 ${daysUntil} 天到期（${dueDate}）`,
      });
    }
    if (odometerSeverity !== 'ok') {
      reminders.push({
        vehicleId,
        vehicleLabel,
        maintenanceId,
        item,
        dimension: 'odometer',
        severity: odometerSeverity,
        dueDate,
        dueOdometer,
        currentOdometer,
        daysUntil,
        kmUntil,
        detail:
          odometerSeverity === 'overdue'
            ? `保养「${item}」已超过建议里程 ${Math.abs(kmUntil ?? 0)} km`
            : `保养「${item}」还有 ${kmUntil} km 到期（${dueOdometer} km）`,
      });
    }
  }

  return reminders;
}
