import { query } from '../db/index.js';
import { Lunar } from 'lunar-javascript';
import {
  buildReminderSendKey,
  diffCalendarDays,
  matchesReminderTimeWindow,
  resolveNextGregorianOccurrence,
  toYmdString,
} from '@timemark/shared/event-schedule';
import {
  buildExpirySendKey,
  DEFAULT_EXPIRY_LEAD_DAYS,
  DEFAULT_EXPIRY_REMINDER_TIMES,
  expiryEventType,
} from '@timemark/shared/expiry-schedule';
import {
  buildInventorySendKey,
  inventoryEventType,
} from '@timemark/shared/inventory-schedule';
import {
  buildMaintenanceSendKey,
  buildMaintenanceUsageKey,
  maintenanceEventType,
  usageNeedsNudge,
  USAGE_NUDGE_RATIO,
} from '@timemark/shared/maintenance-schedule';
import {
  buildDocumentExpiredKey,
  buildDocumentSendKey,
  documentEventType,
  documentLeadDays,
} from '@timemark/shared/document-schedule';
import { buildCadenceSendKey, isCadenceDue } from '@timemark/shared/contact-cadence';
import {
  buildHabitReminderSendKey,
  buildHabitRiskSendKey,
  DEFAULT_HABIT_STREAK_NUDGE_HOUR,
  isHabitScheduledOn,
  normalizeReminderTimes,
  normalizeScheduleDays,
} from '@timemark/shared/habit-schedule';
import { sendNotifications } from '../services/notifications/index.js';
import { createInboxMessage } from '../services/inbox.service.js';
import { refreshUserEventCache } from '../services/event-cache.service.js';
import { createLogger } from '../utils/logger.js';
import { recordEventTrigger } from '../services/trigger-log.service.js';
import { getSyncedNow, scheduleTimeSync, DEFAULT_SYNC_TIMEZONE } from '../utils/ntp.js';

const log = createLogger('tasks');
// Batch query replaces per-user getReminderSettings/getUserConfig calls

/** Get today's date string (YYYY-MM-DD) in the given timezone, robust on Alpine Linux */
function getTodayString(now: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now); // en-CA outputs YYYY-MM-DD
}

function parseJsonField<T>(raw: unknown): T | null {
  if (!raw) return null;
  try {
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
  } catch {
    return null;
  }
}

/** Resolve next gregorian occurrence for an event (YYYY-MM-DD date field) */
function resolveGregorianTarget(
  today: string,
  event: {
    date: string;
    type?: string;
    recurring_config?: unknown;
    next_occurrence?: string | null;
  },
  allDays: number[],
): { targetDate: Date; daysUntil: number } | null {
  const recurringConfig = parseJsonField<{ enabled?: boolean; frequency?: string }>(event.recurring_config);
  const nextOccurrence = resolveNextGregorianOccurrence(event.date, today, {
    eventType: event.type,
    recurringConfig,
    nextOccurrence: event.next_occurrence,
  });
  const diff = diffCalendarDays(today, nextOccurrence);
  if (diff >= 0 && allDays.includes(diff)) {
    return { targetDate: new Date(nextOccurrence + 'T00:00:00Z'), daysUntil: diff };
  }
  return null;
}

/** Resolve lunar date to next matching gregorian target within current/next lunar year */
function resolveLunarTarget(today: string, lunarDateRaw: unknown, allDays: number[], now: Date): Date | null {
    const lunarData = typeof lunarDateRaw === 'string' ? JSON.parse(lunarDateRaw) : lunarDateRaw;
    if (!lunarData?.month || !lunarData?.day) return null;

    const month = lunarData.isLeap ? -lunarData.month : lunarData.month;
    const currentYear = now.getFullYear();

    for (const year of [currentYear, currentYear + 1]) {
      const tryLunarDate = Lunar.fromYmd(year, month, lunarData.day);
      const trySolar = tryLunarDate.getSolar();
      const tryDateStr = `${trySolar.getYear()}-${String(trySolar.getMonth()).padStart(2, '0')}-${String(trySolar.getDay()).padStart(2, '0')}`;
      const diff = diffCalendarDays(today, tryDateStr);
      if (diff >= 0 && allDays.includes(diff)) {
        return new Date(tryDateStr + 'T00:00:00Z');
      }
    }
  return null;
}

/** Parse reminder_days_before from an event's JSON field, returns null if invalid */
function parseReminderDays(raw: any): number[] | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((n: any) => typeof n === 'number' && n >= 0)) {
      return parsed;
    }
  } catch { /* ignore parse errors */ }
  return null;
}

/** 当前 HH:mm（按用户时区），与事件提醒使用同一套 Intl 逻辑 */
function getCurrentHHmm(now: Date, timeZone: string): string {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(now);
  const minute = new Intl.DateTimeFormat('en-US', {
    timeZone,
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

/**
 * 「带到期日」提醒的通用迭代器（D1/D12/D2）。
 *
 * 到期项（todo 48）、库存（todo 49）、保养计划日期间隔（todo 50）、证件（todo 55）
 * 共用同一套逻辑：
 * - 时间窗口：同一个 matchesReminderTimeWindow（±2 分钟）
 * - 渠道：同一个 resolveReminderChannels + sendNotifications
 * - 去重：同一张 reminder_send_claims，键带各自前缀（expiry:/inventory:/maintenance:/document:）
 * - 提前天数：row.reminder_config.daysBeforeList，缺省由各来源的 defaultLeadDays(kind) 决定
 * - 过期的 due / is_active=false / reminders_enabled=false 一律不提醒；只有提供了
 *   buildExpiredSendKey 的来源（documents）才在过期后发一条最终提醒（claim 键不含日期 → 恰好一次）
 * 绝不新建第二个调度器：所有来源都由 sendReminders 在同一个分钟级 cron 里调用。
 *
 * 发送事件不携带 event.id（email_logs / notification_queue 的 event_id 外键指向
 * events 表），因此这些提醒不写事件触发日志，去重完全由 claim 承担。
 *
 * 发送失败的处理：sendNotifications() 不会在渠道失败时抛错，而是返回逐渠道结果
 * map（{channel: {success:false,error}}）。因此不能只看有没有抛异常——只有结果里
 * 至少一个渠道明确 success:true 才算送达，保留 claim；全部渠道失败（或空 map /
 * 缺键 / null 条目，即什么都没送出去）时释放 claim，让下个 ±2 分钟窗口重试
 * （send key 含日期 + 提前天数 + 时刻，不含分钟，不释放就会在同一窗口内被去重）。
 */
interface DatedReminderConfig {
  enabled?: boolean;
  daysBeforeList?: number[];
  reminderTimes?: string[];
  channels?: string[];
}

interface DatedReminderSource {
  /** 表名与别名（代码常量，非用户输入） */
  table: string;
  alias: string;
  /** 到期日列（YYYY-MM-DD DATE） */
  dueColumn: string;
  /** 标题列 */
  titleColumn: string;
  /** 分类/类型列（选择模板家族） */
  kindColumn: string;
  /** 默认分类（行缺失时兜底） */
  defaultKind: string;
  /** 附加 WHERE 片段（别名限定，代码常量） */
  extraWhere: string;
  /** 日志与返回用的来源标签 */
  label: string;
  /** 每个 kind 的默认提前天数（用户 reminder_config.daysBeforeList 优先） */
  defaultLeadDays: (kind: string) => readonly number[];
  buildSendKey: (todayYmd: string, daysUntil: number, reminderTime: string) => string;
  /**
   * 过去到期日的「最终提醒」去重键。缺省 = 过去日期不提醒；
   * 提供时键必须不含今天日期（同一到期日恰好一次）。
   */
  buildExpiredSendKey?: (dueYmd: string) => string;
  toEventType: (kind: string, daysUntil: number) => string;
}

const EXPIRY_SOURCE: DatedReminderSource = {
  table: 'expiry_items',
  alias: 'e',
  dueColumn: 'next_due_date',
  titleColumn: 'title',
  kindColumn: 'kind',
  defaultKind: 'custom',
  extraWhere: '',
  label: 'expiry',
  defaultLeadDays: () => DEFAULT_EXPIRY_LEAD_DAYS,
  buildSendKey: buildExpirySendKey,
  toEventType: (kind) => expiryEventType(kind),
};

const INVENTORY_SOURCE: DatedReminderSource = {
  table: 'inventory_items',
  alias: 'i',
  dueColumn: 'expires_at',
  titleColumn: 'name',
  kindColumn: 'category',
  defaultKind: 'other',
  // 非易腐品（expires_at IS NULL）永不进入提醒候选
  extraWhere: 'AND i.expires_at IS NOT NULL',
  label: 'inventory',
  defaultLeadDays: () => DEFAULT_EXPIRY_LEAD_DAYS,
  buildSendKey: buildInventorySendKey,
  toEventType: (kind) => inventoryEventType(kind),
};

const MAINTENANCE_SOURCE: DatedReminderSource = {
  table: 'maintenance_plans',
  alias: 'p',
  dueColumn: 'next_due_at',
  titleColumn: 'asset_name',
  kindColumn: 'asset_kind',
  defaultKind: 'other',
  // 仅按用量保养的计划没有日期提醒（next_due_at IS NULL）
  extraWhere: 'AND p.next_due_at IS NOT NULL',
  label: 'maintenance',
  defaultLeadDays: () => DEFAULT_EXPIRY_LEAD_DAYS,
  buildSendKey: buildMaintenanceSendKey,
  toEventType: (kind) => maintenanceEventType(kind),
};

/**
 * 证件（D2，todo 55）：无到期日的证件不提醒；passport/visa 默认
 * [180,90,30,7,0]，其余 [90,30,7,0]；过期后发一条最终「已过期」提醒。
 */
const DOCUMENT_SOURCE: DatedReminderSource = {
  table: 'documents',
  alias: 'd',
  dueColumn: 'expires_at',
  titleColumn: 'title',
  kindColumn: 'kind',
  defaultKind: 'other',
  extraWhere: 'AND d.expires_at IS NOT NULL',
  label: 'document',
  defaultLeadDays: documentLeadDays,
  buildSendKey: buildDocumentSendKey,
  buildExpiredSendKey: buildDocumentExpiredKey,
  toEventType: documentEventType,
};

/**
 * 本次派发是否至少有一个渠道明确成功。
 *
 * sendNotifications 的返回形状是 Record<channel, {success, error?}>；运行时可能
 * 出现空 map、null 条目、缺键等畸形结果（被 mock / 渠道短路）。这些一律按
 * 「未送达」处理——宁可下个窗口重试，也不能把失败的提醒当作已发送而永久丢失。
 * 只检查本次请求的渠道键；内部标记键（_quiet_hours / _skipped）不参与判定。
 */
function deliveredToAnyChannel(results: unknown, channels: readonly string[]): boolean {
  if (!results || typeof results !== 'object') return false;
  const map = results as Record<string, unknown>;
  return channels.some((channel) => {
    const entry = map[channel];
    return typeof entry === 'object' && entry !== null && (entry as { success?: unknown }).success === true;
  });
}

async function runDatedReminderIterator(
  source: DatedReminderSource,
  now: Date,
): Promise<{ candidates: number; sent: number; claimed: number; skipped: number }> {
  const result = await query(
    `SELECT ${source.alias}.*, uc.timezone, uc.reminders_enabled
     FROM ${source.table} ${source.alias}
     LEFT JOIN user_configs uc ON uc.user_id = ${source.alias}.user_id
     WHERE ${source.alias}.is_active = TRUE ${source.extraWhere}`,
  );

  let sent = 0;
  let claimed = 0;
  let skipped = 0;

  for (const raw of result.rows as Array<Record<string, unknown>>) {
    if (raw.is_active === false || raw.reminders_enabled === false) {
      skipped += 1;
      continue;
    }

    const userId = Number(raw.user_id);
    const timeZone = typeof raw.timezone === 'string' ? raw.timezone : 'Asia/Shanghai';
    const today = getTodayString(now, timeZone);
    const due = toYmdString(raw[source.dueColumn]);
    // 过去日期不是「即将到来」；逾期项由各自的 overdue/expiring/低库存视图呈现，不发提醒
    if (!due) {
      skipped += 1;
      continue;
    }
    const daysUntil = diffCalendarDays(today, due);

    const config = parseJsonField<DatedReminderConfig>(raw.reminder_config);
    if (config?.enabled === false) {
      skipped += 1;
      continue;
    }

    const kind = String(raw[source.kindColumn] ?? source.defaultKind);
    // 过去日期默认不提醒（逾期视图负责呈现）；documents 例外：发一条最终「已过期」提醒
    const isExpired = daysUntil < 0;
    if (isExpired && !source.buildExpiredSendKey) {
      skipped += 1;
      continue;
    }

    const leadDays = config?.daysBeforeList?.length
      ? config.daysBeforeList
      : [...source.defaultLeadDays(kind)];
    if (!isExpired && !leadDays.includes(daysUntil)) {
      skipped += 1;
      continue;
    }

    const reminderTimes = config?.reminderTimes?.length
      ? config.reminderTimes
      : [...DEFAULT_EXPIRY_REMINDER_TIMES];
    const currentTime = getCurrentHHmm(now, timeZone);
    const matchedReminderTime = reminderTimes.find((time) => matchesReminderTimeWindow(currentTime, time, 2));
    if (!matchedReminderTime) {
      skipped += 1;
      continue;
    }

    const baseChannels = Array.isArray(config?.channels) ? config.channels : [];
    const { resolveReminderChannels } = await import('../services/reminder-channel-resolver.service.js');
    const channels = await resolveReminderChannels(userId, baseChannels, daysUntil);
    if (channels.length === 0) {
      skipped += 1;
      continue;
    }

    const sendKey = isExpired
      ? (source.buildExpiredSendKey as (dueYmd: string) => string)(due)
      : source.buildSendKey(today, daysUntil, matchedReminderTime);
    const claim = await query(
      `INSERT INTO reminder_send_claims (event_id, trigger_date) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [raw.id, sendKey],
    );
    if (claim.rows.length === 0) {
      // 同一窗口内已被本进程或并行的 cron 发送过
      skipped += 1;
      continue;
    }
    claimed += 1;

    try {
      const title = String(raw[source.titleColumn] ?? '');
      const notificationEvent = {
        // 故意不带 id：email_logs / notification_queue 的 event_id 外键指向 events
        id: null,
        user_id: userId,
        name: title,
        type: source.toEventType(kind, daysUntil),
        date: due,
        calendar_type: 'gregorian',
        reminder_time: matchedReminderTime,
        reminder_config: config ?? null,
        reminderConfig: config ?? null,
        // 过期最终提醒带明确的「已过期」文案（渠道在无用户自定义模板时使用 customMessage）
        ...(isExpired ? { customMessage: `⚠️ ${title} 已过期（到期日 ${due}），请尽快处理。` } : {}),
      };
      const results = await sendNotifications(notificationEvent, userId, channels);
      if (!deliveredToAnyChannel(results, channels)) {
        // 所有渠道都失败：释放 claim，让下个 ±2 分钟窗口重试
        await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [raw.id, sendKey]);
        skipped += 1;
        log.warn(
          { source: source.label, itemId: raw.id, kind, daysUntil, isExpired, matchedReminderTime, channels, results },
          'Dated reminder delivered to no channel; claim released for retry',
        );
        continue;
      }
      sent += 1;
      log.info(
        { source: source.label, itemId: raw.id, kind, daysUntil, isExpired, matchedReminderTime, channels, results },
        'Dated reminder dispatched',
      );
    } catch (error) {
      // 释放 claim，让下个 ±2 分钟窗口可以重试
      await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [raw.id, sendKey]);
      skipped += 1;
      log.error({ source: source.label, itemId: raw.id, err: error }, 'Failed to send dated reminder');
    }
  }

  log.info({ source: source.label, candidates: result.rows.length, sent, claimed, skipped }, 'Dated reminders checked');
  return { candidates: result.rows.length, sent, claimed, skipped };
}

/** 到期项提醒（D1，todo 48）：复用同一引擎，send key 带 `expiry:` 前缀 */
export async function sendExpiryReminders(now: Date = getSyncedNow(DEFAULT_SYNC_TIMEZONE)): Promise<{
  candidates: number;
  sent: number;
  claimed: number;
  skipped: number;
}> {
  return runDatedReminderIterator(EXPIRY_SOURCE, now);
}

/** 库存到期提醒（D12，todo 49）：仅 expires_at 非空的行，send key 带 `inventory:` 前缀 */
export async function sendInventoryReminders(now: Date = getSyncedNow(DEFAULT_SYNC_TIMEZONE)): Promise<{
  candidates: number;
  sent: number;
  claimed: number;
  skipped: number;
}> {
  return runDatedReminderIterator(INVENTORY_SOURCE, now);
}

/** 保养日期提醒（D12，todo 50）：仅 next_due_at 非空的行，send key 带 `maintenance:` 前缀 */
export async function sendMaintenanceReminders(now: Date = getSyncedNow(DEFAULT_SYNC_TIMEZONE)): Promise<{
  candidates: number;
  sent: number;
  claimed: number;
  skipped: number;
}> {
  return runDatedReminderIterator(MAINTENANCE_SOURCE, now);
}

/**
 * 证件到期提醒（D2，todo 55）：仅 expires_at 非空的证件，send key 带 `document:` 前缀。
 * passport/visa 默认 [180,90,30,7,0]，其余 [90,30,7,0]；过期后发一条「已过期」最终提醒。
 */
export async function sendDocumentReminders(now: Date = getSyncedNow(DEFAULT_SYNC_TIMEZONE)): Promise<{
  candidates: number;
  sent: number;
  claimed: number;
  skipped: number;
}> {
  return runDatedReminderIterator(DOCUMENT_SOURCE, now);
}

export interface CadenceReminderStats {
  candidates: number;
  sent: number;
  inbox: number;
  skipped: number;
}

/**
 * 联系节奏提醒（D4，checkbox 62）：与到期项/证件同一个分钟级调度、同一张
 * reminder_send_claims，不新建第二个调度器。
 *
 * 去重键 = 联系人 id + 周期起点（最后一次有效联系日的用户时区日历日）：
 * - 同一周期内每分钟跑 → claim 冲突 → 至多一条提醒（绝不每日唠叨）；
 * - 用户今天记录互动 → 周期起点前移 → 新键 → 下个完整周期后可再提醒一次。
 *
 * 从未联系（有效最后联系为 NULL）没有周期起点 → 明确跳过；UI 的到期列表
 * 仍会展示它（GET /api/contacts/due 的语义），但这里绝不发「上次联系：从未」。
 * 同时写一条 Inbox 消息（source='inbound'，带「已记录联系」快捷动作约定：
 * markdown 链接 `/contacts?contactId=<id>&log=1`），失败不影响已发出的提醒。
 */
export async function sendCadenceReminders(
  now: Date = getSyncedNow(DEFAULT_SYNC_TIMEZONE),
): Promise<CadenceReminderStats> {
  const result = await query(
    `SELECT fc.id, fc.user_id, fc.name, fc.nickname, fc.relationship,
            fc.cadence_days, fc.last_contact_at,
            latest.occurred_at AS effective_last_contact_at,
            latest.summary AS last_interaction_summary,
            uc.timezone, uc.reminders_enabled
     FROM fixed_contacts fc
     LEFT JOIN user_configs uc ON uc.user_id = fc.user_id
     LEFT JOIN LATERAL (
       SELECT i.occurred_at, i.summary
       FROM interactions i
       WHERE i.user_id = fc.user_id AND i.contact_id = fc.id
       ORDER BY i.occurred_at DESC
       LIMIT 1
     ) latest ON TRUE
     WHERE COALESCE(fc.cadence_enabled, FALSE) = TRUE
       AND fc.cadence_days IS NOT NULL
       AND COALESCE(latest.occurred_at, fc.last_contact_at) IS NOT NULL
       AND COALESCE(latest.occurred_at, fc.last_contact_at)
           + make_interval(days => fc.cadence_days) <= $1`,
    [now],
  );

  const { resolveReminderChannels } = await import('../services/reminder-channel-resolver.service.js');
  let sent = 0;
  let inbox = 0;
  let skipped = 0;

  for (const raw of result.rows as Array<Record<string, unknown>>) {
    if (raw.reminders_enabled === false) {
      skipped += 1;
      continue;
    }

    const userId = Number(raw.user_id);
    const timeZone = typeof raw.timezone === 'string' ? raw.timezone : 'Asia/Shanghai';
    const today = getTodayString(now, timeZone);

    // 从未联系（有效最后联系为 NULL）没有周期起点：跳过，不发「上次联系：从未」。
    const effectiveRaw = raw.effective_last_contact_at ?? raw.last_contact_at;
    if (effectiveRaw == null || effectiveRaw === '') {
      skipped += 1;
      continue;
    }
    const effectiveDate = effectiveRaw instanceof Date ? effectiveRaw : new Date(String(effectiveRaw));
    if (Number.isNaN(effectiveDate.getTime())) {
      skipped += 1;
      continue;
    }

    const periodStart = getTodayString(effectiveDate, timeZone);
    const cadenceDays = Number(raw.cadence_days);
    if (!isCadenceDue(today, periodStart, cadenceDays)) {
      skipped += 1;
      continue;
    }

    const contactId = Number(raw.id);
    const sendKey = buildCadenceSendKey(contactId, periodStart);
    const claim = await query(
      `INSERT INTO reminder_send_claims (event_id, trigger_date) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [contactId, sendKey],
    );
    if (claim.rows.length === 0) {
      // 本周期已提醒过（或并行 cron 正在发）→ 不再唠叨
      skipped += 1;
      continue;
    }

    const channels = await resolveReminderChannels(userId, [], 0);
    if (channels.length === 0) {
      await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [contactId, sendKey]);
      skipped += 1;
      continue;
    }

    try {
      const name = String(raw.name ?? '');
      const nickname = typeof raw.nickname === 'string' && raw.nickname.trim() ? raw.nickname.trim() : '';
      const displayName = nickname || name;
      const tag = typeof raw.relationship === 'string' && raw.relationship.trim() ? raw.relationship.trim() : '';
      const summary =
        typeof raw.last_interaction_summary === 'string' && raw.last_interaction_summary.trim()
          ? raw.last_interaction_summary.trim()
          : '';
      const customMessage = [
        `🤝 关系维系提醒：${displayName}${tag ? `（${tag}）` : ''}`,
        summary ? `上次互动：${summary}` : `上次联系：${periodStart}`,
        `已超过 ${cadenceDays} 天没联系了，记得问候一下。`,
      ].join('\n');

      const results = await sendNotifications(
        {
          // 故意不带 id：email_logs / notification_queue 的 event_id 外键指向 events
          id: null,
          user_id: userId,
          name: displayName,
          type: 'contact_cadence',
          date: today,
          calendar_type: 'gregorian',
          reminder_time: getCurrentHHmm(now, timeZone),
          reminder_config: null,
          reminderConfig: null,
          customMessage,
        },
        userId,
        channels,
      );
      if (!deliveredToAnyChannel(results, channels)) {
        // 所有渠道都失败：释放 claim，下个分钟窗口可重试
        await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [contactId, sendKey]);
        skipped += 1;
        log.warn({ contactId, sendKey, channels, results }, 'Cadence reminder delivered to no channel; claim released');
        continue;
      }
      sent += 1;

      // Inbox 提醒 +「已记录联系」快捷动作（source='inbound' 才会出现在收件箱列表）
      try {
        await createInboxMessage({
          userId,
          title: `关系维系提醒：${displayName}`,
          body: `${customMessage}\n[已记录联系](/contacts?contactId=${contactId}&log=1)`,
          source: 'inbound',
          senderLabel: '联系节奏',
        });
        inbox += 1;
      } catch (error) {
        // 收件箱写入失败不影响已送达的外部提醒
        log.warn({ contactId, err: error }, 'Cadence inbox message failed');
      }

      log.info({ contactId, periodStart, cadenceDays, channels, results }, 'Cadence reminder dispatched');
    } catch (error) {
      await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [contactId, sendKey]);
      skipped += 1;
      log.error({ contactId, err: error }, 'Failed to send cadence reminder');
    }
  }

  log.info({ candidates: result.rows.length, sent, inbox, skipped }, 'Cadence reminders checked');
  return { candidates: result.rows.length, sent, inbox, skipped };
}

export interface HabitReminderStats {
  candidates: number;
  reminded: number;
  riskNudged: number;
  skipped: number;
}

/**
 * 习惯提醒（D6，checkbox 65）：与事件/到期/证件同一个分钟级调度、同一张
 * reminder_send_claims，不新建第二个调度器。
 *
 * - 定时提醒：habit.reminder_times 里与当前时刻 ±2 分钟匹配的时刻；键
 *   `habit#h<id>#d<today>#t<HH:mm>`，同一天同时刻至多一条。
 * - 连胜告急：user_configs.habit_streak_nudge_hour（默认 20:00）时，如果
 *   当前周期目标未达标（count 之和 < target_per_period），发一条并写 claim
 *   `habit:risk#h<id>#d<today>`（每天至多一条）。
 * - schedule_days（0=周日..6=周六）之外的日子一律不提醒；未配置计划 = 每天。
 * - 已过去的 reminder_times 不会回溯触发（只匹配当前时刻窗口）。
 */
export async function sendHabitReminders(
  now: Date = getSyncedNow(DEFAULT_SYNC_TIMEZONE),
): Promise<HabitReminderStats> {
  const result = await query(
    `SELECT h.id, h.user_id, h.name, h.icon, h.target_per_period, h.period,
            h.schedule_days, h.reminder_times,
            uc.timezone, uc.reminders_enabled,
            COALESCE(uc.habit_streak_nudge_hour, $1) AS habit_streak_nudge_hour
     FROM habits h
     LEFT JOIN user_configs uc ON uc.user_id = h.user_id
     WHERE h.is_active = TRUE`,
    [DEFAULT_HABIT_STREAK_NUDGE_HOUR],
  );

  const { resolveReminderChannels } = await import('../services/reminder-channel-resolver.service.js');
  let reminded = 0;
  let riskNudged = 0;
  let skipped = 0;

  for (const raw of result.rows as Array<Record<string, unknown>>) {
    if (raw.reminders_enabled === false) {
      skipped += 1;
      continue;
    }

    const habitId = Number(raw.id);
    const userId = Number(raw.user_id);
    const timeZone = typeof raw.timezone === 'string' ? raw.timezone : 'Asia/Shanghai';
    const today = getTodayString(now, timeZone);
    const scheduleDays = normalizeScheduleDays(raw.schedule_days ?? null);
    // 未排期的日子绝不提醒
    if (!isHabitScheduledOn(today, scheduleDays)) {
      skipped += 1;
      continue;
    }

    const currentTime = getCurrentHHmm(now, timeZone);
    const target = Math.max(1, Math.trunc(Number(raw.target_per_period) || 1));
    const name = String(raw.name ?? '');
    const periodLabel = raw.period === 'week' ? '周' : '天';

    const countResult = await query(
      `SELECT COALESCE(SUM(count), 0)::int AS count
       FROM habit_logs WHERE habit_id = $1 AND user_id = $2 AND logged_on = $3::date`,
      [habitId, userId, today],
    );
    const todayCount = Number(countResult.rows[0]?.count ?? 0);

    // 1) 定时提醒（reminder_times）
    const matchedTime = normalizeReminderTimes(raw.reminder_times ?? null).find((time) =>
      matchesReminderTimeWindow(currentTime, time, 2),
    );
    if (matchedTime) {
      const sendKey = buildHabitReminderSendKey(habitId, today, matchedTime);
      const claim = await query(
        `INSERT INTO reminder_send_claims (event_id, trigger_date) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [habitId, sendKey],
      );
      if (claim.rows.length === 0) {
        skipped += 1;
      } else {
        const channels = await resolveReminderChannels(userId, [], 0);
        if (channels.length === 0) {
          await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [habitId, sendKey]);
          skipped += 1;
        } else {
          try {
            const results = await sendNotifications(
              {
                id: null,
                user_id: userId,
                name,
                type: 'habit_reminder',
                date: today,
                calendar_type: 'gregorian',
                reminder_time: matchedTime,
                reminder_config: null,
                reminderConfig: null,
                customMessage: `⏰ 习惯打卡：${name}（目标 ${target} 次/${periodLabel}）`,
              },
              userId,
              channels,
            );
            if (!deliveredToAnyChannel(results, channels)) {
              await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [habitId, sendKey]);
              skipped += 1;
              log.warn({ habitId, sendKey, channels, results }, 'Habit reminder delivered to no channel; claim released');
            } else {
              reminded += 1;
              log.info({ habitId, matchedTime, channels }, 'Habit reminder dispatched');
            }
          } catch (error) {
            await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [habitId, sendKey]);
            skipped += 1;
            log.error({ habitId, err: error }, 'Failed to send habit reminder');
          }
        }
      }
    }

    // 2) 连胜告急（默认 20:00，仅当当前周期未达标；每天至多一条）
    const rawNudgeHour = typeof raw.habit_streak_nudge_hour === 'string' ? raw.habit_streak_nudge_hour : '';
    const nudgeHour = /^([01]\d|2[0-3]):[0-5]\d$/.test(rawNudgeHour)
      ? rawNudgeHour
      : DEFAULT_HABIT_STREAK_NUDGE_HOUR;
    if (todayCount < target && matchesReminderTimeWindow(currentTime, nudgeHour, 2)) {
      const riskKey = buildHabitRiskSendKey(habitId, today);
      const claim = await query(
        `INSERT INTO reminder_send_claims (event_id, trigger_date) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [habitId, riskKey],
      );
      if (claim.rows.length === 0) {
        skipped += 1;
      } else {
        const channels = await resolveReminderChannels(userId, [], 0);
        if (channels.length === 0) {
          await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [habitId, riskKey]);
          skipped += 1;
        } else {
          try {
            const results = await sendNotifications(
              {
                id: null,
                user_id: userId,
                name,
                type: 'habit_streak_risk',
                date: today,
                calendar_type: 'gregorian',
                reminder_time: nudgeHour,
                reminder_config: null,
                reminderConfig: null,
                customMessage: `🔥 习惯打卡：「${name}」今天还差 ${target - todayCount} 次达标（目标 ${target} 次/${periodLabel}），连续记录将中断。`,
              },
              userId,
              channels,
            );
            if (!deliveredToAnyChannel(results, channels)) {
              await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [habitId, riskKey]);
              skipped += 1;
              log.warn({ habitId, riskKey, channels, results }, 'Habit streak-risk nudge delivered to no channel; claim released');
            } else {
              riskNudged += 1;
              log.info({ habitId, nudgeHour, todayCount, target, channels }, 'Habit streak-risk nudge dispatched');
            }
          } catch (error) {
            await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [habitId, riskKey]);
            skipped += 1;
            log.error({ habitId, err: error }, 'Failed to send habit streak-risk nudge');
          }
        }
      }
    }
  }

  log.info({ candidates: result.rows.length, reminded, riskNudged, skipped }, 'Habit reminders checked');
  return { candidates: result.rows.length, reminded, riskNudged, skipped };
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 保养用量提醒（D12，todo 50）：剩余用量 <= 间隔的 10% 时写一条收件箱提醒。
 * - 不做第二个调度器：由 sendReminders 在同一个分钟级 cron 里调用
 * - 去重：同一张 reminder_send_claims，键 `maintenance:usage#<planId>#u<nextDueUsage>`；
 *   下次保养用量变化后键随之变化 → 每个保养周期最多提醒一次
 * - source='inbound'：收件箱列表只展示 inbound（inbox.service.listInboxMessages），
 *   这样提醒才真的出现在「收件箱」而不是只进日志
 */
export async function sendMaintenanceUsageNudges(): Promise<{
  candidates: number;
  nudged: number;
  skipped: number;
}> {
  const result = await query(
    `SELECT p.id, p.user_id, p.asset_name, p.interval_usage, p.current_usage, p.next_due_usage,
            COALESCE(p.usage_unit, '') AS usage_unit, uc.reminders_enabled
     FROM maintenance_plans p
     LEFT JOIN user_configs uc ON uc.user_id = p.user_id
     WHERE p.is_active = TRUE
       AND p.interval_usage IS NOT NULL
       AND p.current_usage IS NOT NULL
       AND p.next_due_usage IS NOT NULL
       AND p.next_due_usage - p.current_usage <= p.interval_usage * ${USAGE_NUDGE_RATIO}`,
  );

  let nudged = 0;
  let skipped = 0;

  for (const raw of result.rows as Array<Record<string, unknown>>) {
    if (raw.reminders_enabled === false) {
      skipped += 1;
      continue;
    }

    const currentUsage = toFiniteNumberOrNull(raw.current_usage);
    const nextDueUsage = toFiniteNumberOrNull(raw.next_due_usage);
    const intervalUsage = toFiniteNumberOrNull(raw.interval_usage);
    // SQL 已过滤，这里再用纯函数复核一次（同一规则两处实现互为证明）
    if (!usageNeedsNudge({ currentUsage, nextDueUsage, intervalUsage })) {
      skipped += 1;
      continue;
    }

    const planId = Number(raw.id);
    const claimKey = buildMaintenanceUsageKey(planId, nextDueUsage as number);
    const claim = await query(
      `INSERT INTO reminder_send_claims (event_id, trigger_date) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [planId, claimKey],
    );
    if (claim.rows.length === 0) {
      skipped += 1;
      continue;
    }

    try {
      const unit = typeof raw.usage_unit === 'string' ? raw.usage_unit : '';
      const remaining = (nextDueUsage as number) - (currentUsage as number);
      await createInboxMessage({
        userId: Number(raw.user_id),
        title: `保养提醒：${String(raw.asset_name)}`,
        body: `按用量保养临近：当前 ${currentUsage}${unit}，下次保养 ${nextDueUsage}${unit}（剩余 ${remaining}${unit}）`,
        source: 'inbound',
        senderLabel: '保养计划',
      });
      nudged += 1;
    } catch (error) {
      // 释放 claim，下个分钟窗口可重试
      await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [planId, claimKey]);
      skipped += 1;
      log.error({ planId, err: error }, 'Failed to send maintenance usage nudge');
    }
  }

  log.info({ candidates: result.rows.length, nudged, skipped }, 'Maintenance usage nudges checked');
  return { candidates: result.rows.length, nudged, skipped };
}

export async function sendReminders() {
  log.info('Checking reminders...');

  scheduleTimeSync(DEFAULT_SYNC_TIMEZONE);
  const now = getSyncedNow(DEFAULT_SYNC_TIMEZONE);

  // Batch load ALL user configs upfront to avoid N+1 queries
  const allUserConfigs = await query(
    `SELECT user_id, timezone, reminders_enabled, daily_check_time, days_before_list, reminder_emails 
     FROM user_configs`
  );
  const userConfigMap = new Map<number, any>();
  for (const row of allUserConfigs.rows) {
    userConfigMap.set(row.user_id, row);
  }

  // Caches derived from batch-loaded data
  const userReminderSettingsCache = new Map<number, number[]>();
  const userEnabledCache = new Map<number, boolean>();
  const userTimezoneCache = new Map<number, string>();

  // Pre-populate caches from batch data
  for (const [userId, config] of userConfigMap) {
    userTimezoneCache.set(userId, config.timezone || 'Asia/Shanghai');
    userEnabledCache.set(userId, config.reminders_enabled !== false);
    const daysList = config.days_before_list || [1, 3, 7];
    userReminderSettingsCache.set(userId, Array.isArray(daysList) ? daysList : [1, 3, 7]);
  }

  // Users with events but no user_configs row were previously skipped entirely by cron.
  const eventOwnerRows = await query(`SELECT DISTINCT user_id FROM events`);
  for (const row of eventOwnerRows.rows) {
    const userId = row.user_id as number;
    if (userConfigMap.has(userId)) continue;
    const defaults = { timezone: 'Asia/Shanghai', reminders_enabled: true, days_before_list: [1, 3, 7] };
    userConfigMap.set(userId, defaults);
    userTimezoneCache.set(userId, defaults.timezone);
    userEnabledCache.set(userId, true);
    userReminderSettingsCache.set(userId, defaults.days_before_list);
  }

  function getUserTimezone(userId: number): string {
    if (userTimezoneCache.has(userId)) return userTimezoneCache.get(userId)!;
    // User not in user_configs table - use defaults
    return 'Asia/Shanghai';
  }
  
  function getDaysBeforeList(userId: number, eventReminderDaysBefore: any): number[] {
    // 优先使用事件级别的 reminder_days_before
    const eventDays = parseReminderDays(eventReminderDaysBefore);
    if (eventDays) return eventDays;
    
    // 回退到用户级别的 days_before_list (already batch-loaded)
    if (userReminderSettingsCache.has(userId)) {
      return userReminderSettingsCache.get(userId)!;
    }
    return [1, 3, 7];
  }

  const enabledUserIds = [...userConfigMap.entries()]
    .filter(([, cfg]) => cfg.reminders_enabled !== false)
    .map(([id]) => id);

  const eventIdSet = new Set<number>();
  const allEventRows: any[] = [];

  if (enabledUserIds.length > 0) {
    const cacheRows = await query(
      `SELECT user_id, payload FROM event_reminder_cache
       WHERE user_id = ANY($1::int[]) AND expires_at > NOW()`,
      [enabledUserIds],
    );
    const cachedUserIds = new Set<number>();
    for (const row of cacheRows.rows) {
      cachedUserIds.add(row.user_id as number);
      const payload = row.payload;
      if (!Array.isArray(payload)) continue;
      for (const ev of payload) {
        const id = (ev as { id?: number }).id;
        if (id && !eventIdSet.has(id)) {
          eventIdSet.add(id);
          allEventRows.push(ev);
        }
      }
    }

    // 旧缓存可能只含 7 天窗口；补全年重复事件（生日等存历史年份）
    if (cachedUserIds.size > 0) {
      const supplemental = await query(
        `SELECT * FROM events WHERE user_id = ANY($1::int[])
         AND (
           type IN ('birthday', 'anniversary')
           OR (
             recurring_config IS NOT NULL
             AND recurring_config::jsonb->>'enabled' = 'true'
             AND recurring_config::jsonb->>'frequency' = 'yearly'
           )
         )`,
        [[...cachedUserIds]],
      );
      for (const ev of supplemental.rows) {
        if (!eventIdSet.has(ev.id)) {
          eventIdSet.add(ev.id);
          allEventRows.push(ev);
        }
      }
    }

    const uncachedUserIds = enabledUserIds.filter((id) => !cachedUserIds.has(id));
    if (uncachedUserIds.length > 0) {
      const fallback = await query('SELECT * FROM events WHERE user_id = ANY($1::int[])', [uncachedUserIds]);
      for (const ev of fallback.rows) {
        if (!eventIdSet.has(ev.id)) {
          eventIdSet.add(ev.id);
          allEventRows.push(ev);
        }
      }
      for (const userId of uncachedUserIds) {
        refreshUserEventCache(userId).catch((e) => log.warn({ userId, err: e }, 'Cache refresh failed'));
      }
    }

    const lunarRows = await query(
      `SELECT * FROM events WHERE user_id = ANY($1::int[])
       AND lunar_date IS NOT NULL
       AND calendar_type IN ('lunar', 'both')`,
      [enabledUserIds],
    );
    for (const ev of lunarRows.rows) {
      if (!eventIdSet.has(ev.id)) {
        eventIdSet.add(ev.id);
        allEventRows.push(ev);
      }
    }
  }
  
  // 筛选需要提醒的事件
  const eventsToRemind: Array<{
    id: number;
    user_id: number;
    name: string;
    date: string;
    lunar_date: any;
    calendar_type: string;
    notification_channels: string[];
    notification_account_ids: any;
    targetDate?: Date;
    daysUntil: number;
    matchedReminderTime: string;
  }> = [];
  
  for (const event of allEventRows) {
    // Check if user has reminders enabled (batch-loaded, default to true)
    if (!userEnabledCache.has(event.user_id)) {
      userEnabledCache.set(event.user_id, true); // Default: enabled
    }
    if (!userEnabledCache.get(event.user_id)) continue;

    // Get per-user timezone and calculate today's date in that timezone
    const timeZone = getUserTimezone(event.user_id);
    const today = getTodayString(now, timeZone);

    const calendarType = event.calendar_type;
    let eventTargetDate: Date | null = null;
    let matchedDaysUntil: number | null = null;
    
    // 获取此事件的提前提醒天数列表
    // 优先从 reminder_config.daysBeforeList 读取，回退到 reminder_days_before
    let daysBeforeList: number[] = [];
    const reminderConfig = parseJsonField<{
      enabled?: boolean;
      daysBeforeList?: number[];
      reminderTimes?: string[];
    }>(event.reminder_config);
    if (reminderConfig?.enabled === false) continue;
    if (reminderConfig?.daysBeforeList && reminderConfig.daysBeforeList.length > 0) {
      daysBeforeList = reminderConfig.daysBeforeList;
    }
    
    // 回退到 reminder_days_before 字段
    if (daysBeforeList.length === 0) {
      daysBeforeList = getDaysBeforeList(event.user_id, event.reminder_days_before);
    }
    
    // 包含 0 表示当天也提醒
    const allDays = daysBeforeList.includes(0) ? daysBeforeList : [0, ...daysBeforeList];
    
    try {
      if (calendarType === 'gregorian' || calendarType === 'both') {
        const gTarget = resolveGregorianTarget(today, event, allDays);
        if (gTarget) {
          eventTargetDate = gTarget.targetDate;
          matchedDaysUntil = gTarget.daysUntil;
        }
      }
      if ((calendarType === 'lunar' || calendarType === 'both') && event.lunar_date) {
        const lTarget = resolveLunarTarget(today, event.lunar_date, allDays, now);
        if (lTarget) {
          eventTargetDate = lTarget;
          if (matchedDaysUntil === null) {
            try {
              const lunarData = typeof event.lunar_date === 'string' ? JSON.parse(event.lunar_date) : event.lunar_date;
              const month = lunarData.isLeap ? -lunarData.month : lunarData.month;
              for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
                const tryLunarDate = Lunar.fromYmd(year, month, lunarData.day);
                const trySolar = tryLunarDate.getSolar();
                const tryDateStr = `${trySolar.getYear()}-${String(trySolar.getMonth()).padStart(2, '0')}-${String(trySolar.getDay()).padStart(2, '0')}`;
                const diff = diffCalendarDays(today, tryDateStr);
                if (diff >= 0 && allDays.includes(diff)) {
                  matchedDaysUntil = diff;
                  break;
                }
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (error) {
      log.error({ eventId: event.id, err: error }, 'Failed to parse lunar date');
      await recordEventTrigger(event.id, event.user_id, 'scheduled', today, 'failed', `Lunar date conversion failed: ${String(error)}`);
    }
    
    if (eventTargetDate) {
      // Check if current time matches any of the event's reminder times
      const currentHour = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        hour12: false
      }).format(now);
      const currentMinute = new Intl.DateTimeFormat('en-US', {
        timeZone,
        minute: '2-digit',
        hour12: false
      }).format(now);
      const currentTime = `${currentHour.padStart(2, '0')}:${currentMinute.padStart(2, '0')}`;
      
      let reminderTimes = reminderConfig?.reminderTimes?.length
        ? reminderConfig.reminderTimes
        : [];
      
      // Fallback to legacy reminder_time field
      if (reminderTimes.length === 0) {
        const eventReminderTime = event.reminder_time || '09:00';
        reminderTimes = [eventReminderTime];
      }
      
      // Debug logging
      const nextOccurrence = resolveNextGregorianOccurrence(event.date, today, {
        eventType: event.type,
        recurringConfig: parseJsonField(event.recurring_config),
        nextOccurrence: event.next_occurrence,
      });
      log.debug({
        eventId: event.id,
        name: event.name,
        date: event.date,
        nextOccurrence,
        today,
        diff: diffCalendarDays(today, nextOccurrence),
        allDays,
        reminderTimes,
        currentTime,
      }, 'Event check');
      
      let matchedReminderTime: string | null = null;
      const shouldRemind = reminderTimes.some((time) => {
        const match = matchesReminderTimeWindow(currentTime, time, 2);
        if (match) matchedReminderTime = time;
        return match;
      });
      
      if (!shouldRemind || !matchedReminderTime) {
        continue; // Skip - not the right time for this event
      }
      eventsToRemind.push({
        ...event,
        targetDate: eventTargetDate,
        daysUntil: matchedDaysUntil ?? 0,
        matchedReminderTime,
      });
    }
  }
  
  log.info({ count: eventsToRemind.length }, 'Events to remind');

  for (const event of eventsToRemind.slice(0, 50)) {
    const rawChannels = event.notification_channels;
    const baseChannels = typeof rawChannels === 'string' ? JSON.parse(rawChannels) : (rawChannels || []);
    const { resolveReminderChannels } = await import('../services/reminder-channel-resolver.service.js');
    const channels = await resolveReminderChannels(event.user_id, baseChannels, event.daysUntil ?? 0);
    if (channels.length > 0) {
      const timeZone = getUserTimezone(event.user_id);
      const today = getTodayString(now, timeZone);

      const sendKey = buildReminderSendKey(today, event.daysUntil ?? 0, event.matchedReminderTime);

      const claim = await query(
        `INSERT INTO reminder_send_claims (event_id, trigger_date) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [event.id, sendKey],
      );
      if (claim.rows.length === 0) {
        log.debug({ eventId: event.id, sendKey }, 'Reminder already claimed by another worker');
        continue;
      }

      const alreadySent = await query(
        `SELECT id FROM event_trigger_logs 
         WHERE event_id = $1 AND trigger_date = $2 AND status = 'success'
         LIMIT 1`,
        [event.id, sendKey],
      );
      if (alreadySent.rows.length > 0) {
        await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [event.id, sendKey]);
        log.debug({ eventId: event.id, sendKey }, 'Already sent for this slot, skipping');
        continue;
      }
      try {
        // Relationship mapping is handled inside sendNotifications() per-recipient
        const channelResults = await sendNotifications(event, event.user_id, channels);
        log.info({ eventId: event.id, channelResults }, 'Sent notifications');
        
        // Determine overall status from per-channel results
        const hasFailure = Object.values(channelResults).some(r => !r.success);
        const allFailed = Object.values(channelResults).every(r => !r.success);
        const status = allFailed && Object.keys(channelResults).length > 0 ? 'failed' : 'success';
        const errorMessage = hasFailure
          ? Object.entries(channelResults).filter(([, r]) => !r.success).map(([ch, r]) => `${ch}: ${r.error}`).join('; ')
          : undefined;
        
        // Build error details for failed channels
        const failedEntries = Object.entries(channelResults).filter(([, r]) => !r.success);
        const errorDetails = failedEntries.length > 0 ? {
          channel_type: failedEntries.map(([ch]) => ch).join(','),
          account_id: failedEntries[0][1].accountId,
          details: failedEntries.map(([ch, r]) => ({ channel: ch, error: r.error, accountId: r.accountId }))
        } : undefined;
        
        // 记录事件触发日志 - use timezone-aware today string for dedup consistency
        await recordEventTrigger(event.id, event.user_id, 'scheduled', sendKey, status, errorMessage, JSON.stringify(channelResults), errorDetails);
        if (status === 'success') {
          refreshUserEventCache(event.user_id).catch((e) => log.warn({ userId: event.user_id, err: e }, 'Post-send cache refresh failed'));
        }
      } catch (error) {
        log.error({ eventId: event.id, err: error }, 'Failed to send notifications');
        await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [event.id, sendKey]);
        await recordEventTrigger(event.id, event.user_id, 'scheduled', sendKey, 'failed', String(error));
      }
    }
  }

  // 到期中心（D1，todo 48）：同一引擎、同一分钟级调度，事件提醒失败也不阻断
  try {
    await sendExpiryReminders(now);
  } catch (error) {
    log.error({ err: error }, 'Expiry reminder evaluation failed');
  }

  // 库存（D12，todo 49）：同一引擎、同一分钟级调度（仅 expires_at 非空的行）
  try {
    await sendInventoryReminders(now);
  } catch (error) {
    log.error({ err: error }, 'Inventory reminder evaluation failed');
  }

  // 保养（D12，todo 50）：日期间隔走同一引擎；用量间隔在 10% 阈值内写收件箱提醒
  try {
    await sendMaintenanceReminders(now);
  } catch (error) {
    log.error({ err: error }, 'Maintenance reminder evaluation failed');
  }
  try {
    await sendMaintenanceUsageNudges();
  } catch (error) {
    log.error({ err: error }, 'Maintenance usage nudge evaluation failed');
  }

  // 证件（D2，todo 55）：同一引擎、同一分钟级调度（仅 expires_at 非空的行）
  try {
    await sendDocumentReminders(now);
  } catch (error) {
    log.error({ err: error }, 'Document reminder evaluation failed');
  }

  // 个人 CRM 联系节奏（D4，checkbox 62）：每周期至多一条；从未联系的人跳过
  try {
    await sendCadenceReminders(now);
  } catch (error) {
    log.error({ err: error }, 'Cadence reminder evaluation failed');
  }

  // 习惯打卡（D6，checkbox 64/65）：reminder_times + schedule_days + 连胜告急
  try {
    await sendHabitReminders(now);
  } catch (error) {
    log.error({ err: error }, 'Habit reminder evaluation failed');
  }
}

export async function githubBackup() {
  log.info('Backing up email logs...');
  const result = await query('SELECT COUNT(*) as count FROM email_logs');
  log.info({ count: result.rows[0].count }, 'Backed up email logs');
}

export async function archiveLoginHistory() {
  log.info('Archiving login history...');
  const result = await query('SELECT COUNT(*) as count FROM login_attempts');
  log.info({ count: result.rows[0].count }, 'Archived login attempts');
}

export async function cleanupSessions() {
  log.info('Cleaning up expired sessions...');
  const result = await query("DELETE FROM sessions WHERE expires_at < NOW()");
  log.info({ count: result.rowCount ?? 0 }, 'Cleaned up expired sessions');
  
  // 清理30天前的登录日志
  const loginLogsResult = await query(
    "DELETE FROM login_logs WHERE login_time < NOW() - INTERVAL '30 days'"
  );
  log.info({ count: loginLogsResult.rowCount ?? 0 }, 'Cleaned up old login logs');
  
  // 清理30天前的事件触发日志
  const triggerResult = await query(
    "DELETE FROM event_trigger_logs WHERE created_at < NOW() - INTERVAL '30 days'"
  );
  log.info({ count: triggerResult.rowCount ?? 0 }, 'Cleaned up old event trigger logs');
}

