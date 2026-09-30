import { createHash } from 'node:crypto';
import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { isInQuietHours } from '../notifications/index.js';

/**
 * Checkbox 118: daily proactive-notification budget + anti-noise controls.
 *
 * Semantics (single user deployment, counts are still keyed per user):
 *
 *  1. DAILY BUDGET - every proactive send consumes one slot from a per-user,
 *     per-LOCAL-day counter (`agent_budget_usage`, day = user's local date). The
 *     default is 3/day and is configurable via AGENT_NOTIFICATION_BUDGET_PER_DAY
 *     (explicit 0 = no proactive sends; malformed = default). The counter resets at
 *     the user's local midnight because the day key is derived with
 *     Intl.DateTimeFormat in the user's IANA timezone - never by slicing a UTC
 *     ISO string. `msUntilLocalMidnight` exposes the reset distance for schedulers.
 *
 *  2. QUIET HOURS - reuses `isInQuietHours` from services/notifications/index.ts
 *     verbatim (the medication-critical bypass already lives at the call sites that
 *     pass `is_critical` events through). A proactive message that lands inside quiet
 *     hours is FOLDED, not dropped.
 *
 *  3. DEDUPE - identical content (sha256 of a stable JSON rendering) within
 *     AGENT_NOTIFICATION_DEDUPE_WINDOW_MS (default 6h) is skipped. The check is a
 *     claim row; `INSERT ... ON CONFLICT DO NOTHING RETURNING id` returning zero
 *     rows means "already handled in this window".
 *
 *  4. PER-ROUTINE COOLDOWN - the same claim pattern keyed by routine id and
 *     AGENT_ROUTINE_COOLDOWN_MS (default 60 min). A routine cannot nag more often
 *     than its cooldown even when the message content differs.
 *
 *  5. SUPPRESSION ACCOUNTING - every message that is folded or cooldown-skipped
 *     increments `suppressed_count` for the user's local day. `getTodayBudgetUsage`
 *     is the UI source for `今天已抑制 N 条` / `今天已发送 N 条`.
 *
 *  6. FOLD ON EXHAUSTION - when the budget is exhausted a NON-urgent routine's
 *     content is folded into the next Inbox digest (`agent_digest_folds`) instead of
 *     being sent. `urgent` proactive items still send (recorded as over budget).
 *
 *  7. EXCLUSIONS - the `critical` class (e.g. medication critical reminders) and
 *     `user_initiated` replies never count against the budget and are always allowed;
 *     user-initiated replies are explicitly allowed even at 03:00 inside quiet hours.
 *     `isCriticalNotification` recognises the medication-critical types.
 *
 * The split between `decideProactiveNotification` (pure) and `gateProactiveNotification`
 * (data-bound) keeps the ordering rules testable without a database; the orchestrated
 * path re-checks claims/budget after every write so a concurrent worker can never
 * double-spend the budget (the consume statement is conditional on `sent_count < limit`).
 */

const log = createLogger('notification-budget');

export const NOTIFICATION_BUDGET_ENV = {
  perDay: 'AGENT_NOTIFICATION_BUDGET_PER_DAY',
  dedupeWindowMs: 'AGENT_NOTIFICATION_DEDUPE_WINDOW_MS',
  routineCooldownMs: 'AGENT_ROUTINE_COOLDOWN_MS',
} as const;

export const DEFAULT_PROACTIVE_BUDGET_PER_DAY = 3;
export const DEFAULT_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_ROUTINE_COOLDOWN_MS = 60 * 60 * 1000;

/** The notification classes the gate understands. */
export type ProactiveNotificationClass = 'critical' | 'user_initiated' | 'urgent' | 'routine';

/** Types that belong to the critical class and are excluded from budget/quiet-hours controls. */
export const CRITICAL_NOTIFICATION_TYPES: readonly string[] = [
  'medication_critical',
  'medication_missed_critical',
];

export type NotificationClaimScope = 'dedupe' | 'routine_cooldown';

export type NotificationGateAction =
  | 'send'
  | 'dedupe_skip'
  | 'cooldown_skip'
  | 'quiet_hours_fold'
  | 'budget_fold'
  | 'critical_bypass'
  | 'user_reply_bypass';

export interface NotificationBudgetConfig {
  perDay: number;
  dedupeWindowMs: number;
  routineCooldownMs: number;
}

function readNonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Read the budget configuration from the environment at call time (serverless cold starts). */
export function readNotificationBudgetConfig(env: NodeJS.ProcessEnv = process.env): NotificationBudgetConfig {
  return {
    perDay: readNonNegativeInt(env[NOTIFICATION_BUDGET_ENV.perDay], DEFAULT_PROACTIVE_BUDGET_PER_DAY),
    dedupeWindowMs: readNonNegativeInt(env[NOTIFICATION_BUDGET_ENV.dedupeWindowMs], DEFAULT_DEDUPE_WINDOW_MS),
    routineCooldownMs: readNonNegativeInt(env[NOTIFICATION_BUDGET_ENV.routineCooldownMs], DEFAULT_ROUTINE_COOLDOWN_MS),
  };
}

/** True when a notification belongs to the critical class (medication critical etc.). */
export function isCriticalNotification(type: string | null | undefined, explicitCritical = false): boolean {
  if (explicitCritical) return true;
  return typeof type === 'string' && CRITICAL_NOTIFICATION_TYPES.includes(type);
}

// ---------------------------------------------------------------------------
// Timezone-aware local day (the budget resets at the user's local midnight)
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = `${timezone}:${options.year ?? ''}:${options.month ?? ''}:${options.day ?? ''}:${options.hour ?? ''}:${options.minute ?? ''}:${options.second ?? ''}`;
  let formatter = formatterCache.get(cacheKey);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, ...options });
    formatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

/** The user's local calendar day as `YYYY-MM-DD` (the `agent_budget_usage.day` key). */
export function getLocalDayKey(now: Date, timezone: string): string {
  const parts = formatterFor(timezone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * Milliseconds until the user's next local midnight. Approximate across DST
 * (the clock shift is <= 1h and only the reset instant is affected, never the day key).
 */
export function msUntilLocalMidnight(now: Date, timezone: string): number {
  const parts = formatterFor(timezone, { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false }).formatToParts(now);
  const pick = (type: string): number => Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10) || 0;
  const secondsSinceMidnight = pick('hour') * 3600 + pick('minute') * 60 + pick('second');
  return Math.max(0, (86_400 - secondsSinceMidnight) * 1000 - now.getMilliseconds());
}

/** Claim/dedupe window bucket: floor(epochMs / windowMs). */
export function windowBucket(epochMs: number, windowMs: number): number {
  const safeWindow = windowMs > 0 ? windowMs : DEFAULT_DEDUPE_WINDOW_MS;
  return Math.floor(epochMs / safeWindow);
}

// ---------------------------------------------------------------------------
// Content hashing (stable across key order, so the same content dedupes)
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** sha256 of a stable JSON rendering; the dedupe claim key. */
export function computeContentHash(input: unknown): string {
  const text = typeof input === 'string' ? input : stableStringify(input);
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export const NOTIFICATION_BUDGET_SQL = {
  readDay: `
SELECT sent_count, suppressed_count
FROM agent_budget_usage
WHERE user_id = $1 AND day = $2::date`,
  consume: `
INSERT INTO agent_budget_usage (user_id, day, sent_count, suppressed_count, updated_at)
VALUES ($1, $2::date, 1, 0, now())
ON CONFLICT (user_id, day) DO UPDATE
  SET sent_count = agent_budget_usage.sent_count + 1,
      updated_at = now()
WHERE agent_budget_usage.sent_count < $3
RETURNING sent_count`,
  suppress: `
INSERT INTO agent_budget_usage (user_id, day, sent_count, suppressed_count, updated_at)
VALUES ($1, $2::date, 0, 1, now())
ON CONFLICT (user_id, day) DO UPDATE
  SET suppressed_count = agent_budget_usage.suppressed_count + 1,
      updated_at = now()
RETURNING suppressed_count`,
  claim: `
INSERT INTO agent_notification_claims (user_id, scope, claim_key, window_bucket)
VALUES ($1, $2, $3, $4)
ON CONFLICT (user_id, scope, claim_key, window_bucket) DO NOTHING
RETURNING id`,
  hasClaim: `
SELECT id FROM agent_notification_claims
WHERE user_id = $1 AND scope = $2 AND claim_key = $3 AND window_bucket = $4
LIMIT 1`,
  fold: `
INSERT INTO agent_digest_folds (user_id, routine_id, notification_class, title, body, reason)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id`,
  pendingFolds: `
SELECT id, routine_id, notification_class, title, body, reason, created_at
FROM agent_digest_folds
WHERE user_id = $1 AND consumed_at IS NULL
ORDER BY created_at ASC, id ASC
LIMIT 100`,
  consumeFolds: `
UPDATE agent_digest_folds
SET consumed_at = now()
WHERE user_id = $1 AND consumed_at IS NULL AND id = ANY($2::bigint[])
RETURNING id`,
} as const;

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------

export interface TodayBudgetUsage {
  day: string;
  limit: number;
  sentToday: number;
  suppressedToday: number;
  remaining: number;
}

/** Today's counters for one user; the UI shows `今天已抑制 {suppressedToday} 条`. */
export async function getTodayBudgetUsage(
  userId: number,
  timezone: string,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<TodayBudgetUsage> {
  const config = readNotificationBudgetConfig(env);
  const day = getLocalDayKey(now, timezone);
  const result = await query(NOTIFICATION_BUDGET_SQL.readDay, [userId, day]);
  const row = (result.rows[0] ?? {}) as { sent_count?: unknown; suppressed_count?: unknown };
  const sentToday = toCount(row.sent_count);
  return {
    day,
    limit: config.perDay,
    sentToday,
    suppressedToday: toCount(row.suppressed_count),
    remaining: Math.max(0, config.perDay - sentToday),
  };
}

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/**
 * Atomically consume one slot. The conditional upsert (`WHERE sent_count < limit`)
 * makes the limit hold under concurrency: zero returned rows = exhausted.
 */
export async function tryConsumeDailyBudget(
  userId: number,
  dayKey: string,
  limit: number,
): Promise<{ allowed: boolean; sentCount: number }> {
  const result = await query(NOTIFICATION_BUDGET_SQL.consume, [userId, dayKey, limit]);
  if (result.rows.length === 0) return { allowed: false, sentCount: limit };
  return { allowed: true, sentCount: toCount(result.rows[0]?.sent_count) };
}

/** Increment the suppression counter for the user's local day; returns the new total. */
export async function recordSuppressedNotification(userId: number, dayKey: string): Promise<number> {
  const result = await query(NOTIFICATION_BUDGET_SQL.suppress, [userId, dayKey]);
  return toCount(result.rows[0]?.suppressed_count);
}

/** Read-only probe: has this key already been claimed in the current window bucket? */
export async function hasRecentClaim(
  userId: number,
  scope: NotificationClaimScope,
  claimKey: string,
  epochMs: number,
  windowMs: number,
): Promise<boolean> {
  const result = await query(NOTIFICATION_BUDGET_SQL.hasClaim, [
    userId,
    scope,
    claimKey,
    windowBucket(epochMs, windowMs),
  ]);
  return result.rows.length > 0;
}

/**
 * Claim a key in the current window bucket (reminder_send_claims pattern):
 * false = the claim already existed, i.e. a duplicate that must be skipped.
 */
export async function claimNotificationKey(
  userId: number,
  scope: NotificationClaimScope,
  claimKey: string,
  epochMs: number,
  windowMs: number,
): Promise<boolean> {
  const result = await query(NOTIFICATION_BUDGET_SQL.claim, [
    userId,
    scope,
    claimKey,
    windowBucket(epochMs, windowMs),
  ]);
  return result.rows.length > 0;
}

export interface DigestFoldEntry {
  routineId: string | null;
  notificationClass: ProactiveNotificationClass;
  title: string;
  body: string;
  reason: string;
}

/** Fold a suppressed message into the next Inbox digest; returns the fold row id. */
export async function foldIntoDigest(userId: number, entry: DigestFoldEntry): Promise<number | null> {
  const result = await query(NOTIFICATION_BUDGET_SQL.fold, [
    userId,
    entry.routineId,
    entry.notificationClass,
    entry.title,
    entry.body,
    entry.reason,
  ]);
  if (result.rows.length === 0) return null;
  return Number(result.rows[0]?.id);
}

export interface PendingFold {
  id: number;
  routine_id: string | null;
  notification_class: string;
  title: string;
  body: string;
  reason: string;
  created_at: string | null;
}

/** Pending folds for the digest consumer (digest.service.ts / inbox.service.ts). */
export async function listPendingFolds(userId: number): Promise<PendingFold[]> {
  const result = await query(NOTIFICATION_BUDGET_SQL.pendingFolds, [userId]);
  return result.rows.map((row) => ({
    id: Number(row.id),
    routine_id: row.routine_id == null ? null : String(row.routine_id),
    notification_class: String(row.notification_class ?? 'routine'),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    reason: String(row.reason ?? ''),
    created_at: row.created_at == null ? null : String(row.created_at),
  }));
}

/** Mark folds as consumed after the digest incorporated them. Returns rows consumed. */
export async function consumeFolds(userId: number, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await query(NOTIFICATION_BUDGET_SQL.consumeFolds, [userId, ids]);
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------

export interface ProactiveGateInput {
  notificationClass: ProactiveNotificationClass;
  timezone: string;
  quietStart: string | null;
  quietEnd: string | null;
  sentToday: number;
  config: NotificationBudgetConfig;
  duplicateWithinWindow: boolean;
  routineWithinCooldown: boolean;
}

export interface ProactiveGateDecision {
  action: NotificationGateAction;
  /** True when the message may hit a channel. */
  allowed: boolean;
  /** True when an allowed send consumes a daily-budget slot. */
  counted: boolean;
  reason: string;
}

/**
 * Pure gate. Ordering is the contract:
 *   critical / user_initiated bypass -> dedupe -> routine cooldown -> quiet hours
 *   -> budget (routine folds; urgent sends over budget) -> send.
 */
export function decideProactiveNotification(input: ProactiveGateInput): ProactiveGateDecision {
  if (input.notificationClass === 'critical') {
    return { action: 'critical_bypass', allowed: true, counted: false, reason: 'critical_class_excluded' };
  }
  if (input.notificationClass === 'user_initiated') {
    return { action: 'user_reply_bypass', allowed: true, counted: false, reason: 'user_initiated_reply_never_counted' };
  }
  if (input.duplicateWithinWindow) {
    return { action: 'dedupe_skip', allowed: false, counted: false, reason: 'duplicate_content' };
  }
  if (input.routineWithinCooldown) {
    return { action: 'cooldown_skip', allowed: false, counted: false, reason: 'routine_cooldown' };
  }
  if (isInQuietHours(input.quietStart, input.quietEnd, input.timezone)) {
    return { action: 'quiet_hours_fold', allowed: false, counted: false, reason: 'quiet_hours' };
  }
  if (input.sentToday >= input.config.perDay) {
    if (input.notificationClass === 'urgent') {
      return { action: 'send', allowed: true, counted: false, reason: 'urgent_over_budget' };
    }
    return { action: 'budget_fold', allowed: false, counted: false, reason: 'budget_exhausted' };
  }
  return { action: 'send', allowed: true, counted: true, reason: 'within_daily_budget' };
}

// ---------------------------------------------------------------------------
// Orchestrated path (claims + budget + fold accounting)
// ---------------------------------------------------------------------------

export interface ProactiveNotificationRequest {
  userId: number;
  notificationClass: ProactiveNotificationClass;
  timezone: string;
  quietStart?: string | null;
  quietEnd?: string | null;
  title: string;
  body: string;
  routineId?: string | null;
  /** Pre-computed content hash (defaults to a hash of title + body). */
  contentHash?: string | null;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface ProactiveNotificationOutcome {
  action: NotificationGateAction;
  allowed: boolean;
  reason: string;
  sentToday: number;
  suppressedToday: number;
  foldedId: number | null;
}

export interface ProactiveNotificationDeps {
  readUsage?: (userId: number, dayKey: string) => Promise<{ sent: number; suppressed: number }>;
  /** Claim probe seam; the clock+window are passed so each scope buckets with its own window. */
  hasClaim?: (userId: number, scope: NotificationClaimScope, key: string, epochMs: number, windowMs: number) => Promise<boolean>;
  claim?: (userId: number, scope: NotificationClaimScope, key: string, epochMs: number, windowMs: number) => Promise<boolean>;
  consume?: (userId: number, dayKey: string, limit: number) => Promise<{ allowed: boolean; sentCount: number }>;
  suppress?: (userId: number, dayKey: string) => Promise<number>;
  fold?: (userId: number, entry: DigestFoldEntry) => Promise<number | null>;
}

async function readBudgetRow(userId: number, dayKey: string): Promise<{ sent: number; suppressed: number }> {
  const result = await query(NOTIFICATION_BUDGET_SQL.readDay, [userId, dayKey]);
  const row = (result.rows[0] ?? {}) as { sent_count?: unknown; suppressed_count?: unknown };
  return { sent: toCount(row.sent_count), suppressed: toCount(row.suppressed_count) };
}

/**
 * Gate one proactive notification end-to-end. Returns the outcome the caller acts on:
 * `allowed === true` => send; `foldedId !== null` => content was folded into the digest.
 * User-initiated replies and the critical class short-circuit without touching the
 * counter/claims (and therefore never consume budget, even in quiet hours).
 */
export async function gateProactiveNotification(
  request: ProactiveNotificationRequest,
  deps: ProactiveNotificationDeps = {},
): Promise<ProactiveNotificationOutcome> {
  const env = request.env ?? process.env;
  const config = readNotificationBudgetConfig(env);
  const now = request.now ?? new Date();
  const epochMs = now.getTime();
  const dayKey = getLocalDayKey(now, request.timezone);
  const quietStart = request.quietStart ?? null;
  const quietEnd = request.quietEnd ?? null;
  const routineId = request.routineId ?? null;
  const contentHash = request.contentHash ?? computeContentHash({ title: request.title, body: request.body });

  const readUsage = deps.readUsage ?? readBudgetRow;
  const hasClaim = deps.hasClaim ?? hasRecentClaim;
  const claim = deps.claim ?? claimNotificationKey;
  const consume = deps.consume ?? tryConsumeDailyBudget;
  const suppress = deps.suppress ?? recordSuppressedNotification;
  const fold = deps.fold ?? foldIntoDigest;

  const usage = await readUsage(request.userId, dayKey);

  const duplicateWithinWindow = await hasClaim(request.userId, 'dedupe', contentHash, epochMs, config.dedupeWindowMs);
  const routineWithinCooldown =
    routineId !== null && (await hasClaim(request.userId, 'routine_cooldown', routineId, epochMs, config.routineCooldownMs));

  const decision = decideProactiveNotification({
    notificationClass: request.notificationClass,
    timezone: request.timezone,
    quietStart,
    quietEnd,
    sentToday: usage.sent,
    config,
    duplicateWithinWindow,
    routineWithinCooldown,
  });

  const outcome = (
    settled: ProactiveGateDecision,
    sent: number,
    suppressed: number,
    foldedId: number | null,
  ): ProactiveNotificationOutcome => ({
    action: settled.action,
    allowed: settled.allowed,
    reason: settled.reason,
    sentToday: sent,
    suppressedToday: suppressed,
    foldedId,
  });

  if (decision.action === 'critical_bypass' || decision.action === 'user_reply_bypass') {
    return outcome(decision, usage.sent, usage.suppressed, null);
  }

  if (decision.action === 'dedupe_skip') {
    return outcome(decision, usage.sent, usage.suppressed, null);
  }

  if (decision.action === 'cooldown_skip') {
    const suppressed = await suppress(request.userId, dayKey);
    return outcome(decision, usage.sent, suppressed, null);
  }

  const foldEntry: DigestFoldEntry = {
    routineId,
    notificationClass: request.notificationClass,
    title: request.title,
    body: request.body,
    reason: decision.reason,
  };

  if (decision.action === 'quiet_hours_fold' || decision.action === 'budget_fold') {
    const foldedId = await fold(request.userId, foldEntry);
    const suppressed = await suppress(request.userId, dayKey);
    log.info(
      { event: 'notification.folded', userId: request.userId, reason: decision.reason, foldedId },
      'Proactive notification folded into the next Inbox digest',
    );
    return outcome(decision, usage.sent, suppressed, foldedId);
  }

  // action === 'send': win the claims first, then consume the budget atomically.
  const dedupeWon = await claim(request.userId, 'dedupe', contentHash, epochMs, config.dedupeWindowMs);
  if (!dedupeWon) {
    return outcome({ ...decision, action: 'dedupe_skip', allowed: false, counted: false, reason: 'duplicate_content_race' }, usage.sent, usage.suppressed, null);
  }

  if (routineId !== null) {
    const cooldownWon = await claim(request.userId, 'routine_cooldown', routineId, epochMs, config.routineCooldownMs);
    if (!cooldownWon) {
      const suppressed = await suppress(request.userId, dayKey);
      return outcome({ ...decision, action: 'cooldown_skip', allowed: false, counted: false, reason: 'routine_cooldown_race' }, usage.sent, suppressed, null);
    }
  }

  if (request.notificationClass === 'routine') {
    const consumed = await consume(request.userId, dayKey, config.perDay);
    if (!consumed.allowed) {
      // A concurrent send exhausted the budget after the read: fold after all.
      const foldedId = await fold(request.userId, { ...foldEntry, reason: 'budget_exhausted_race' });
      const suppressed = await suppress(request.userId, dayKey);
      return outcome({ ...decision, action: 'budget_fold', allowed: false, counted: false, reason: 'budget_exhausted_race' }, consumed.sentCount, suppressed, foldedId);
    }
    return outcome(decision, consumed.sentCount, usage.suppressed, null);
  }

  // urgent: best-effort budget consumption; it sends even when over budget.
  if (config.perDay > 0) {
    const consumed = await consume(request.userId, dayKey, config.perDay);
    if (!consumed.allowed) {
      log.warn(
        { event: 'notification.urgent_over_budget', userId: request.userId, sentToday: consumed.sentCount, limit: config.perDay },
        'Urgent proactive notification sent over the daily budget',
      );
      return outcome(decision, consumed.sentCount, usage.suppressed, null);
    }
    return outcome(decision, consumed.sentCount, usage.suppressed, null);
  }

  return outcome(decision, usage.sent, usage.suppressed, null);
}
