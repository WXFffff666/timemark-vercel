import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { redactForAudit } from './job-hardening.service.js';

/**
 * Task 142 — audit trail + exactly-once undo for destructive changes.
 *
 * Every destructive change (delete / merge / bulk_edit / archive) is recorded
 * through `recordAudit()` with the actor, a REDACTED before/after snapshot
 * (job-hardening's `redactForAudit`, so secrets never reach the table) and a
 * TTL'd undo token. Undo is a single atomic claim on the snapshot row:
 *
 *   UPDATE audit_undo_snapshots SET consumed_at = now()
 *    WHERE audit_event_id = $1 AND user_id = $2
 *      AND consumed_at IS NULL AND expires_at > now()
 *
 * The loser of a race updates zero rows, so a second undo always returns 409
 * (or 409 `undo_expired` once the window passed). The actual restore runs in
 * the SAME transaction as the claim, so a failed restore rolls the claim back
 * and the undo remains available; a successful one is irreversible.
 *
 * Restore is deliberately narrow: only tables in AUDIT_RESTORABLE_TABLES can be
 * written, groups are validated at record time, and columns are intersected
 * with the live information_schema (identifiers come from the DB, never from
 * the snapshot payload). Modes: `reinsert` (deleted rows, ON CONFLICT DO
 * NOTHING) and `revert` (modified rows, full-row UPDATE by id).
 */

const log = createLogger('agent.audit');

export const AUDIT_ACTIONS = ['delete', 'merge', 'bulk_edit', 'archive'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_UNDO_TTL_ENV = 'AUDIT_UNDO_TTL_HOURS';
export const DEFAULT_AUDIT_UNDO_TTL_HOURS = 72;
export const AUDIT_UNDO_TTL_MIN_HOURS = 1;
export const AUDIT_UNDO_TTL_MAX_HOURS = 720;
/** Rows captured per snapshot group; beyond this the snapshot is `truncated`. */
export const AUDIT_SNAPSHOT_ROW_CAP = 500;
export const AUDIT_LIST_DEFAULT_LIMIT = 20;
export const AUDIT_LIST_MAX_LIMIT = 100;

/** Configured undo window in milliseconds (`AUDIT_UNDO_TTL_HOURS`, clamped). */
export function readUndoWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt((env[AUDIT_UNDO_TTL_ENV] ?? '').trim(), 10);
  const hours = Number.isInteger(parsed)
    ? Math.min(Math.max(parsed, AUDIT_UNDO_TTL_MIN_HOURS), AUDIT_UNDO_TTL_MAX_HOURS)
    : DEFAULT_AUDIT_UNDO_TTL_HOURS;
  return hours * 3_600_000;
}

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

export type AuditSnapshotMode = 'reinsert' | 'revert';

export interface AuditSnapshotGroup {
  table: string;
  mode: AuditSnapshotMode;
  rows: Array<Record<string, unknown>>;
}

export interface AuditSnapshot {
  version: 1;
  truncated: boolean;
  groups: AuditSnapshotGroup[];
}

/** Tables an undo may write to. Anything else is dropped at record time. */
export const AUDIT_RESTORABLE_TABLES = [
  'events',
  'fixed_contacts',
  'todo_completions',
  'interactions',
] as const;

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function buildReinsertGroup(
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): AuditSnapshotGroup {
  return { table, mode: 'reinsert', rows: rows.slice(0, AUDIT_SNAPSHOT_ROW_CAP).map((row) => ({ ...row })) };
}

export function buildRevertGroup(
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): AuditSnapshotGroup {
  return { table, mode: 'revert', rows: rows.slice(0, AUDIT_SNAPSHOT_ROW_CAP).map((row) => ({ ...row })) };
}

function isPlainSnapshotRow(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).every((key) => IDENT_RE.test(key));
}

function toRedactedRecord(value: unknown): Record<string, unknown> {
  const redacted = redactForAudit(value ?? {});
  if (redacted !== null && typeof redacted === 'object' && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}

function normalizeSnapshot(groups: ReadonlyArray<AuditSnapshotGroup>): AuditSnapshot {
  const normalized: AuditSnapshotGroup[] = [];
  let truncated = false;
  for (const group of groups) {
    if (!(AUDIT_RESTORABLE_TABLES as readonly string[]).includes(group.table)) continue;
    if (group.mode !== 'reinsert' && group.mode !== 'revert') continue;
    const rows = group.rows.filter(isPlainSnapshotRow).slice(0, AUDIT_SNAPSHOT_ROW_CAP);
    if (rows.length !== group.rows.length) truncated = true;
    if (rows.length === 0) continue;
    normalized.push({ table: group.table, mode: group.mode, rows: rows.map((row) => toRedactedRecord(row)) });
  }
  return { version: 1, truncated, groups: normalized };
}

function parseSnapshot(raw: unknown): AuditSnapshot {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, truncated: false, groups: [] };
  }
  const record = value as Record<string, unknown>;
  const groupsRaw = Array.isArray(record.groups) ? record.groups : [];
  const groups: AuditSnapshotGroup[] = [];
  for (const entry of groupsRaw) {
    if (entry === null || typeof entry !== 'object') continue;
    const group = entry as Record<string, unknown>;
    const table = String(group.table ?? '');
    const mode = String(group.mode ?? '');
    if (!(AUDIT_RESTORABLE_TABLES as readonly string[]).includes(table)) continue;
    if (mode !== 'reinsert' && mode !== 'revert') continue;
    const rows = (Array.isArray(group.rows) ? group.rows : []).filter(isPlainSnapshotRow);
    if (rows.length === 0) continue;
    groups.push({ table, mode, rows });
  }
  return { version: 1, truncated: record.truncated === true, groups };
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export interface RecordAuditInput {
  userId: number;
  action: AuditAction;
  entityKind: string;
  entityIds?: ReadonlyArray<number | string>;
  summary?: string;
  /** Acting user; defaults to `userId` (agents/bots act on the user's behalf). */
  actorUserId?: number | null;
  actorVia?: string;
  before?: unknown;
  after?: unknown;
  snapshotGroups?: ReadonlyArray<AuditSnapshotGroup>;
  now?: Date;
  ttlMs?: number;
}

export interface AuditUndoInfo {
  available: boolean;
  expiresAt: string | null;
  consumedAt: string | null;
  token: string | null;
  truncated: boolean;
}

export interface AuditEventRow {
  id: number;
  userId: number;
  action: AuditAction;
  entityKind: string;
  entityIds: Array<number | string>;
  summary: string;
  actor: { userId: number | null; via: string };
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  undoneAt: string | null;
  createdAt: string;
  undo: AuditUndoInfo;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text === '' ? null : text;
}

function mapAuditRow(row: Record<string, unknown>, now: Date = new Date()): AuditEventRow {
  const undoExpiresAt = toIso(row.undo_expires_at);
  const consumedAt = toIso(row.undo_consumed_at);
  const token = row.undo_token == null ? null : String(row.undo_token);
  const expiresMs = undoExpiresAt === null ? Number.NaN : Date.parse(undoExpiresAt);
  const available = token !== null && consumedAt === null && Number.isFinite(expiresMs) && expiresMs > now.getTime();
  const rawIds = Array.isArray(row.entity_ids) ? (row.entity_ids as unknown[]) : [];
  const snapshotTruncated = row.undo_truncated === true;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    action: String(row.action) as AuditAction,
    entityKind: String(row.entity_kind ?? ''),
    entityIds: rawIds
      .filter((entry): entry is number | string => typeof entry === 'number' || typeof entry === 'string')
      .map((entry) => entry),
    summary: String(row.summary ?? ''),
    actor: {
      userId: row.actor_user_id == null ? null : Number(row.actor_user_id),
      via: String(row.actor_via ?? 'api'),
    },
    before: (row.before_snapshot ?? {}) as Record<string, unknown>,
    after: (row.after_snapshot ?? {}) as Record<string, unknown>,
    undoneAt: toIso(row.undone_at),
    createdAt: toIso(row.created_at) ?? '',
    undo: {
      available,
      expiresAt: undoExpiresAt,
      consumedAt,
      token,
      truncated: snapshotTruncated,
    },
  };
}

/** Sanitize the TTL: positive, bounded, integer milliseconds. */
function sanitizeTtlMs(ttlMs: number | undefined): number {
  const configured = readUndoWindowMs();
  const candidate = ttlMs ?? configured;
  if (!Number.isFinite(candidate) || candidate <= 0) return configured;
  return Math.min(candidate, AUDIT_UNDO_TTL_MAX_HOURS * 3_600_000);
}

/**
 * Record one destructive change. Throws on DB failure — callers that must not
 * be blocked by audit availability should use `recordAuditSafe`.
 */
export async function recordAudit(input: RecordAuditInput): Promise<AuditEventRow> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + sanitizeTtlMs(input.ttlMs));
  const token = randomBytes(32).toString('base64url');
  const snapshot = normalizeSnapshot(input.snapshotGroups ?? []);
  const entityIds = (input.entityIds ?? []).map((value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : String(value),
  );

  const eventRow = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO audit_events
         (user_id, action, entity_kind, entity_ids, summary, actor_user_id, actor_via,
          before_snapshot, after_snapshot, undo_expires_at, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
       RETURNING *`,
      [
        input.userId,
        input.action,
        input.entityKind.slice(0, 64),
        JSON.stringify(entityIds),
        (input.summary ?? '').slice(0, 500),
        input.actorUserId === undefined ? input.userId : input.actorUserId,
        (input.actorVia ?? 'api').slice(0, 32),
        JSON.stringify(toRedactedRecord(input.before)),
        JSON.stringify(toRedactedRecord(input.after)),
        expiresAt,
        now,
      ],
    );
    const row = inserted.rows[0] as Record<string, unknown>;
    await client.query(
      `INSERT INTO audit_undo_snapshots
         (audit_event_id, user_id, snapshot, undo_token, expires_at, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [Number(row.id), input.userId, JSON.stringify(snapshot), token, expiresAt, now],
    );
    return {
      ...row,
      undo_token: token,
      undo_consumed_at: null,
      undo_expires_at: expiresAt,
      undo_truncated: snapshot.truncated,
    };
  });

  return mapAuditRow(eventRow, now);
}

/**
 * Fire-and-forget-friendly recorder: an audit-write failure is logged and
 * swallowed so the already-approved change itself is never rolled back.
 */
export async function recordAuditSafe(input: RecordAuditInput): Promise<AuditEventRow | null> {
  try {
    return await recordAudit(input);
  } catch (error) {
    log.error(
      { action: input.action, entityKind: input.entityKind, err: error },
      'audit record failed (change proceeds)',
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListAuditOptions {
  limit?: number;
  offset?: number;
  action?: AuditAction | null;
  entityKind?: string | null;
}

export interface AuditPage {
  items: AuditEventRow[];
  total: number;
  limit: number;
  offset: number;
}

export async function listAuditEvents(userId: number, options: ListAuditOptions = {}): Promise<AuditPage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? AUDIT_LIST_DEFAULT_LIMIT), 1), AUDIT_LIST_MAX_LIMIT);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const params: unknown[] = [userId];
  let where = 'a.user_id = $1';
  if (options.action) {
    params.push(options.action);
    where += ` AND a.action = $${params.length}`;
  }
  if (options.entityKind) {
    params.push(options.entityKind);
    where += ` AND a.entity_kind = $${params.length}`;
  }

  const totalResult = await query(`SELECT COUNT(*)::int AS count FROM audit_events a WHERE ${where}`, params);
  const total = Number((totalResult.rows[0] as Record<string, unknown> | undefined)?.count ?? 0);

  const rows = await query(
    `SELECT a.*,
            s.undo_token,
            s.expires_at AS undo_expires_at,
            s.consumed_at AS undo_consumed_at,
            s.snapshot->>'truncated' AS undo_truncated
       FROM audit_events a
       LEFT JOIN audit_undo_snapshots s ON s.audit_event_id = a.id
      WHERE ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  const now = new Date();
  return {
    items: rows.rows.map((row) => {
      const record = { ...(row as Record<string, unknown>) };
      record.undo_truncated = record.undo_truncated === 'true';
      return mapAuditRow(record, now);
    }),
    total,
    limit,
    offset,
  };
}

// ---------------------------------------------------------------------------
// Undo (exactly once)
// ---------------------------------------------------------------------------

export type UndoAuditOutcome =
  | {
      status: 'restored';
      auditId: number;
      restored: number;
      groups: Array<{ table: string; mode: AuditSnapshotMode; rows: number }>;
      truncated: boolean;
    }
  | { status: 'not_found' }
  | { status: 'already_undone' }
  | { status: 'undo_expired' }
  | { status: 'nothing_to_undo' };

interface ColumnInfo {
  name: string;
  json: boolean;
  date: boolean;
}

const columnCache = new Map<string, ColumnInfo[]>();

async function tableColumns(client: PoolClient, table: string): Promise<ColumnInfo[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const result = await client.query(
    `SELECT column_name, udt_name
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  const columns: ColumnInfo[] = result.rows.map((row) => {
    const record = row as Record<string, unknown>;
    const udt = String(record.udt_name ?? '');
    return {
      name: String(record.column_name),
      json: udt === 'jsonb' || udt === 'json',
      date: udt === 'date',
    };
  });
  columnCache.set(table, columns);
  return columns;
}

function encodeValue(value: unknown, column: ColumnInfo): unknown {
  if (column.date && value instanceof Date) return value.toISOString().slice(0, 10);
  if (column.json && value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

interface RestoreStats {
  restored: number;
  groups: Array<{ table: string; mode: AuditSnapshotMode; rows: number }>;
}

async function restoreGroup(
  client: PoolClient,
  userId: number,
  group: AuditSnapshotGroup,
  stats: RestoreStats,
): Promise<void> {
  const columns = await tableColumns(client, group.table);
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (!byName.has('id')) return; // unknown/absent table or no stable PK — skip
  const hasUserId = byName.has('user_id');
  let applied = 0;

  for (const row of group.rows) {
    const id = row.id;
    if (typeof id !== 'number' && typeof id !== 'string') continue;
    if (hasUserId && Number(row.user_id) !== userId) continue;
    const names = Object.keys(row).filter((name) => byName.has(name));
    if (names.length === 0) continue;

    if (group.mode === 'reinsert') {
      const quoted = names.map((name) => `"${name}"`).join(', ');
      const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
      const values = names.map((name) => encodeValue(row[name], byName.get(name)!));
      const result = await client.query(
        `INSERT INTO "${group.table}" (${quoted}) VALUES (${placeholders}) ON CONFLICT ("id") DO NOTHING`,
        values,
      );
      applied += result.rowCount ?? 0;
      continue;
    }

    const updateNames = names.filter((name) => name !== 'id');
    if (updateNames.length === 0) continue;
    const sets = updateNames.map((name, index) => `"${name}" = $${index + 1}`);
    const params: unknown[] = updateNames.map((name) => encodeValue(row[name], byName.get(name)!));
    let sql = `UPDATE "${group.table}" SET ${sets.join(', ')} WHERE "id" = $${params.length + 1}`;
    params.push(id);
    if (hasUserId) {
      sql += ` AND "user_id" = $${params.length + 1}`;
      params.push(userId);
    }
    const result = await client.query(sql, params);
    applied += result.rowCount ?? 0;
  }

  stats.restored += applied;
  stats.groups.push({ table: group.table, mode: group.mode, rows: applied });
}

/**
 * Restore the snapshot for `auditId`, exactly once. The claim, the restore and
 * the `undone_at` stamp all run in one transaction: a failed restore rolls the
 * claim back, a committed one can never run again.
 */
export async function undoAuditEvent(userId: number, auditId: number): Promise<UndoAuditOutcome> {
  if (!Number.isSafeInteger(auditId) || auditId <= 0) return { status: 'not_found' };

  return withTransaction(async (client) => {
    const claim = await client.query(
      `UPDATE audit_undo_snapshots
          SET consumed_at = now()
        WHERE audit_event_id = $1 AND user_id = $2
          AND consumed_at IS NULL AND expires_at > now()
        RETURNING snapshot`,
      [auditId, userId],
    );

    if (claim.rowCount === 0) {
      const state = await client.query(
        `SELECT consumed_at, expires_at FROM audit_undo_snapshots WHERE audit_event_id = $1 AND user_id = $2`,
        [auditId, userId],
      );
      if (state.rows.length === 0) {
        const event = await client.query(`SELECT id FROM audit_events WHERE id = $1 AND user_id = $2`, [
          auditId,
          userId,
        ]);
        return event.rows.length === 0 ? { status: 'not_found' } : { status: 'nothing_to_undo' };
      }
      const row = state.rows[0] as Record<string, unknown>;
      return row.consumed_at != null ? { status: 'already_undone' } : { status: 'undo_expired' };
    }

    const snapshot = parseSnapshot((claim.rows[0] as Record<string, unknown>).snapshot);
    const stats: RestoreStats = { restored: 0, groups: [] };
    for (const group of snapshot.groups) {
      await restoreGroup(client, userId, group, stats);
    }

    await client.query(`UPDATE audit_events SET undone_at = now() WHERE id = $1 AND user_id = $2`, [
      auditId,
      userId,
    ]);
    await client.query(
      `UPDATE audit_undo_snapshots SET restored = $3::jsonb WHERE audit_event_id = $1 AND user_id = $2`,
      [auditId, userId, JSON.stringify({ restored: stats.restored, groups: stats.groups })],
    );

    return {
      status: 'restored',
      auditId,
      restored: stats.restored,
      groups: stats.groups,
      truncated: snapshot.truncated,
    };
  });
}
