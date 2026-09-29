import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { formatZodError, type User } from '@timemark/shared';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { query, withTransaction } from '../../db/index.js';
import {
  AGENT_JOB_KINDS,
  agentQueue,
  type AgentJobKind,
  type AgentQueue,
} from '../../services/agent/queue.service.js';

/**
 * Checkbox 119: the agent control-plane API, mounted at `/api/admin/agent`.
 *
 * Auth is the normal session/admin middleware (`authMiddleware`) - agent tool tokens
 * (`tmt_...`) are deliberately NOT accepted here: this surface exposes every user's
 * jobs, workers and routines, so it stays on the same credential as the rest of the
 * settings UI. TimeMark is a single-user deployment (`utils/single-user.ts`), so the
 * console is not row-scoped per user; routine mutations are still owner-scoped.
 *
 * Pagination: every list read is KEYSET (cursor) paginated:
 *   `{ success: true, data: [...], pagination: { limit, hasMore, nextCursor } }`
 * `limit` is clamped to 1..100 (default 25). The cursor is base64url(JSON([orderValue, id]))
 * and is validated on decode - garbage is a 400, never interpolated. Keyset pagination is
 * stable under concurrent inserts (a new row at the head cannot shift a page) and its
 * predicates line up with the shipped indexes:
 *   - `/jobs` + `/runs`: `(j.created_at, j.id) < ($t, $id)` with `ORDER BY created_at DESC, id DESC`
 *     -> filterable by `user_id` (idx `(user_id, created_at DESC)`), `status` (idx `(status, run_at)`),
 *        `kind`+`status` (idx `(kind, status)`).
 *   - `/routines`: `(r.name, r.id) > ($n, $id)` with `WHERE r.user_id = $1 ORDER BY name ASC, id ASC`
 *     -> the leading columns of the UNIQUE `(user_id, name)` index.
 *   - `/workers`: `w.id > $id` with `ORDER BY id ASC` -> the primary key.
 * Aggregates (`/stats`) are fixed-size GROUP BY scans, not pageable lists.
 * A unit-level EXPLAIN over these queries is deliberately NOT asserted: with a handful of
 * seeded rows the planner picks a seq scan and the EXPLAIN would be misleading. Index
 * conformance is asserted structurally instead, on the CAPTURED SQL text (equality/keyset
 * predicates must match the index's leading columns).
 *
 * There is NO raw-SQL, arbitrary-query or unvalidated-payload endpoint here: every filter is
 * a typed scalar mapped to a bound parameter, every body is a zod `.strict()` schema, and the
 * routine `config` object is size-capped.
 *
 * `suppressed` in `/stats` counts jobs recorded with `error_code = 'SUPPRESSED'`. The
 * notification-budget layer (checkbox 118) writes that code when it folds a proactive message
 * away; until a producer writes it the control plane reports an honest 0.
 */

export const AGENT_JOB_STATUSES = [
  'queued',
  'leased',
  'running',
  'succeeded',
  'failed',
  'dead_letter',
  'cancelled',
] as const;

export type AgentJobStatus = (typeof AGENT_JOB_STATUSES)[number];

export const AGENT_ROUTINE_TIERS = ['lite', 'medium', 'high'] as const;

/** `limit` clamp for every list read. */
export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;

/** Worker liveness threshold; override per call via deps or `AGENT_WORKER_STALE_MS`. */
export const DEFAULT_WORKER_STALE_MS = 120_000;

/** Bounds for the per-job event timeline (the `events_limit` query parameter). */
export const DEFAULT_JOB_EVENTS_LIMIT = 100;
export const MAX_JOB_EVENTS_LIMIT = 200;

/** Caps the routine `config` JSON payload accepted by POST/PATCH /routines. */
export const MAX_ROUTINE_CONFIG_BYTES = 4096;

/** The error code the (118) budget layer writes for suppressed proactive output. */
export const SUPPRESSED_ERROR_CODE = 'SUPPRESSED';

export function isJobStatus(value: string): value is AgentJobStatus {
  return (AGENT_JOB_STATUSES as readonly string[]).includes(value);
}

export function isJobKind(value: string): value is AgentJobKind {
  return (AGENT_JOB_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Query-parameter parsing (typed scalars only - never a raw query string)
// ---------------------------------------------------------------------------

function parseLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(n, MAX_LIST_LIMIT);
}

function parseEventsLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_JOB_EVENTS_LIMIT;
  return Math.min(n, MAX_JOB_EVENTS_LIMIT);
}

function parseOptionalPositiveInt(raw: string | undefined): number | 'invalid' | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 'invalid';
}

function parseOptionalStatus(raw: string | undefined): AgentJobStatus | 'invalid' | undefined {
  if (raw === undefined || raw === '') return undefined;
  return isJobStatus(raw) ? raw : 'invalid';
}

function parseOptionalKind(raw: string | undefined): AgentJobKind | 'invalid' | undefined {
  if (raw === undefined || raw === '') return undefined;
  return isJobKind(raw) ? raw : 'invalid';
}

function parseOptionalEnabled(raw: string | undefined): boolean | 'invalid' | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return 'invalid';
}

// ---------------------------------------------------------------------------
// Keyset cursors: base64url([orderValue, id]) - validated, never interpolated.
// ---------------------------------------------------------------------------

export type CursorRead =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'ok'; value: { order: string; id: string } };

export function encodeCursor(order: string, id: string): string {
  return Buffer.from(JSON.stringify([order, id]), 'utf8').toString('base64url');
}

export function readCursor(raw: string | undefined): CursorRead {
  if (raw === undefined || raw === '') return { state: 'absent' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { state: 'invalid' };
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) return { state: 'invalid' };
  const order = decoded[0];
  const id = decoded[1];
  if (typeof order !== 'string' || order.length === 0 || order.length > 256) return { state: 'invalid' };
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return { state: 'invalid' };
  return { state: 'ok', value: { order, id } };
}

interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Rows are fetched with `limit + 1`; the extra row only signals `hasMore`. */
function paginate<T>(rows: T[], limit: number, cursorFor: (row: T) => [string, string] | null): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  let nextCursor: string | null = null;
  if (hasMore && last !== undefined) {
    const cursorValue = cursorFor(last);
    nextCursor = cursorValue === null ? null : encodeCursor(cursorValue[0], cursorValue[1]);
  }
  return { items, hasMore, nextCursor };
}

// ---------------------------------------------------------------------------
// Row serialization
// ---------------------------------------------------------------------------

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 't' || value === 1;
}

function textOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

const JOB_COLUMNS = `id, user_id, kind, status, priority, attempt, max_attempts,
       lease_owner, lease_expires_at, run_at, started_at, finished_at,
       error_code, error_message, cost_tokens, created_at, updated_at,
       (idempotency_key IS NOT NULL) AS has_idempotency_key`;

const ROUTINE_COLUMNS = `id, user_id, name, cron_expr, kind, enabled, next_run_at,
       last_run_at, tier, budget_per_day, config`;

function serializeJob(row: Record<string, unknown>) {
  // Deliberately NOT returned: `payload`, `result` and the raw `idempotency_key` value.
  // Payload/result redaction and transparency are checkbox 121's surface; the control
  // plane only needs the lifecycle fields plus a "was this deduped" flag.
  return {
    id: String(row.id),
    user_id: row.user_id == null ? null : toInt(row.user_id),
    kind: String(row.kind),
    status: String(row.status),
    priority: toInt(row.priority),
    attempt: toInt(row.attempt),
    max_attempts: toInt(row.max_attempts),
    lease_owner: textOrNull(row.lease_owner),
    lease_expires_at: isoOrNull(row.lease_expires_at),
    run_at: isoOrNull(row.run_at),
    started_at: isoOrNull(row.started_at),
    finished_at: isoOrNull(row.finished_at),
    error_code: textOrNull(row.error_code),
    error_message: textOrNull(row.error_message),
    cost_tokens: toInt(row.cost_tokens),
    created_at: isoOrNull(row.created_at),
    updated_at: isoOrNull(row.updated_at),
    has_idempotency_key: toBool(row.has_idempotency_key),
  };
}

function serializeEvent(row: Record<string, unknown>) {
  return {
    id: toInt(row.id),
    job_id: String(row.job_id),
    at: isoOrNull(row.at),
    status: textOrNull(row.status),
    detail: row.detail ?? null,
  };
}

function serializeWorker(row: Record<string, unknown>, nowMs: number, staleAfterMs: number) {
  const lastSeenAt = isoOrNull(row.last_seen_at);
  const lastSeenMs = lastSeenAt === null ? null : Date.parse(lastSeenAt);
  const valid = lastSeenMs !== null && Number.isFinite(lastSeenMs);
  const lastSeenAgoMs = valid ? Math.max(0, nowMs - (lastSeenMs as number)) : null;
  const online = valid && nowMs - (lastSeenMs as number) <= staleAfterMs;
  return {
    id: String(row.id),
    kind: textOrNull(row.kind),
    last_seen_at: lastSeenAt,
    lastSeenAgoMs,
    online,
    status: online ? ('online' as const) : ('stale' as const),
    meta: row.meta ?? null,
  };
}

function serializeRoutine(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    user_id: toInt(row.user_id),
    name: String(row.name),
    cron_expr: textOrNull(row.cron_expr),
    kind: String(row.kind),
    enabled: toBool(row.enabled),
    next_run_at: isoOrNull(row.next_run_at),
    last_run_at: isoOrNull(row.last_run_at),
    tier: textOrNull(row.tier),
    budget_per_day: row.budget_per_day == null ? null : toInt(row.budget_per_day),
    config: row.config ?? {},
  };
}

function serializeRun(row: Record<string, unknown>) {
  const startedAt = isoOrNull(row.started_at);
  const finishedAt = isoOrNull(row.finished_at);
  let durationMs: number | null = null;
  if (startedAt !== null && finishedAt !== null) {
    const started = Date.parse(startedAt);
    const finished = Date.parse(finishedAt);
    if (Number.isFinite(started) && Number.isFinite(finished)) durationMs = Math.max(0, finished - started);
  }
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    attempt: toInt(row.attempt),
    max_attempts: toInt(row.max_attempts),
    costTokens: toInt(row.cost_tokens),
    created_at: isoOrNull(row.created_at),
    started_at: startedAt,
    finished_at: finishedAt,
    error_code: textOrNull(row.error_code),
    routine_id: textOrNull(row.routine_id),
    routine_name: textOrNull(row.routine_name),
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Shipped SQL. Exported so tests assert the exact text (index conformance,
// bound parameters, data-layer transition guards).
// ---------------------------------------------------------------------------

export const ADMIN_AGENT_SQL = {
  jobById: `SELECT ${JOB_COLUMNS} FROM agent_jobs WHERE id = $1`,
  jobStatusById: `SELECT id, status FROM agent_jobs WHERE id = $1`,
  jobEvents: `SELECT e.id, e.job_id, e.at, e.status, e.detail
FROM agent_job_events e
WHERE e.job_id = $1
ORDER BY e.at ASC, e.id ASC
LIMIT $2`,
  jobEventsCount: `SELECT COUNT(*)::int AS total FROM agent_job_events e WHERE e.job_id = $1`,
  jobEventInsert: `INSERT INTO agent_job_events (job_id, status, detail) VALUES ($1, $2, $3::jsonb)`,
  routineByIdOwned: `SELECT ${ROUTINE_COLUMNS} FROM agent_routines r WHERE r.id = $1 AND r.user_id = $2`,
  routineNameTaken: `SELECT r.id FROM agent_routines r WHERE r.user_id = $1 AND r.name = $2 LIMIT 1`,
  routineInsert: `INSERT INTO agent_routines (user_id, name, kind, cron_expr, enabled, tier, budget_per_day, config)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
RETURNING ${ROUTINE_COLUMNS}`,
  statsByStatus: `SELECT status, COUNT(*)::int AS count FROM agent_jobs GROUP BY status`,
  statsByKind: `SELECT kind, COUNT(*)::int AS count FROM agent_jobs GROUP BY kind`,
  statsAggregates: `SELECT
  COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND finished_at >= now() - interval '24 hours')::int AS finished_24h,
  COUNT(*) FILTER (WHERE status = 'succeeded' AND finished_at >= now() - interval '24 hours')::int AS succeeded_24h,
  COUNT(*) FILTER (WHERE status = 'failed' AND finished_at >= now() - interval '24 hours')::int AS failed_24h,
  COUNT(*) FILTER (WHERE status = 'dead_letter' AND finished_at >= now() - interval '24 hours')::int AS dead_letter_24h,
  COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND finished_at >= now() - interval '1 hour')::int AS finished_1h,
  COALESCE(SUM(cost_tokens), 0)::int AS tokens_total,
  COALESCE(SUM(cost_tokens) FILTER (WHERE finished_at >= now() - interval '24 hours'), 0)::int AS tokens_24h,
  COUNT(*) FILTER (WHERE error_code = '${SUPPRESSED_ERROR_CODE}')::int AS suppressed_total,
  COUNT(*) FILTER (WHERE error_code = '${SUPPRESSED_ERROR_CODE}' AND created_at >= now() - interval '24 hours')::int AS suppressed_24h
FROM agent_jobs`,
} as const;

/**
 * Data-layer guarded transitions. Each statement carries its OWN `status IN (...)`
 * predicate, so a racing worker/reclaimer can never be corrupted and an illegal source
 * status matches zero rows (the route then surfaces 404 vs 409). The `prev` CTE reads the
 * pre-update status (statement snapshot) so the event row can record `from`.
 */
export const TRANSITION_SQL = {
  retry: `WITH prev AS (
  SELECT id, status AS from_status FROM agent_jobs WHERE id = $1
)
UPDATE agent_jobs j
SET status = 'queued',
    run_at = now(),
    max_attempts = GREATEST(j.max_attempts, j.attempt + 1),
    error_code = NULL,
    error_message = NULL,
    finished_at = NULL,
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    updated_at = now()
FROM prev
WHERE j.id = prev.id AND j.status IN ('failed', 'dead_letter', 'cancelled')
RETURNING j.id, j.status, j.attempt, j.max_attempts, prev.from_status`,
  requeue: `WITH prev AS (
  SELECT id, status AS from_status FROM agent_jobs WHERE id = $1
)
UPDATE agent_jobs j
SET status = 'queued',
    run_at = now(),
    error_code = NULL,
    error_message = NULL,
    finished_at = NULL,
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    updated_at = now()
FROM prev
WHERE j.id = prev.id AND j.status IN ('leased', 'running')
RETURNING j.id, j.status, j.attempt, j.max_attempts, prev.from_status`,
  cancel: `WITH prev AS (
  SELECT id, status AS from_status FROM agent_jobs WHERE id = $1
)
UPDATE agent_jobs j
SET status = 'cancelled',
    finished_at = now(),
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    updated_at = now()
FROM prev
WHERE j.id = prev.id AND j.status IN ('queued', 'leased', 'running')
RETURNING j.id, j.status, j.attempt, j.max_attempts, prev.from_status`,
} as const;

export const JOB_TRANSITIONS = {
  retry: { from: ['failed', 'dead_letter', 'cancelled'] as const, to: 'queued' as const },
  requeue: { from: ['leased', 'running'] as const, to: 'queued' as const },
  cancel: { from: ['queued', 'leased', 'running'] as const, to: 'cancelled' as const },
} as const;

export type JobTransitionAction = keyof typeof JOB_TRANSITIONS;

export interface JobListFilters {
  userId?: number;
  status?: AgentJobStatus;
  kind?: AgentJobKind;
}

export function buildJobsListQuery(
  filters: JobListFilters,
  cursor: { order: string; id: string } | null,
  limit: number,
): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const predicates: string[] = [];
  if (filters.userId !== undefined) {
    params.push(filters.userId);
    predicates.push(`j.user_id = $${params.length}`);
  }
  if (filters.status !== undefined) {
    params.push(filters.status);
    predicates.push(`j.status = $${params.length}`);
  }
  if (filters.kind !== undefined) {
    params.push(filters.kind);
    predicates.push(`j.kind = $${params.length}`);
  }
  if (cursor !== null) {
    params.push(cursor.order);
    const orderPlaceholder = `$${params.length}`;
    params.push(cursor.id);
    const idPlaceholder = `$${params.length}`;
    predicates.push(`(j.created_at, j.id) < (${orderPlaceholder}::timestamptz, ${idPlaceholder}::uuid)`);
  }
  const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
  params.push(limit);
  return {
    text: `SELECT ${JOB_COLUMNS} FROM agent_jobs j ${where} ORDER BY j.created_at DESC, j.id DESC LIMIT $${params.length}`,
    params,
  };
}

export function buildRunsListQuery(
  filters: JobListFilters,
  cursor: { order: string; id: string } | null,
  limit: number,
): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const predicates: string[] = [];
  if (filters.userId !== undefined) {
    params.push(filters.userId);
    predicates.push(`j.user_id = $${params.length}`);
  }
  if (filters.status !== undefined) {
    params.push(filters.status);
    predicates.push(`j.status = $${params.length}`);
  }
  if (filters.kind !== undefined) {
    params.push(filters.kind);
    predicates.push(`j.kind = $${params.length}`);
  }
  if (cursor !== null) {
    params.push(cursor.order);
    const orderPlaceholder = `$${params.length}`;
    params.push(cursor.id);
    const idPlaceholder = `$${params.length}`;
    predicates.push(`(j.created_at, j.id) < (${orderPlaceholder}::timestamptz, ${idPlaceholder}::uuid)`);
  }
  const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
  params.push(limit);
  return {
    text: `SELECT j.id, j.kind, j.status, j.attempt, j.max_attempts, j.cost_tokens,
       j.created_at, j.started_at, j.finished_at, j.error_code,
       j.payload->>'routine_id' AS routine_id,
       r.name AS routine_name
FROM agent_jobs j
LEFT JOIN agent_routines r ON r.id::text = j.payload->>'routine_id'
${where} ORDER BY j.created_at DESC, j.id DESC LIMIT $${params.length}`,
    params,
  };
}

export function buildRoutinesListQuery(
  filters: { userId: number; enabled?: boolean },
  cursor: { order: string; id: string } | null,
  limit: number,
): { text: string; params: unknown[] } {
  const params: unknown[] = [filters.userId];
  const predicates: string[] = [`r.user_id = $${params.length}`];
  if (filters.enabled !== undefined) {
    params.push(filters.enabled);
    predicates.push(`r.enabled = $${params.length}`);
  }
  if (cursor !== null) {
    params.push(cursor.order);
    const namePlaceholder = `$${params.length}`;
    params.push(cursor.id);
    const idPlaceholder = `$${params.length}`;
    predicates.push(`(r.name, r.id) > (${namePlaceholder}, ${idPlaceholder}::uuid)`);
  }
  params.push(limit);
  return {
    text: `SELECT ${ROUTINE_COLUMNS} FROM agent_routines r WHERE ${predicates.join(' AND ')} ORDER BY r.name ASC, r.id ASC LIMIT $${params.length}`,
    params,
  };
}

export function buildWorkersListQuery(
  cursor: { order: string; id: string } | null,
  limit: number,
): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const predicates: string[] = [];
  if (cursor !== null) {
    params.push(cursor.id);
    predicates.push(`w.id > $${params.length}`);
  }
  const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
  params.push(limit);
  return {
    text: `SELECT w.id, w.kind, w.last_seen_at, w.meta FROM agent_workers w ${where} ORDER BY w.id ASC LIMIT $${params.length}`,
    params,
  };
}

// ---------------------------------------------------------------------------
// Bodies: every schema is `.strict()` - unknown keys are rejected, never stored.
// ---------------------------------------------------------------------------

const configSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_ROUTINE_CONFIG_BYTES, {
    message: `config must serialize to ${MAX_ROUTINE_CONFIG_BYTES} bytes or fewer`,
  });

const cronExprSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\s]+(?:\s+[^\s]+){4,5}$/, 'cron_expr must have 5 or 6 space-separated fields');

export const routineCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(AGENT_JOB_KINDS),
    cron_expr: cronExprSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    tier: z.enum(AGENT_ROUTINE_TIERS).nullable().optional(),
    budget_per_day: z.number().int().min(0).max(1000).nullable().optional(),
    config: configSchema.optional(),
  })
  .strict();

export const routineUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    cron_expr: cronExprSchema.nullable().optional(),
    tier: z.enum(AGENT_ROUTINE_TIERS).nullable().optional(),
    budget_per_day: z.number().int().min(0).max(1000).nullable().optional(),
    config: configSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type AdminCtx = Context<{ Variables: { user: User } }>;

export interface AdminAgentRouteDeps {
  /** Clock in epoch ms (injectable so worker online/stale is deterministic in tests). */
  now?: () => number;
  /** Worker liveness threshold; env `AGENT_WORKER_STALE_MS` then {@link DEFAULT_WORKER_STALE_MS}. */
  staleAfterMs?: number;
  /** Enqueue seam for `run-now`; defaults to the process-wide agent queue. */
  enqueue?: AgentQueue['enqueue'];
}

function readEnvInt(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function invalidCursorResponse(c: AdminCtx): Response {
  return c.json({ success: false, error: 'invalid_cursor', message: 'cursor is not a valid opaque page token' }, 400);
}

export function createAdminAgentRoutes(deps: AdminAgentRouteDeps = {}): Hono<{ Variables: { user: User } }> {
  const now = deps.now ?? (() => Date.now());
  const envStale = readEnvInt('AGENT_WORKER_STALE_MS');
  const staleAfterMs = deps.staleAfterMs ?? (envStale !== null && envStale > 0 ? envStale : DEFAULT_WORKER_STALE_MS);
  const enqueue = deps.enqueue ?? ((kind, payload, options) => agentQueue.enqueue(kind, payload, options));

  const routes = new Hono<{ Variables: { user: User } }>();
  routes.use('*', authMiddleware);

  // -- GET /jobs?status=&kind=&user_id=&limit=&cursor= --------------------------
  routes.get('/jobs', async (c) => {
    const status = parseOptionalStatus(c.req.query('status'));
    if (status === 'invalid') return c.json({ success: false, error: 'invalid_status', message: 'status is not a known agent job status' }, 400);
    const kind = parseOptionalKind(c.req.query('kind'));
    if (kind === 'invalid') return c.json({ success: false, error: 'invalid_kind', message: 'kind is not a known agent job kind' }, 400);
    const userId = parseOptionalPositiveInt(c.req.query('user_id'));
    if (userId === 'invalid') return c.json({ success: false, error: 'invalid_user_id', message: 'user_id must be a positive integer' }, 400);
    const cursor = readCursor(c.req.query('cursor'));
    if (cursor.state === 'invalid') return invalidCursorResponse(c);

    const limit = parseLimit(c.req.query('limit'));
    const { text, params } = buildJobsListQuery(
      { userId, status, kind },
      cursor.state === 'ok' ? cursor.value : null,
      limit + 1,
    );
    const result = await query(text, params);
    const page = paginate(result.rows, limit, (row) => {
      const createdAt = isoOrNull(row.created_at);
      return createdAt === null ? null : [createdAt, String(row.id)];
    });
    return c.json({
      success: true,
      data: page.items.map(serializeJob),
      pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor },
    });
  });

  // -- GET /jobs/:id (+ its bounded agent_job_events timeline) ------------------
  routes.get('/jobs/:id', async (c) => {
    const parsedId = z.string().uuid().safeParse(c.req.param('id'));
    if (!parsedId.success) return c.json({ success: false, error: 'invalid_id', message: 'job id must be a uuid' }, 400);

    const job = await query(ADMIN_AGENT_SQL.jobById, [parsedId.data]);
    if (job.rows.length === 0) return c.json({ success: false, error: 'job_not_found' }, 404);

    const eventsLimit = parseEventsLimit(c.req.query('events_limit'));
    const [events, count] = await Promise.all([
      query(ADMIN_AGENT_SQL.jobEvents, [parsedId.data, eventsLimit + 1]),
      query(ADMIN_AGENT_SQL.jobEventsCount, [parsedId.data]),
    ]);
    const eventsHasMore = events.rows.length > eventsLimit;
    const timeline = eventsHasMore ? events.rows.slice(0, eventsLimit) : events.rows;
    return c.json({
      success: true,
      data: {
        job: serializeJob(job.rows[0]),
        events: timeline.map(serializeEvent),
        eventsLimit,
        eventsHasMore,
        eventsTotal: toInt(count.rows[0]?.total, timeline.length),
      },
    });
  });

  // -- POST /jobs/:id/retry | cancel | requeue ---------------------------------
  async function runTransition(c: AdminCtx, action: JobTransitionAction): Promise<Response> {
    const parsedId = z.string().uuid().safeParse(c.req.param('id'));
    if (!parsedId.success) return c.json({ success: false, error: 'invalid_id', message: 'job id must be a uuid' }, 400);

    const spec = JOB_TRANSITIONS[action];
    const outcome = await withTransaction(async (client) => {
      const updated = await client.query(TRANSITION_SQL[action], [parsedId.data]);
      if (updated.rows.length === 0) {
        const current = await client.query(ADMIN_AGENT_SQL.jobStatusById, [parsedId.data]);
        return {
          changed: false as const,
          currentStatus: current.rows.length > 0 ? String(current.rows[0].status) : null,
        };
      }
      const row = updated.rows[0];
      await client.query(ADMIN_AGENT_SQL.jobEventInsert, [
        parsedId.data,
        spec.to,
        JSON.stringify({ action, actor: 'admin', from: row.from_status == null ? null : String(row.from_status) }),
      ]);
      return { changed: true as const, row };
    });

    if (!outcome.changed) {
      if (outcome.currentStatus === null) return c.json({ success: false, error: 'job_not_found' }, 404);
      return c.json(
        {
          success: false,
          error: 'illegal_transition',
          message: `cannot ${action} a job in status '${outcome.currentStatus}' (allowed from: ${spec.from.join(', ')})`,
          status: outcome.currentStatus,
        },
        409,
      );
    }

    return c.json({
      success: true,
      data: {
        id: String(outcome.row.id),
        status: String(outcome.row.status),
        previous_status: outcome.row.from_status == null ? null : String(outcome.row.from_status),
        attempt: toInt(outcome.row.attempt),
        max_attempts: toInt(outcome.row.max_attempts),
      },
    });
  }

  routes.post('/jobs/:id/retry', (c) => runTransition(c, 'retry'));
  routes.post('/jobs/:id/cancel', (c) => runTransition(c, 'cancel'));
  routes.post('/jobs/:id/requeue', (c) => runTransition(c, 'requeue'));

  // -- GET /workers (online/stale from last_seen_at vs the threshold) ----------
  routes.get('/workers', async (c) => {
    const cursor = readCursor(c.req.query('cursor'));
    if (cursor.state === 'invalid') return invalidCursorResponse(c);
    const limit = parseLimit(c.req.query('limit'));
    const { text, params } = buildWorkersListQuery(cursor.state === 'ok' ? cursor.value : null, limit + 1);
    const result = await query(text, params);
    const page = paginate(result.rows, limit, (row) => [String(row.id), String(row.id)]);
    const nowMs = now();
    return c.json({
      success: true,
      data: page.items.map((row) => serializeWorker(row, nowMs, staleAfterMs)),
      pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor },
      stale_after_ms: staleAfterMs,
    });
  });

  // -- GET /stats ---------------------------------------------------------------
  routes.get('/stats', async (c) => {
    const [statusRows, kindRows, aggregateRows] = await Promise.all([
      query(ADMIN_AGENT_SQL.statsByStatus),
      query(ADMIN_AGENT_SQL.statsByKind),
      query(ADMIN_AGENT_SQL.statsAggregates),
    ]);

    const byStatus: Record<string, number> = {};
    for (const status of AGENT_JOB_STATUSES) byStatus[status] = 0;
    for (const row of statusRows.rows) byStatus[String(row.status)] = toInt(row.count);

    const byKind: Record<string, number> = {};
    for (const kind of AGENT_JOB_KINDS) byKind[kind] = 0;
    for (const row of kindRows.rows) byKind[String(row.kind)] = toInt(row.count);

    const aggregate = aggregateRows.rows[0] ?? {};
    const succeededLast24h = toInt(aggregate.succeeded_24h);
    const failedLast24h = toInt(aggregate.failed_24h);
    const deadLetterLast24h = toInt(aggregate.dead_letter_24h);
    const terminalLast24h = succeededLast24h + failedLast24h + deadLetterLast24h;
    const failureRate =
      terminalLast24h > 0
        ? Math.round(((failedLast24h + deadLetterLast24h) / terminalLast24h) * 10000) / 10000
        : 0;

    return c.json({
      success: true,
      data: {
        generated_at: new Date(now()).toISOString(),
        byStatus,
        byKind,
        throughput: {
          finishedLast24h: toInt(aggregate.finished_24h),
          succeededLast24h,
          failedLast24h,
          deadLetterLast24h,
          finishedLastHour: toInt(aggregate.finished_1h),
        },
        failureRate,
        tokens: {
          spentTotal: toInt(aggregate.tokens_total),
          spentLast24h: toInt(aggregate.tokens_24h),
        },
        suppressed: {
          total: toInt(aggregate.suppressed_total),
          last24h: toInt(aggregate.suppressed_24h),
        },
      },
    });
  });

  // -- GET /routines ------------------------------------------------------------
  routes.get('/routines', async (c) => {
    const enabled = parseOptionalEnabled(c.req.query('enabled'));
    if (enabled === 'invalid') return c.json({ success: false, error: 'invalid_enabled', message: "enabled must be 'true' or 'false'" }, 400);
    const cursor = readCursor(c.req.query('cursor'));
    if (cursor.state === 'invalid') return invalidCursorResponse(c);

    const userId = Number(c.get('user').id);
    const limit = parseLimit(c.req.query('limit'));
    const { text, params } = buildRoutinesListQuery({ userId, enabled }, cursor.state === 'ok' ? cursor.value : null, limit + 1);
    const result = await query(text, params);
    const page = paginate(result.rows, limit, (row) => [String(row.name), String(row.id)]);
    return c.json({
      success: true,
      data: page.items.map(serializeRoutine),
      pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor },
    });
  });

  // -- POST /routines -----------------------------------------------------------
  routes.post('/routines', async (c) => {
    const userId = Number(c.get('user').id);
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = routineCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: 'invalid_body', message: formatZodError(parsed.error), details: z.flattenError(parsed.error) },
        400,
      );
    }
    const input = parsed.data;

    const existing = await query(ADMIN_AGENT_SQL.routineNameTaken, [userId, input.name]);
    if (existing.rows.length > 0) {
      return c.json({ success: false, error: 'routine_name_taken', message: `a routine named '${input.name}' already exists` }, 409);
    }

    try {
      const inserted = await query(ADMIN_AGENT_SQL.routineInsert, [
        userId,
        input.name,
        input.kind,
        input.cron_expr ?? null,
        input.enabled ?? false,
        input.tier ?? null,
        input.budget_per_day ?? null,
        JSON.stringify(input.config ?? {}),
      ]);
      return c.json({ success: true, data: serializeRoutine(inserted.rows[0]) }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ success: false, error: 'routine_name_taken', message: `a routine named '${input.name}' already exists` }, 409);
      }
      throw error;
    }
  });

  // -- PATCH /routines/:id (enable/disable, cron, tier, budget, config) ---------
  routes.patch('/routines/:id', async (c) => {
    const parsedId = z.string().uuid().safeParse(c.req.param('id'));
    if (!parsedId.success) return c.json({ success: false, error: 'invalid_id', message: 'routine id must be a uuid' }, 400);

    const body: unknown = await c.req.json().catch(() => null);
    const parsed = routineUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: 'invalid_body', message: formatZodError(parsed.error), details: z.flattenError(parsed.error) },
        400,
      );
    }
    const input = parsed.data;

    const params: unknown[] = [];
    const sets: string[] = [];
    if (input.enabled !== undefined) {
      params.push(input.enabled);
      sets.push(`enabled = $${params.length}`);
    }
    if (input.cron_expr !== undefined) {
      params.push(input.cron_expr);
      sets.push(`cron_expr = $${params.length}`);
    }
    if (input.tier !== undefined) {
      params.push(input.tier);
      sets.push(`tier = $${params.length}`);
    }
    if (input.budget_per_day !== undefined) {
      params.push(input.budget_per_day);
      sets.push(`budget_per_day = $${params.length}`);
    }
    if (input.config !== undefined) {
      params.push(JSON.stringify(input.config));
      sets.push(`config = $${params.length}::jsonb`);
    }
    params.push(parsedId.data);
    const idPlaceholder = `$${params.length}`;
    params.push(Number(c.get('user').id));
    const ownerPlaceholder = `$${params.length}`;

    const updated = await query(
      `UPDATE agent_routines SET ${sets.join(', ')} WHERE id = ${idPlaceholder} AND user_id = ${ownerPlaceholder} RETURNING ${ROUTINE_COLUMNS}`,
      params,
    );
    if (updated.rows.length === 0) return c.json({ success: false, error: 'routine_not_found' }, 404);
    return c.json({ success: true, data: serializeRoutine(updated.rows[0]) });
  });

  // -- POST /routines/:id/run-now (enqueue exactly one job when enabled) --------
  routes.post('/routines/:id/run-now', async (c) => {
    const parsedId = z.string().uuid().safeParse(c.req.param('id'));
    if (!parsedId.success) return c.json({ success: false, error: 'invalid_id', message: 'routine id must be a uuid' }, 400);

    const userId = Number(c.get('user').id);
    const found = await query(ADMIN_AGENT_SQL.routineByIdOwned, [parsedId.data, userId]);
    if (found.rows.length === 0) return c.json({ success: false, error: 'routine_not_found' }, 404);

    const routine = found.rows[0];
    if (!toBool(routine.enabled)) {
      return c.json({ success: false, error: 'routine_disabled', message: `routine '${String(routine.name)}' is disabled; enable it before running now` }, 409);
    }
    const kind = String(routine.kind);
    if (!isJobKind(kind)) {
      return c.json({ success: false, error: 'routine_kind_unknown', message: `routine kind '${kind}' is not a registered agent job kind` }, 500);
    }

    let enqueued: Awaited<ReturnType<AgentQueue['enqueue']>>;
    try {
      enqueued = await enqueue(kind, { routine_id: String(routine.id), config: routine.config ?? {} }, { userId });
    } catch {
      return c.json({ success: false, error: 'enqueue_failed', message: 'the job could not be enqueued' }, 500);
    }
    return c.json({ success: true, data: { job_id: enqueued.id, created: enqueued.created } }, 202);
  });

  // -- GET /runs (unified run history: every job, with routine link) ------------
  routes.get('/runs', async (c) => {
    const status = parseOptionalStatus(c.req.query('status'));
    if (status === 'invalid') return c.json({ success: false, error: 'invalid_status', message: 'status is not a known agent job status' }, 400);
    const kind = parseOptionalKind(c.req.query('kind'));
    if (kind === 'invalid') return c.json({ success: false, error: 'invalid_kind', message: 'kind is not a known agent job kind' }, 400);
    const userId = parseOptionalPositiveInt(c.req.query('user_id'));
    if (userId === 'invalid') return c.json({ success: false, error: 'invalid_user_id', message: 'user_id must be a positive integer' }, 400);
    const cursor = readCursor(c.req.query('cursor'));
    if (cursor.state === 'invalid') return invalidCursorResponse(c);

    const limit = parseLimit(c.req.query('limit'));
    const { text, params } = buildRunsListQuery(
      { userId, status, kind },
      cursor.state === 'ok' ? cursor.value : null,
      limit + 1,
    );
    const result = await query(text, params);
    const page = paginate(result.rows, limit, (row) => {
      const createdAt = isoOrNull(row.created_at);
      return createdAt === null ? null : [createdAt, String(row.id)];
    });
    return c.json({
      success: true,
      data: page.items.map(serializeRun),
      pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor },
    });
  });

  return routes;
}

/** Production singleton mounted at `/api/admin/agent` (see backend/src/index.ts). */
const adminAgentRoutes = createAdminAgentRoutes();

export default adminAgentRoutes;
