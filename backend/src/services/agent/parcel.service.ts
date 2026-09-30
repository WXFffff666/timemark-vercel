import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { createEgressGuard, EgressBlockedError, type EgressGuard } from './egress-guard.service.js';

/**
 * Task 152: parcel / logistics tracking.
 *
 * Model: one `parcels` row per shipment - carrier, tracking number, label, status,
 * last event (+ timestamp), ETA. Status is moved either by a MANUAL update (the user
 * taps "派送中") or by adapter POLLING through the injected `CarrierAdapter` seam.
 *
 * No site scraping: carriers whose terms forbid automated querying are served by the
 * `StubCarrierAdapter`, which reports `unsupported`; real adapters must fetch through
 * the egress-guarded `fetch` they receive, so a host is only reachable when the
 * deployment allowlists it (EGRESS_ALLOWED_HOSTS).
 *
 * Privacy: the tracking number is a secret. It is NEVER logged in the clear - every
 * log line and reminder carries `maskTrackingNumber(...)` output only.
 */

const log = createLogger('parcel');

export const PARCEL_STATUSES = ['registered', 'in_transit', 'out_for_delivery', 'delivered', 'exception'] as const;
export type ParcelStatus = (typeof PARCEL_STATUSES)[number];

export const PARCEL_STATUS_LABELS: Record<ParcelStatus, string> = {
  registered: '已登记',
  in_transit: '运输中',
  out_for_delivery: '派送中',
  delivered: '已签收',
  exception: '异常',
};

/** No new event for this many days (while not delivered) = stalled reminder. */
export const PARCEL_STALL_DAYS = 3;
export const PARCEL_STALL_MS = PARCEL_STALL_DAYS * 24 * 60 * 60 * 1000;

export interface Parcel {
  id: number;
  carrier: string;
  trackingNumber: string;
  /** `****1234` form - the only form that may appear in logs/reminders. */
  trackingNumberMasked: string;
  label: string;
  status: ParcelStatus;
  lastEvent: string | null;
  lastEventAt: string | null;
  eta: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParcelCreateInput {
  carrier: string;
  trackingNumber: string;
  label?: string;
  eta?: string;
  lastEvent?: string;
}

export interface ParcelUpdateInput {
  status?: ParcelStatus;
  label?: string;
  eta?: string | null;
  lastEvent?: string;
}

/** Mask a tracking number for logs/UI: keep at most the last 4 characters. */
export function maskTrackingNumber(trackingNumber: string): string {
  const value = trackingNumber.trim();
  if (value.length === 0) return '****';
  if (value.length <= 4) return '*'.repeat(value.length);
  const hidden = '*'.repeat(Math.min(8, value.length - 4));
  return `${hidden}${value.slice(-4)}`;
}

export function isParcelStatus(value: unknown): value is ParcelStatus {
  return typeof value === 'string' && (PARCEL_STATUSES as readonly string[]).includes(value);
}

const PARCEL_COLUMNS = `id, carrier, tracking_number, label, status, last_event, last_event_at,
  to_char(eta, 'YYYY-MM-DD') AS eta, created_at, updated_at`;

interface ParcelRow {
  id?: unknown;
  carrier?: unknown;
  tracking_number?: unknown;
  label?: unknown;
  status?: unknown;
  last_event?: unknown;
  last_event_at?: unknown;
  eta?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowToParcel(row: ParcelRow): Parcel {
  const trackingNumber = String(row.tracking_number ?? '');
  return {
    id: Number(row.id),
    carrier: String(row.carrier ?? ''),
    trackingNumber,
    trackingNumberMasked: maskTrackingNumber(trackingNumber),
    label: String(row.label ?? ''),
    status: isParcelStatus(row.status) ? row.status : 'registered',
    lastEvent: row.last_event == null ? null : String(row.last_event),
    lastEventAt: toIso(row.last_event_at),
    eta: row.eta == null ? null : String(row.eta),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

/** Raised when (user, carrier, tracking number) is already tracked. */
export class ParcelConflictError extends Error {
  constructor() {
    super('parcel already tracked');
    this.name = 'ParcelConflictError';
  }
}

export async function createParcel(userId: number, input: ParcelCreateInput): Promise<Parcel> {
  const result = await query(
    `INSERT INTO parcels (user_id, carrier, tracking_number, label, eta, last_event, last_event_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (user_id, carrier, tracking_number) DO NOTHING
     RETURNING ${PARCEL_COLUMNS}`,
    [
      userId,
      input.carrier,
      input.trackingNumber,
      input.label ?? '',
      input.eta ?? null,
      input.lastEvent ?? null,
    ],
  );
  const row = result.rows[0] as ParcelRow | undefined;
  if (!row) throw new ParcelConflictError();
  log.info(
    {
      event: 'parcel.created',
      parcelId: Number(row.id),
      carrier: input.carrier,
      tracking: maskTrackingNumber(input.trackingNumber),
    },
    'Parcel created',
  );
  return rowToParcel(row);
}

export async function listParcels(userId: number): Promise<Parcel[]> {
  const result = await query(
    `SELECT ${PARCEL_COLUMNS} FROM parcels WHERE user_id = $1
     ORDER BY CASE status
       WHEN 'out_for_delivery' THEN 0
       WHEN 'in_transit' THEN 1
       WHEN 'registered' THEN 2
       WHEN 'exception' THEN 3
       ELSE 4
     END, updated_at DESC`,
    [userId],
  );
  return (result.rows as ParcelRow[]).map(rowToParcel);
}

export async function getParcel(userId: number, id: number): Promise<Parcel | null> {
  const result = await query(
    `SELECT ${PARCEL_COLUMNS} FROM parcels WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  const row = result.rows[0] as ParcelRow | undefined;
  return row ? rowToParcel(row) : null;
}

export async function updateParcel(userId: number, id: number, patch: ParcelUpdateInput): Promise<Parcel | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.label !== undefined) {
    values.push(patch.label);
    sets.push(`label = $${values.length}`);
  }
  if (patch.eta !== undefined) {
    values.push(patch.eta);
    sets.push(`eta = $${values.length}`);
  }
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
    // A manual status update IS the latest event unless the caller supplies one.
    values.push(patch.lastEvent ?? PARCEL_STATUS_LABELS[patch.status]);
    sets.push(`last_event = $${values.length}`);
    sets.push(`last_event_at = now()`);
  } else if (patch.lastEvent !== undefined) {
    values.push(patch.lastEvent);
    sets.push(`last_event = $${values.length}`);
    sets.push(`last_event_at = now()`);
  }
  if (sets.length === 0) return getParcel(userId, id);

  sets.push(`updated_at = now()`);
  values.push(id);
  const idIndex = values.length;
  values.push(userId);
  const userIndex = values.length;

  const result = await query(
    `UPDATE parcels SET ${sets.join(', ')} WHERE id = $${idIndex} AND user_id = $${userIndex} RETURNING ${PARCEL_COLUMNS}`,
    values,
  );
  const row = result.rows[0] as ParcelRow | undefined;
  if (!row) return null;
  if (patch.status !== undefined) {
    log.info(
      { event: 'parcel.status_updated', parcelId: id, status: patch.status, tracking: maskTrackingNumber(String(row.tracking_number ?? '')) },
      'Parcel status updated',
    );
  }
  return rowToParcel(row);
}

export async function deleteParcel(userId: number, id: number): Promise<boolean> {
  const result = await query(`DELETE FROM parcels WHERE id = $1 AND user_id = $2`, [id, userId]);
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) log.info({ event: 'parcel.deleted', parcelId: id }, 'Parcel deleted');
  return deleted;
}

// ---------------------------------------------------------------------------
// CarrierAdapter seam (optional polling)
// ---------------------------------------------------------------------------

export interface CarrierPollResult {
  /** False = this carrier is not pollable (no scraping of sites that forbid it). */
  supported: boolean;
  status?: ParcelStatus;
  lastEvent?: string;
  eta?: string | null;
}

/**
 * The polling seam. `guardedFetch` is the egress-guarded fetch; adapters MUST use it
 * (and nothing else) so every outbound call passes the allowlist + per-call cap.
 */
export interface CarrierAdapter {
  readonly carrier: string;
  poll(trackingNumber: string, guardedFetch: EgressGuard['fetch']): Promise<CarrierPollResult>;
}

/** Default adapter: reports `unsupported` without any network access. */
export class StubCarrierAdapter implements CarrierAdapter {
  constructor(readonly carrier: string) {}

  async poll(): Promise<CarrierPollResult> {
    return { supported: false };
  }
}

const carrierAdapters = new Map<string, CarrierAdapter>();

export function registerCarrierAdapter(adapter: CarrierAdapter): void {
  carrierAdapters.set(adapter.carrier.trim().toLowerCase(), adapter);
}

export function getCarrierAdapter(carrier: string): CarrierAdapter {
  return carrierAdapters.get(carrier.trim().toLowerCase()) ?? new StubCarrierAdapter(carrier);
}

export type ParcelRefreshResult =
  | { updated: true; parcel: Parcel }
  | { updated: false; reason: 'unsupported' | 'not_found' | 'blocked' | 'error' | 'unchanged' };

/** Poll one parcel through its carrier adapter; unsupported/blocked are non-errors. */
export async function refreshParcel(
  userId: number,
  id: number,
  deps: { guard?: Pick<EgressGuard, 'fetch'> } = {},
): Promise<ParcelRefreshResult> {
  const parcel = await getParcel(userId, id);
  if (!parcel) return { updated: false, reason: 'not_found' };

  const adapter = getCarrierAdapter(parcel.carrier);
  const guard = deps.guard ?? createEgressGuard();
  let result: CarrierPollResult;
  try {
    result = await adapter.poll(parcel.trackingNumber, guard.fetch);
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      log.warn(
        {
          event: 'parcel.refresh_blocked',
          parcelId: id,
          carrier: parcel.carrier,
          tracking: parcel.trackingNumberMasked,
          host: error.host,
          code: error.code,
        },
        'Parcel refresh blocked by the egress guard',
      );
      return { updated: false, reason: 'blocked' };
    }
    log.warn(
      { event: 'parcel.refresh_failed', parcelId: id, carrier: parcel.carrier, tracking: parcel.trackingNumberMasked, err: error },
      'Parcel refresh failed',
    );
    return { updated: false, reason: 'error' };
  }

  if (!result.supported) return { updated: false, reason: 'unsupported' };

  const patch: ParcelUpdateInput = {};
  if (result.status !== undefined && result.status !== parcel.status) patch.status = result.status;
  if (result.lastEvent !== undefined) patch.lastEvent = result.lastEvent;
  if (result.eta !== undefined) patch.eta = result.eta;
  if (Object.keys(patch).length === 0) return { updated: false, reason: 'unchanged' };

  const updated = await updateParcel(userId, id, patch);
  return updated ? { updated: true, parcel: updated } : { updated: false, reason: 'not_found' };
}

// ---------------------------------------------------------------------------
// Reminders: out for delivery / stalled
// ---------------------------------------------------------------------------

export type ParcelReminderKind = 'out_for_delivery' | 'stalled';

export interface ParcelReminder {
  parcelId: number;
  kind: ParcelReminderKind;
  title: string;
  detail: string;
  carrier: string;
  parcelLabel: string;
  trackingNumberMasked: string;
  eta: string | null;
}

/**
 * Pure reminder evaluation. A parcel reminds when it is out for delivery, or when it
 * has had no new event for PARCEL_STALL_DAYS while still registered/in transit. The
 * tracking number in every reminder is pre-masked.
 */
export function evaluateParcelReminders(
  parcels: readonly Parcel[],
  nowMs: number,
  stallMs: number = PARCEL_STALL_MS,
): ParcelReminder[] {
  const reminders: ParcelReminder[] = [];
  for (const parcel of parcels) {
    const displayName = parcel.label.trim() === '' ? parcel.carrier : parcel.label;

    if (parcel.status === 'out_for_delivery') {
      reminders.push({
        parcelId: parcel.id,
        kind: 'out_for_delivery',
        title: `${displayName} 派送中`,
        detail: '包裹正在派送，请留意签收',
        carrier: parcel.carrier,
        parcelLabel: parcel.label,
        trackingNumberMasked: parcel.trackingNumberMasked,
        eta: parcel.eta,
      });
      continue;
    }

    if (parcel.status === 'registered' || parcel.status === 'in_transit') {
      const anchorIso = parcel.lastEventAt ?? parcel.createdAt;
      const anchorMs = anchorIso ? Date.parse(anchorIso) : Number.NaN;
      if (Number.isFinite(anchorMs) && nowMs - anchorMs >= stallMs) {
        const days = Math.max(PARCEL_STALL_DAYS, Math.floor((nowMs - anchorMs) / (24 * 60 * 60 * 1000)));
        reminders.push({
          parcelId: parcel.id,
          kind: 'stalled',
          title: `${displayName} 物流停滞`,
          detail: `已超过 ${days} 天没有新动态`,
          carrier: parcel.carrier,
          parcelLabel: parcel.label,
          trackingNumberMasked: parcel.trackingNumberMasked,
          eta: parcel.eta,
        });
      }
    }
  }
  return reminders;
}

/** Reminders due for one user, evaluated against the current clock. */
export async function listParcelReminders(userId: number, nowMs: number = Date.now()): Promise<ParcelReminder[]> {
  const parcels = await listParcels(userId);
  return evaluateParcelReminders(parcels, nowMs);
}
