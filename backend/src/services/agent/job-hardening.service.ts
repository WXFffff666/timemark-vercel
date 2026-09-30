import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { redactSecrets } from '../bot/redaction.js';
import { isSafePublicUrl } from '../../utils/url-safety.js';
import type { AgentJobKind, AgentQueue, ClaimedJob, FailResult } from './queue.service.js';

/**
 * Checkbox 121: harden the background-job path.
 *
 *  (a) REDACTION AT THE LOGGING SOURCE - `redactJobDetail` deep-walks any payload/result
 *      object, scrubs known secret VALUES and token/document-number SHAPES with the
 *      value-level redaction util (services/bot/redaction.ts - the one the bot outbound
 *      path uses; pino's key-based REDACTED_KEYS cannot see a secret stored inside a
 *      JSONB detail blob), caps the depth and the serialized size. `recordRedactedJobEvent`
 *      is the only sanctioned writer for `agent_job_events.detail`.
 *
 *  (b) NO USER-SUPPLIED URLS - no job kind may fetch a URL from its payload. Every
 *      payload is scanned for URL-shaped strings and rejected (all kinds) with
 *      USER_URL_REJECTED. This EXTENDS the checkbox-110 SSRF rule: 110 decides whether a
 *      URL is safe to fetch; 121 decides that jobs do not fetch user URLs at all, so even
 *      an SSRF-safe public URL is rejected. `classifyUserSuppliedUrl` reuses
 *      `isSafePublicUrl` for diagnostics/telemetry on a rejected URL.
 *
 *  (c) TTL + RETENTION - queued jobs older than AGENT_JOB_QUEUED_TTL_MINUTES (default 24h)
 *      are dead-lettered with QUEUED_TTL_EXPIRED. Terminal jobs are purged with the
 *      checkbox-41-style retention: 90 days of jobs, 30 days of their events.
 *
 *  (d) KILL SWITCH - AGENT_JOBS_ENABLED=false stops CLAIMING: `claimBatchWithKillSwitch`
 *      returns [] so nothing new starts, while in-flight jobs keep their lease and finish
 *      or are reclaimed normally.
 *
 *  (e) TOKEN CEILING - a job that consumes more than AGENT_JOB_TOKEN_CEILING tokens
 *      (default 500_000) fails with JobBudgetError/JOB_TOKEN_CEILING_EXCEEDED and is
 *      failed NON-retryable (`failRunawayJob`), so a runaway job cannot retry forever.
 *
 *  (f) SELF-WATCHDOG - `evaluateQueueWatchdog` alerts when queue depth > 0 and no job has
 *      succeeded for AGENT_WATCHDOG_SILENT_MINUTES (default 30). `runQueueWatchdog` reads
 *      the snapshot and raises the alert (default sink: error log + an Inbox message).
 */

const log = createLogger('job-hardening');

export const JOB_HARDENING_ENV = {
  jobsEnabled: 'AGENT_JOBS_ENABLED',
  queuedTtlMinutes: 'AGENT_JOB_QUEUED_TTL_MINUTES',
  tokenCeiling: 'AGENT_JOB_TOKEN_CEILING',
  watchdogSilentMinutes: 'AGENT_WATCHDOG_SILENT_MINUTES',
} as const;

export const DEFAULT_QUEUED_TTL_MINUTES = 24 * 60;
export const DEFAULT_JOB_TOKEN_CEILING = 500_000;
export const DEFAULT_WATCHDOG_SILENT_MINUTES = 30;
export const JOB_RETENTION_DAYS = 90;
export const JOB_EVENT_RETENTION_DAYS = 30;
export const MAX_JOB_PAYLOAD_BYTES = 64 * 1024;
export const MAX_JOB_DETAIL_BYTES = 16 * 1024;
export const MAX_REDACT_DEPTH = 8;

export const TERMINAL_JOB_STATUSES = ['succeeded', 'failed', 'dead_letter', 'cancelled'] as const;
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

export const JOB_ERROR_CODES = {
  queuedTtlExpired: 'QUEUED_TTL_EXPIRED',
  tokenCeilingExceeded: 'JOB_TOKEN_CEILING_EXCEEDED',
  userUrlRejected: 'USER_URL_REJECTED',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
} as const;

// ---------------------------------------------------------------------------
// (a) Redaction at the logging source
// ---------------------------------------------------------------------------

/**
 * Deep-redact any value for audit storage: strings pass through the shared
 * known-secret + credential/document-shape redactor; objects/arrays recurse.
 * Non-string scalars are returned untouched; the depth cap stops pathological payloads.
 */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[truncated:depth]';
  if (typeof value === 'string') return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map((entry) => redactForAudit(entry, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactForAudit(entry, depth + 1);
    }
    return out;
  }
  return value;
}

/** Redact + size-cap a job detail before it can reach `agent_job_events.detail`. */
export function redactJobDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactForAudit(detail) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= MAX_JOB_DETAIL_BYTES) {
    return redacted;
  }
  return {
    truncated: true,
    max_bytes: MAX_JOB_DETAIL_BYTES,
    preview: (serialized ?? '').slice(0, 512),
  };
}

/** The only sanctioned writer for `agent_job_events` from hardening-aware callers. */
export async function recordRedactedJobEvent(
  jobId: string,
  status: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await query('INSERT INTO agent_job_events (job_id, status, detail) VALUES ($1, $2, $3::jsonb)', [
    jobId,
    status,
    JSON.stringify(redactJobDetail(detail)),
  ]);
}

// ---------------------------------------------------------------------------
// (b) No user-supplied URL - the 110 SSRF rule extended to every job kind
// ---------------------------------------------------------------------------

const URL_SHAPE_RE = /\b(?:https?|ftps?|sftp|file|gopher|ws|wss):\/\/[^\s"'<>\\]+/gi;

/** Every URL-shaped string found anywhere in a payload (nested objects/arrays included). */
export function collectUrlLikeStrings(value: unknown, depth = 0): string[] {
  if (depth > MAX_REDACT_DEPTH) return [];
  if (typeof value === 'string') {
    URL_SHAPE_RE.lastIndex = 0;
    return URL_SHAPE_RE.test(value) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => collectUrlLikeStrings(entry, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((entry) => collectUrlLikeStrings(entry, depth + 1));
  }
  return [];
}

export type JobPayloadRejectionCode = 'USER_URL_REJECTED' | 'PAYLOAD_TOO_LARGE';

export interface JobPayloadValidation {
  ok: boolean;
  code: JobPayloadRejectionCode | null;
  message: string;
  urls: readonly string[];
}

/**
 * Validate a job payload BEFORE a handler can run. A URL-shaped value rejects the
 * payload for EVERY job kind - handlers receive no user-controlled fetch target.
 */
export function validateJobPayload(kind: AgentJobKind, payload: unknown): JobPayloadValidation {
  const serialized = JSON.stringify(payload ?? {});
  if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > MAX_JOB_PAYLOAD_BYTES) {
    return {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: `payload exceeds ${MAX_JOB_PAYLOAD_BYTES} bytes`,
      urls: [],
    };
  }
  const urls = collectUrlLikeStrings(payload);
  if (urls.length > 0) {
    return {
      ok: false,
      code: 'USER_URL_REJECTED',
      message: `job kind '${kind}' must not carry URL-shaped payload values (SSRF rule 110 extended to jobs)`,
      urls,
    };
  }
  return { ok: true, code: null, message: 'ok', urls: [] };
}

export class UserUrlRejectedError extends Error {
  readonly code = JOB_ERROR_CODES.userUrlRejected;
  readonly urls: readonly string[];
  constructor(urls: readonly string[]) {
    super(`user-supplied URLs are rejected for every agent job kind (${urls.length} found)`);
    this.name = 'UserUrlRejectedError';
    this.urls = urls;
  }
}

/** Throwing form for the queue's pre-handler guard. */
export function assertNoUserSuppliedUrl(kind: AgentJobKind, payload: unknown): void {
  const validation = validateJobPayload(kind, payload);
  if (validation.code === 'USER_URL_REJECTED') throw new UserUrlRejectedError(validation.urls);
  if (!validation.ok) throw new Error(`invalid '${kind}' payload: ${validation.message}`);
}

/**
 * Diagnostics only, for a URL that was already rejected: reuses the 110 SSRF check so
 * an operator can see whether the URL was merely public (policy rejection) or an
 * internal target (SSRF attempt). Never grants a fetch permission.
 */
export async function classifyUserSuppliedUrl(
  raw: string,
): Promise<{ allowedForJobs: false; ssrfSafe: boolean; reason: string }> {
  const safety = await isSafePublicUrl(raw);
  return {
    allowedForJobs: false,
    ssrfSafe: safety.safe,
    reason: safety.safe ? 'public_url_forbidden_by_job_policy' : safety.reason ?? 'ssrf_blocked',
  };
}

// ---------------------------------------------------------------------------
// (c) TTL + retention  /  shared SQL
// ---------------------------------------------------------------------------

export const HARDENING_SQL = {
  expireQueued: `
UPDATE agent_jobs
SET status = 'dead_letter',
    error_code = '${JOB_ERROR_CODES.queuedTtlExpired}',
    error_message = $2,
    finished_at = now(),
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    updated_at = now()
WHERE status = 'queued' AND created_at < now() - make_interval(mins => $1::int)
RETURNING id`,
  purgeEvents: `DELETE FROM agent_job_events WHERE at < now() - make_interval(days => $1::int)`,
  purgeJobs: `
DELETE FROM agent_jobs
WHERE status = ANY($1::text[])
  AND finished_at IS NOT NULL
  AND finished_at < now() - make_interval(days => $2::int)`,
  watchdogSnapshot: `
SELECT
  COUNT(*) FILTER (WHERE status IN ('queued', 'leased', 'running'))::int AS depth,
  MAX(finished_at) FILTER (WHERE status = 'succeeded') AS last_success_at
FROM agent_jobs`,
} as const;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readQueuedTtlMinutes(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env[JOB_HARDENING_ENV.queuedTtlMinutes], DEFAULT_QUEUED_TTL_MINUTES);
}

export function readJobTokenCeiling(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env[JOB_HARDENING_ENV.tokenCeiling], DEFAULT_JOB_TOKEN_CEILING);
}

export function readWatchdogSilentMinutes(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env[JOB_HARDENING_ENV.watchdogSilentMinutes], DEFAULT_WATCHDOG_SILENT_MINUTES);
}

/** Dead-letter queued jobs older than the TTL; returns how many were expired. */
export async function expireStaleQueuedJobs(
  options: { ttlMinutes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const ttlMinutes = options.ttlMinutes ?? readQueuedTtlMinutes(options.env ?? process.env);
  const reason = `queued for more than ${ttlMinutes} minutes without being claimed`;
  const result = await query(HARDENING_SQL.expireQueued, [ttlMinutes, reason]);
  const expired = result.rowCount ?? 0;
  if (expired > 0) {
    log.warn({ event: 'agent_jobs.queued_ttl_expired', expired, ttlMinutes }, 'Queued agent jobs dead-lettered by TTL');
  }
  return expired;
}

/** 41-style retention: 90 days of terminal jobs, 30 days of events (cascade-safe order). */
export async function purgeTerminalAgentJobs(
  options: { jobRetentionDays?: number; eventRetentionDays?: number } = {},
): Promise<{ purgedEvents: number; purgedJobs: number }> {
  const jobDays = options.jobRetentionDays ?? JOB_RETENTION_DAYS;
  const eventDays = options.eventRetentionDays ?? JOB_EVENT_RETENTION_DAYS;
  const events = await query(HARDENING_SQL.purgeEvents, [eventDays]);
  const jobs = await query(HARDENING_SQL.purgeJobs, [TERMINAL_JOB_STATUSES, jobDays]);
  return { purgedEvents: events.rowCount ?? 0, purgedJobs: jobs.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// (d) Global kill switch
// ---------------------------------------------------------------------------

/** AGENT_JOBS_ENABLED=false (or 0/off/no/disabled) stops all new claims; default ON. */
export function areAgentJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[JOB_HARDENING_ENV.jobsEnabled] ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !['false', '0', 'off', 'no', 'disabled'].includes(raw);
}

/**
 * Drop-in claim wrapper for the worker loop. Disabled => [] (nothing new starts);
 * in-flight jobs keep their lease and finish, or are reclaimed after lease expiry.
 */
export async function claimBatchWithKillSwitch(
  queue: AgentQueue,
  limit: number,
  leaseSeconds: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaimedJob[]> {
  if (!areAgentJobsEnabled(env)) {
    log.warn(
      { event: 'agent_jobs.claims_disabled' },
      'AGENT_JOBS_ENABLED=false: claim skipped; in-flight jobs may finish or be reclaimed',
    );
    return [];
  }
  return queue.claimBatch(limit, leaseSeconds);
}

// ---------------------------------------------------------------------------
// (e) Per-job token ceiling
// ---------------------------------------------------------------------------

/** Budget error (not a generic Error) so the runner can map it to a non-retryable fail. */
export class JobBudgetError extends Error {
  readonly code = JOB_ERROR_CODES.tokenCeilingExceeded;
  constructor(message: string) {
    super(message);
    this.name = 'JobBudgetError';
  }
}

/** Throws JobBudgetError when the job's token spend crossed the ceiling. */
export function assertJobWithinTokenCeiling(
  costTokens: number,
  ceiling: number = DEFAULT_JOB_TOKEN_CEILING,
): void {
  if (!Number.isFinite(costTokens) || costTokens <= ceiling) return;
  throw new JobBudgetError(`job token ceiling exceeded: consumed ${costTokens} > ceiling ${ceiling}`);
}

/**
 * Fail a runaway job with a budget error and retryable=false, so the queue records a
 * terminal `failed` row instead of requeueing it forever.
 */
export async function failRunawayJob(
  queue: AgentQueue,
  job: ClaimedJob,
  costTokens: number,
  ceiling: number = DEFAULT_JOB_TOKEN_CEILING,
): Promise<FailResult> {
  const message = `token ceiling exceeded: consumed ${costTokens} tokens > ceiling ${ceiling}; failing without retry`;
  log.error(
    { event: 'agent_jobs.token_ceiling_exceeded', jobId: job.id, jobKind: job.kind, costTokens, ceiling },
    'Agent job exceeded its token ceiling; failing terminally',
  );
  return queue.fail(job.id, job.leaseToken, JOB_ERROR_CODES.tokenCeilingExceeded, message, false);
}

// ---------------------------------------------------------------------------
// (f) Self-watchdog
// ---------------------------------------------------------------------------

export interface QueueWatchdogSnapshot {
  /** Jobs in queued/leased/running states. */
  depth: number;
  /** ISO timestamp of the most recent terminal success, or null when none exists. */
  lastSuccessAt: string | null;
}

export interface WatchdogDecision {
  alert: boolean;
  reason: string;
  silentMs: number | null;
  thresholdMs: number;
}

/** Alert when depth > 0 and no success happened within the threshold window. */
export function evaluateQueueWatchdog(
  snapshot: QueueWatchdogSnapshot,
  nowMs: number,
  silentMinutes: number = DEFAULT_WATCHDOG_SILENT_MINUTES,
): WatchdogDecision {
  const thresholdMs = Math.max(1, silentMinutes) * 60_000;
  if (snapshot.depth <= 0) {
    return { alert: false, reason: 'queue_empty', silentMs: null, thresholdMs };
  }
  if (snapshot.lastSuccessAt === null) {
    return { alert: true, reason: 'no_successful_completion_ever', silentMs: null, thresholdMs };
  }
  const lastSuccessMs = Date.parse(snapshot.lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs)) {
    return { alert: true, reason: 'last_success_unparseable', silentMs: null, thresholdMs };
  }
  const silentMs = Math.max(0, nowMs - lastSuccessMs);
  return silentMs >= thresholdMs
    ? { alert: true, reason: 'no_successful_completion', silentMs, thresholdMs }
    : { alert: false, reason: 'recent_success', silentMs, thresholdMs };
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function defaultWatchdogSnapshot(): Promise<QueueWatchdogSnapshot> {
  const result = await query(HARDENING_SQL.watchdogSnapshot);
  const row = (result.rows[0] ?? {}) as { depth?: unknown; last_success_at?: unknown };
  const depth = Number(row.depth);
  return {
    depth: Number.isFinite(depth) && depth > 0 ? Math.trunc(depth) : 0,
    lastSuccessAt: isoOrNull(row.last_success_at),
  };
}

async function defaultWatchdogAlert(decision: WatchdogDecision, snapshot: QueueWatchdogSnapshot): Promise<void> {
  log.error(
    { event: 'agent_jobs.watchdog_alert', reason: decision.reason, depth: snapshot.depth, lastSuccessAt: snapshot.lastSuccessAt, silentMs: decision.silentMs },
    'Agent queue stalled: pending work with no successful completion',
  );
  try {
    const admins = await query('SELECT user_id FROM user_configs LIMIT 1');
    const userId = admins.rows[0]?.user_id;
    if (userId == null) return;
    const { createInboxMessage } = await import('../inbox.service.js');
    await createInboxMessage({
      userId: Number(userId),
      title: 'Agent 队列看门狗告警',
      body: `队列有 ${snapshot.depth} 个未完成作业，且已超过 ${Math.round(decision.thresholdMs / 60_000)} 分钟没有成功完成。${snapshot.lastSuccessAt === null ? '（从未成功）' : `最近成功：${snapshot.lastSuccessAt}`}`,
      source: 'broadcast',
    });
  } catch (error) {
    // Alerting is advisory; a failed inbox write must never crash the watchdog.
    log.warn({ event: 'agent_jobs.watchdog_alert_sink_failed', err: error }, 'Watchdog alert sink failed');
  }
}

export interface QueueWatchdogDeps {
  now?: () => number;
  silentMinutes?: number;
  env?: NodeJS.ProcessEnv;
  snapshot?: () => Promise<QueueWatchdogSnapshot>;
  alert?: (decision: WatchdogDecision, snapshot: QueueWatchdogSnapshot) => Promise<void> | void;
}

export interface QueueWatchdogResult {
  snapshot: QueueWatchdogSnapshot;
  decision: WatchdogDecision;
  alerted: boolean;
}

/** Read the queue state and raise the watchdog alert when the queue is stalled. */
export async function runQueueWatchdog(deps: QueueWatchdogDeps = {}): Promise<QueueWatchdogResult> {
  const env = deps.env ?? process.env;
  const nowMs = (deps.now ?? Date.now)();
  const silentMinutes = deps.silentMinutes ?? readWatchdogSilentMinutes(env);
  const snapshot = await (deps.snapshot ?? defaultWatchdogSnapshot)();
  const decision = evaluateQueueWatchdog(snapshot, nowMs, silentMinutes);
  if (decision.alert) {
    await (deps.alert ?? defaultWatchdogAlert)(decision, snapshot);
  }
  return { snapshot, decision, alerted: decision.alert };
}
