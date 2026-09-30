import { parseChannelAccountIds } from '@timemark/shared';
import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { getUserConfig, getNotificationAccounts } from '../config.service.js';
import { sendNotifications } from '../notifications/index.js';
import {
  DEFAULT_DEGRADED_WINDOW_MS,
  isQueueStalled,
  readQueueHealth,
  resolveQueueStallMs,
} from './run-observability.service.js';

/**
 * Checkbox 130: the self-watchdog of the background AI.
 *
 * THREE conditions are watched, each with its own specific reason (never a generic
 * "error"):
 *
 *  - `queue_stalled`     queued work exists and its oldest item has waited past
 *                        `AGENT_QUEUE_STALL_MS` (default 15 min);
 *  - `routine_failing`   one routine (or job kind) failed N consecutive runs
 *                        (`AGENT_ROUTINE_FAILURE_THRESHOLD`, default 3);
 *  - `provider_errors`   N provider-side failures (`PROVIDER_ERROR` run records)
 *                        inside the error window (`AGENT_PROVIDER_ERROR_WINDOW_MS`,
 *                        default 1 h; threshold `AGENT_PROVIDER_ERROR_THRESHOLD`,
 *                        default 3).
 *
 * ALERTING DISCIPLINE (hard requirements):
 *  - exactly ONE alert per distinct condition per window
 *    (`AGENT_WATCHDOG_WINDOW_MS`, default 6 h) - a still-active condition is NOT
 *    re-alerted before the window elapses, and never more than once per window;
 *  - a daily alert budget (`AGENT_WATCHDOG_ALERT_BUDGET`, default 6 per rolling
 *    24 h) caps ALL watchdog notifications - alerts drop silently (state stays
 *    active) once the budget is spent, no repeat spam;
 *  - recovery CLEARS the episode state and sends AT MOST ONE recovery note (only
 *    when an alert actually went out for that episode).
 *
 * Alert state is persisted (NOT module state - Vercel instances are per-invocation)
 * in the existing `agent_workers` registry under id `self-watchdog`; a state read
 * failure fails CLOSED (no alert) so a broken store can never cause alert storms.
 *
 * Notification dispatch defaults to the existing user-configured alert channels
 * (the same recipients the security alerts use) and is injectable, so the
 * notification-budget layer (checkbox 118) or tests can replace it without touching
 * this module.
 *
 * Privacy: notifications and logs carry counters, routine names/ids and enums ONLY.
 * Prompt bodies, completions and credentials are never included.
 */

const log = createLogger('agent-watchdog');

export const WATCHDOG_WORKER_ID = 'self-watchdog';
export const ALERT_WINDOW_MS_ENV = 'AGENT_WATCHDOG_WINDOW_MS';
export const ALERT_BUDGET_ENV = 'AGENT_WATCHDOG_ALERT_BUDGET';
export const ROUTINE_FAILURE_THRESHOLD_ENV = 'AGENT_ROUTINE_FAILURE_THRESHOLD';
export const PROVIDER_ERROR_THRESHOLD_ENV = 'AGENT_PROVIDER_ERROR_THRESHOLD';
export const PROVIDER_ERROR_WINDOW_MS_ENV = 'AGENT_PROVIDER_ERROR_WINDOW_MS';

export const WATCHDOG_DEFAULTS = {
  /** One alert per condition per this window. */
  alertWindowMs: 6 * 60 * 60 * 1000,
  /** Rolling 24 h cap across ALL watchdog notifications (the notification budget). */
  dailyAlertBudget: 6,
  /** Consecutive failed runs that flag a routine. */
  routineFailureThreshold: 3,
  /** Provider failures inside the window that flag the provider. */
  providerErrorThreshold: 3,
  providerErrorWindowMs: 60 * 60 * 1000,
  /** How far back consecutive-failure streaks are computed. */
  failureLookbackMs: DEFAULT_DEGRADED_WINDOW_MS,
} as const;

type WatchdogEnv = Record<string, string | undefined>;

export type AgentWatchdogConditionKind = 'queue_stalled' | 'routine_failing' | 'provider_errors';

export interface AgentWatchdogCondition {
  /** Stable identity of the condition (e.g. `routine_failing:routine:<uuid>`). */
  key: string;
  kind: AgentWatchdogConditionKind;
  /** Specific, human-readable reason (Chinese, shown in the alert and the health payload). */
  reason: string;
  detail: Record<string, unknown>;
}

export interface AgentWatchdogResult {
  ok: boolean;
  evaluatedAt: string;
  conditions: AgentWatchdogCondition[];
  alertsSent: number;
  recoveriesSent: number;
  budgetRemaining: number;
  error?: string;
}

export interface WatchdogNotification {
  type: 'alert' | 'recovery';
  condition: AgentWatchdogCondition;
  title: string;
  body: string;
}

export type WatchdogNotifier = (notification: WatchdogNotification) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function envInt(env: WatchdogEnv, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface WatchdogConfig {
  alertWindowMs: number;
  dailyAlertBudget: number;
  routineFailureThreshold: number;
  providerErrorThreshold: number;
  providerErrorWindowMs: number;
}

export function resolveWatchdogConfig(env: WatchdogEnv = process.env): WatchdogConfig {
  return {
    alertWindowMs: envInt(env, ALERT_WINDOW_MS_ENV, WATCHDOG_DEFAULTS.alertWindowMs),
    dailyAlertBudget: envInt(env, ALERT_BUDGET_ENV, WATCHDOG_DEFAULTS.dailyAlertBudget),
    routineFailureThreshold: envInt(
      env,
      ROUTINE_FAILURE_THRESHOLD_ENV,
      WATCHDOG_DEFAULTS.routineFailureThreshold,
    ),
    providerErrorThreshold: envInt(env, PROVIDER_ERROR_THRESHOLD_ENV, WATCHDOG_DEFAULTS.providerErrorThreshold),
    providerErrorWindowMs: envInt(env, PROVIDER_ERROR_WINDOW_MS_ENV, WATCHDOG_DEFAULTS.providerErrorWindowMs),
  };
}

// ---------------------------------------------------------------------------
// Condition detection
// ---------------------------------------------------------------------------

/** Newest-first run outcomes over the lookback window (one row per executed run). */
export const FAILURE_STREAK_SQL = `
SELECT e.detail->>'routine_id' AS routine_id,
       e.detail->>'job_kind' AS kind,
       e.detail->>'outcome' AS outcome,
       e.at
FROM agent_job_events e
WHERE e.status = 'run_record'
  AND e.at >= now() - make_interval(secs => $1::double precision)
ORDER BY e.at DESC
LIMIT 200`;

export const PROVIDER_ERROR_COUNT_SQL = `
SELECT COUNT(*)::int AS errors
FROM agent_job_events e
WHERE e.status = 'run_record'
  AND e.detail->>'degraded_reason' = 'PROVIDER_ERROR'
  AND e.at >= now() - make_interval(secs => $1::double precision)`;

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function formatMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** Evaluate every watchdog condition against the database. Never throws per-condition. */
export async function detectAgentWatchdogConditions(
  options: { nowMs?: number; env?: WatchdogEnv } = {},
): Promise<AgentWatchdogCondition[]> {
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env ?? process.env;
  const config = resolveWatchdogConfig(env);
  const conditions: AgentWatchdogCondition[] = [];

  // 1. Queue stall: queued work exists and the oldest item has waited past the threshold.
  const queue = await readQueueHealth(nowMs);
  const stallMs = resolveQueueStallMs(env);
  if (isQueueStalled(queue.depth, queue.oldestQueuedAgeMs, stallMs)) {
    conditions.push({
      key: 'queue_stalled',
      kind: 'queue_stalled',
      reason: `队列停滞：${queue.depth} 个任务排队，最早已等待 ${formatMinutes(queue.oldestQueuedAgeMs ?? 0)} 分钟`,
      detail: {
        depth: queue.depth,
        oldestQueuedAgeMs: queue.oldestQueuedAgeMs,
        stallThresholdMs: stallMs,
      },
    });
  }

  // 2. Consecutive routine failures: newest run per routine/kind, counted backwards
  //    until the first success/degradation (a budget skip is NOT a failure).
  const streaks = await query(FAILURE_STREAK_SQL, [Math.trunc(WATCHDOG_DEFAULTS.failureLookbackMs / 1000)]);
  const perKey = new Map<string, { count: number; routineId: string | null; kind: string | null }>();
  const finished = new Set<string>();
  for (const row of streaks.rows) {
    const routineId = row.routine_id == null ? null : String(row.routine_id);
    const kind = row.kind == null ? null : String(row.kind);
    const key = routineId ? `routine:${routineId}` : `kind:${kind ?? 'unknown'}`;
    if (finished.has(key)) continue;
    const outcome = String(row.outcome ?? '');
    if (outcome !== 'failed' && outcome !== 'timeout') {
      finished.add(key);
      continue;
    }
    const current = perKey.get(key) ?? { count: 0, routineId, kind };
    current.count += 1;
    perKey.set(key, current);
  }
  for (const [key, streak] of perKey) {
    if (streak.count < config.routineFailureThreshold) continue;
    const label = streak.routineId ?? streak.kind ?? key;
    conditions.push({
      key: `routine_failing:${key}`,
      kind: 'routine_failing',
      reason: `例行任务连续失败 ${streak.count} 次：${label}`,
      detail: {
        routineId: streak.routineId,
        kind: streak.kind,
        consecutiveFailures: streak.count,
        threshold: config.routineFailureThreshold,
      },
    });
  }

  // 3. Provider errors above the threshold inside the window.
  const providerWindowSec = Math.max(1, Math.trunc(config.providerErrorWindowMs / 1000));
  const providerErrors = await query(PROVIDER_ERROR_COUNT_SQL, [providerWindowSec]);
  const errorCount = toCount(providerErrors.rows[0]?.errors);
  if (errorCount >= config.providerErrorThreshold) {
    conditions.push({
      key: 'provider_errors',
      kind: 'provider_errors',
      reason: `AI 供应商持续报错：${formatMinutes(config.providerErrorWindowMs)} 分钟内 ${errorCount} 次`,
      detail: {
        errors: errorCount,
        windowMs: config.providerErrorWindowMs,
        threshold: config.providerErrorThreshold,
      },
    });
  }

  return conditions;
}

// ---------------------------------------------------------------------------
// Persisted alert state (agent_workers registry row `self-watchdog`)
// ---------------------------------------------------------------------------

interface WatchdogEpisode {
  kind: AgentWatchdogConditionKind;
  firstSeenAt: string;
  /** When an alert for THIS episode actually went out; null = alert not delivered yet. */
  alertedAt: string | null;
  /** Start of the current alert window (advances each time a new alert is sent). */
  windowStartAt: string;
  detail: Record<string, unknown>;
}

interface WatchdogState {
  episodes: Record<string, WatchdogEpisode>;
  /** Timestamps of delivered watchdog notifications (alerts + recoveries), rolling 24 h. */
  alertsSentAt: string[];
  lastEvaluatedAt: string | null;
}

const STATE_READ_SQL = `SELECT meta FROM agent_workers WHERE id = $1`;
const STATE_WRITE_SQL = `
INSERT INTO agent_workers (id, kind, last_seen_at, meta)
VALUES ($1, 'watchdog', now(), $2::jsonb)
ON CONFLICT (id) DO UPDATE SET kind = 'watchdog', last_seen_at = now(), meta = $2::jsonb`;

function emptyState(): WatchdogState {
  return { episodes: {}, alertsSentAt: [], lastEvaluatedAt: null };
}

/** Read the persisted watchdog state; throws when the store is unavailable. */
export async function loadWatchdogState(): Promise<WatchdogState> {
  const result = await query(STATE_READ_SQL, [WATCHDOG_WORKER_ID]);
  const raw = result.rows[0]?.meta;
  if (raw == null || typeof raw !== 'object') return emptyState();
  const meta = raw as Partial<WatchdogState>;
  return {
    episodes: typeof meta.episodes === 'object' && meta.episodes !== null ? meta.episodes : {},
    alertsSentAt: Array.isArray(meta.alertsSentAt) ? meta.alertsSentAt.filter((v) => typeof v === 'string') : [],
    lastEvaluatedAt: typeof meta.lastEvaluatedAt === 'string' ? meta.lastEvaluatedAt : null,
  };
}

async function saveWatchdogState(state: WatchdogState): Promise<void> {
  await query(STATE_WRITE_SQL, [WATCHDOG_WORKER_ID, JSON.stringify(state)]);
}

// ---------------------------------------------------------------------------
// Notification dispatch (default: the user's configured alert channels)
// ---------------------------------------------------------------------------

function notificationBody(
  type: WatchdogNotification['type'],
  condition: AgentWatchdogCondition,
  nowMs: number,
): string {
  return [
    `事件: ${condition.reason}`,
    `条件: ${condition.key}`,
    `详情: ${JSON.stringify(condition.detail)}`,
    `时间: ${new Date(nowMs).toISOString()}`,
    type === 'alert'
      ? 'AI 后台已降级；核心提醒、待办与集成功能不受影响。'
      : 'AI 后台已恢复，后续任务将正常执行。',
  ].join('\n');
}

/**
 * Default notifier: send through the SAME user-configured alert recipients as the
 * security alerts (channel accounts bound to alert settings, falling back to the
 * legacy alert_channels list). Returns true only when a dispatch actually went out.
 */
export async function defaultWatchdogNotifier(
  notification: WatchdogNotification,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const userRows = await query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    const userId = Number(userRows.rows[0]?.id);
    if (!Number.isFinite(userId)) return false;

    const config = await getUserConfig(userId);
    const alertEmails: string[] = Array.isArray(config?.alert_emails) ? config.alert_emails : [];
    const alertAccountIds = parseChannelAccountIds(config?.alert_account_ids);
    const legacyChannels: string[] = Array.isArray(config?.alert_channels) ? config.alert_channels : [];
    if (alertAccountIds.length === 0 && legacyChannels.length === 0) {
      log.warn(
        { event: 'agent_watchdog.no_alert_recipients', conditionKey: notification.condition.key },
        'No alert recipients configured; the watchdog notification cannot be delivered',
      );
      return false;
    }

    const accounts = (await getNotificationAccounts(userId)).filter((account) => account.is_active);
    const selected =
      alertAccountIds.length > 0
        ? accounts.filter((account) => alertAccountIds.includes(Number(account.id)))
        : accounts.filter((account) => legacyChannels.includes(account.type));
    if (selected.length === 0) return false;

    const channelTypes = [...new Set(selected.map((account) => account.type))];
    // Display-only date on the synthetic notification event (mirrors alert.service.ts).
    const eventDate = new Date(nowMs).toISOString().split('T')[0];
    const alertEvent = {
      id: 0,
      name: notification.title,
      event_date: eventDate,
      event_type: 'other',
      calendar_type: 'gregorian',
      reminder_times: [],
      notification_account_ids: selected.map((account) => account.id),
      personName: 'TimeMark AI',
      customMessage: notificationBody(notification.type, notification.condition, nowMs),
      reminderConfig: { emailRecipients: alertEmails },
    };
    await sendNotifications(alertEvent, userId, channelTypes, { skipQuietHours: true });
    return true;
  } catch (error) {
    log.error(
      { event: 'agent_watchdog.notify_failed', conditionKey: notification.condition.key, err: error },
      'Dispatching the watchdog notification failed',
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// The evaluation loop
// ---------------------------------------------------------------------------

export interface RunAgentWatchdogDeps {
  now?: () => number;
  env?: WatchdogEnv;
  detect?: (options: { nowMs: number; env: WatchdogEnv }) => Promise<AgentWatchdogCondition[]>;
  notify?: (notification: WatchdogNotification, nowMs: number) => Promise<boolean>;
}

/**
 * One watchdog tick. Safe to call from every drain/cron invocation: the persisted
 * state makes it exactly-once-per-condition-per-window and budget-capped.
 */
export async function runAgentWatchdog(deps: RunAgentWatchdogDeps = {}): Promise<AgentWatchdogResult> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const env = deps.env ?? process.env;
  const config = resolveWatchdogConfig(env);
  const detect = deps.detect ?? ((options) => detectAgentWatchdogConditions(options));
  const notify = deps.notify ?? ((notification, at) => defaultWatchdogNotifier(notification, at));
  const evaluatedAt = new Date(nowMs).toISOString();
  const result: AgentWatchdogResult = {
    ok: true,
    evaluatedAt,
    conditions: [],
    alertsSent: 0,
    recoveriesSent: 0,
    budgetRemaining: config.dailyAlertBudget,
  };

  let conditions: AgentWatchdogCondition[];
  try {
    conditions = await detect({ nowMs, env });
  } catch (error) {
    log.warn({ event: 'agent_watchdog.detect_failed', err: error }, 'Watchdog condition detection failed');
    return { ...result, ok: false, error: 'detect_failed' };
  }
  result.conditions = conditions;

  let state: WatchdogState;
  try {
    state = await loadWatchdogState();
  } catch (error) {
    // Fail CLOSED: without the persisted state an alert could repeat every tick.
    log.warn({ event: 'agent_watchdog.state_unavailable', err: error }, 'Watchdog state store unavailable; skipping alerts');
    return { ...result, ok: false, error: 'state_unavailable' };
  }

  // Rolling 24 h notification budget.
  const budgetCutoff = nowMs - 24 * 60 * 60 * 1000;
  state.alertsSentAt = state.alertsSentAt.filter((at) => {
    const ms = Date.parse(at);
    return Number.isFinite(ms) && ms >= budgetCutoff;
  });

  const notifyOnce = async (notification: WatchdogNotification): Promise<boolean> => {
    try {
      return await notify(notification, nowMs);
    } catch (error) {
      log.warn({ event: 'agent_watchdog.notify_threw', conditionKey: notification.condition.key, err: error }, 'Watchdog notifier threw');
      return false;
    }
  };

  const currentKeys = new Set(conditions.map((condition) => condition.key));

  // 1. Recoveries: active episodes that disappeared. Clear state and send at most
  //    ONE recovery note, only when an alert had actually gone out.
  for (const [key, episode] of Object.entries(state.episodes)) {
    if (currentKeys.has(key)) continue;
    if (episode.alertedAt !== null) {
      const recoveryCondition: AgentWatchdogCondition = {
        key,
        kind: episode.kind,
        reason: `已恢复：${episode.kind}`,
        detail: episode.detail,
      };
      const sent = await notifyOnce({
        type: 'recovery',
        condition: recoveryCondition,
        title: `✅ TimeMark AI 后台恢复：${episode.kind}`,
        body: notificationBody('recovery', recoveryCondition, nowMs),
      });
      if (sent) {
        result.recoveriesSent += 1;
        state.alertsSentAt.push(evaluatedAt);
      }
    }
    delete state.episodes[key];
  }

  // 2. Alerts: one per distinct condition per window, capped by the daily budget.
  for (const condition of conditions) {
    const previous = state.episodes[condition.key];
    const windowElapsed =
      previous?.alertedAt != null && nowMs - Date.parse(previous.alertedAt) >= config.alertWindowMs;

    if (previous && previous.alertedAt !== null && !windowElapsed) {
      previous.detail = condition.detail; // refresh context; no new alert in this window
      continue;
    }

    const budgetRemaining = config.dailyAlertBudget - state.alertsSentAt.length;
    if (budgetRemaining <= 0) {
      if (!previous) {
        state.episodes[condition.key] = {
          kind: condition.kind,
          firstSeenAt: evaluatedAt,
          alertedAt: null,
          windowStartAt: evaluatedAt,
          detail: condition.detail,
        };
      }
      log.warn(
        { event: 'agent_watchdog.budget_exhausted', conditionKey: condition.key },
        'Watchdog alert suppressed: the rolling 24h notification budget is spent',
      );
      continue;
    }

    const sent = await notifyOnce({
      type: 'alert',
      condition,
      title: `⚠️ TimeMark AI 后台告警：${condition.reason}`,
      body: notificationBody('alert', condition, nowMs),
    });
    if (sent) {
      result.alertsSent += 1;
      state.alertsSentAt.push(evaluatedAt);
    }
    state.episodes[condition.key] = {
      kind: condition.kind,
      firstSeenAt: previous?.firstSeenAt ?? evaluatedAt,
      alertedAt: sent ? evaluatedAt : (previous?.alertedAt ?? null),
      windowStartAt: sent ? evaluatedAt : (previous?.windowStartAt ?? evaluatedAt),
      detail: condition.detail,
    };
  }

  state.lastEvaluatedAt = evaluatedAt;
  result.budgetRemaining = Math.max(0, config.dailyAlertBudget - state.alertsSentAt.length);

  try {
    await saveWatchdogState(state);
  } catch (error) {
    log.warn({ event: 'agent_watchdog.state_save_failed', err: error }, 'Persisting the watchdog state failed');
    return { ...result, ok: false, error: 'state_save_failed' };
  }

  return result;
}
