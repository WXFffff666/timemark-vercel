import { sendFeishuNotification } from './feishu.service.js';
import { sendWeComNotification } from './wecom.service.js';
import { sendDingTalkNotification } from './dingtalk.service.js';
import { sendTelegramNotification } from './telegram.service.js';
import { sendDiscordNotification } from './discord.service.js';
import { sendSlackNotification } from './slack.service.js';
import { sendWxPusherNotification } from './wxpusher.service.js';
import { sendQmsgNotification } from './qmsg.service.js';
import { sendGenericWebhookNotification } from './generic-webhook.service.js';
import { sendEmailNotification } from './email.service.js';
import { sendSmtpNotification } from './smtp.service.js';
// New webhook-based channels
import { sendGoogleChatNotification } from './googlechat.service.js';
import { sendIRCNotification } from './irc.service.js';
import { sendSynologyChatNotification } from './synologychat.service.js';
import { sendTwitchNotification } from './twitch.service.js';
// New token-based channels
import { sendLINENotification } from './line.service.js';
import { sendMatrixNotification } from './matrix.service.js';
import { sendMattermostNotification } from './mattermost.service.js';
import { sendMicrosoftTeamsNotification } from './msteams.service.js';
import { sendNextcloudTalkNotification } from './nextcloudtalk.service.js';
import { sendNtfyNotification } from './ntfy.service.js';
import { sendPushoverNotification } from './pushover.service.js';
import { sendAppriseNotification } from './apprise.service.js';
import { sendServerChanNotification } from './serverchan.service.js';
import { sendPushPlusNotification } from './pushplus.service.js';
import { sendBarkNotification } from './bark.service.js';
import { sendGotifyNotification } from './gotify.service.js';
import { sendMeowNotification } from './meow.service.js';
import { sendPushMeNotification } from './pushme.service.js';
import { sendPushDeerNotification } from './pushdeer.service.js';
import { sendTwilioSmsNotification } from './twilio.service.js';
import { sendWeComAppNotification } from './wecomapp.service.js';
import { sendServerChan3Notification } from './serverchan3.service.js';
import { sendXizhiNotification } from './xizhi.service.js';
import { sendAnPushNotification } from './anpush.service.js';
import { sendChanifyNotification } from './chanify.service.js';
import { sendPushbackNotification } from './pushback.service.js';
import { sendSimplePushNotification } from './simplepush.service.js';
import { sendZulipNotification } from './zulip.service.js';
import { sendRocketChatNotification } from './rocketchat.service.js';
import { sendFcmNotification } from './fcm.service.js';
import { sendTwilioWhatsAppNotification } from './twilio-whatsapp.service.js';
import { filterSupportedChannels } from './supported-channels.js';
import { resolveProfileRoutedAccountIds } from '../reminder-channel-resolver.service.js';

function formatLunarLabel(lunarDateRaw: unknown): string {
  if (!lunarDateRaw) return '';
  try {
    const d = typeof lunarDateRaw === 'string' ? JSON.parse(lunarDateRaw) : lunarDateRaw;
    if (!d?.month || !d?.day) return '';
    const prefix = d.isLeap ? '闰' : '';
    return `农历${prefix}${d.month}月${d.day}日`;
  } catch {
    return '';
  }
}

import { getUserConfig, getRelationshipMappings, getNotificationAccounts, getEventTemplate } from '../config.service.js';
import { applyRelationshipMapping } from '@timemark/shared/relationship';
import { getBlessing } from '@timemark/shared/blessings';
import { generateNotificationContent } from '@timemark/shared/templates';
import { query } from '../../db/index.js';
import { logEmail } from '../email-log.service.js';
import { enqueueNotificationRetry } from '../notification-retry.service.js';
import { getConflictHint } from '../conflict-hint.service.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { classifyErrorForRetry } from '../../utils/retry-classifier.js';
import { createLogger, logFireAndForget } from '../../utils/logger.js';

const log = createLogger('notifications');

function formatEventDateValue(date: unknown): string {
  if (!date) return '';
  if (date instanceof Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  if (typeof date === 'string') return date.split('T')[0];
  return String(date);
}

function parseReminderConfigField(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return {};
}

/** Normalize raw DB event rows for notification handlers (test-send, cron). */
export function normalizeEventForNotification(row: Record<string, unknown>): Record<string, unknown> {
  const reminderConfig = parseReminderConfigField(row.reminder_config ?? row.reminderConfig);
  const personName = row.person_name ?? row.personName;
  const reminderRecipientName = row.reminder_recipient_name ?? row.reminderRecipientName;
  return {
    ...row,
    name: String(row.name ?? ''),
    type: String(row.type ?? 'other'),
    date: formatEventDateValue(row.date),
    reminderConfig,
    reminder_config: reminderConfig,
    personName,
    person_name: personName,
    reminderRecipientName,
    reminder_recipient_name: reminderRecipientName,
  };
}

export function resolveRecipientEmails(event: Record<string, unknown>, chConfig: { emails?: string[] }, userConfig: Record<string, unknown> | null): string[] {
  const normalizeList = (list: string[]): string[] => [
    ...new Set(
      list
        .map((e) => String(e || '').trim().toLowerCase())
        .filter((e) => e.includes('@')),
    ),
  ];

  let parsedReminderConfig: { emailRecipients?: string[] } = {};
  try {
    const raw = event.reminder_config || event.reminderConfig;
    if (raw) {
      parsedReminderConfig = typeof raw === 'string' ? JSON.parse(raw) : (raw as { emailRecipients?: string[] });
    }
  } catch {
    // ignore
  }

  // 1. 事件里明确填写的提醒人邮箱
  if (parsedReminderConfig.emailRecipients?.length) {
    const emails = normalizeList(parsedReminderConfig.emailRecipients);
    if (emails.length) return emails;
  }

  // 2. 设置 → 默认测试/收件邮箱（未填事件邮箱时发给自己）
  if (userConfig?.default_test_email) {
    const email = String(userConfig.default_test_email).trim().toLowerCase();
    if (email.includes('@')) return [email];
  }

  // 3. 设置 → 默认提醒收件人列表
  if (Array.isArray(userConfig?.reminder_emails) && userConfig.reminder_emails.length) {
    const emails = normalizeList(userConfig.reminder_emails as string[]);
    if (emails.length) return emails;
  }

  // 4. 通知渠道账号上可选填的收件地址（最低优先级）
  if (chConfig.emails?.length) {
    const emails = normalizeList(chConfig.emails);
    if (emails.length) return emails;
  }

  return [];
}

/**
 * Check if current time is within quiet hours for the user's timezone.
 * Handles overnight ranges (e.g., "22:00" to "07:00").
 *
 * Exported for the medication reminder job (checkbox 73), which must respect
 * quiet hours for every non-critical medication and may bypass them only for a
 * medication explicitly marked `is_critical`. The semantics for every other
 * notification are unchanged.
 */
export function isInQuietHours(quietStart: string | null, quietEnd: string | null, timezone: string): boolean {
  if (!quietStart || !quietEnd) return false;

  const [startH, startM] = quietStart.split(':').map(Number);
  const [endH, endM] = quietEnd.split(':').map(Number);
  if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM)) return false;

  // Get current time in user's timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const currentH = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const currentM = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

  const currentMinutes = currentH * 60 + currentM;
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day range (e.g., 09:00 to 17:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight range (e.g., 22:00 to 07:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (!classifyErrorForRetry(error)) throw lastError;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// 通用 Webhook 渠道（通过配置文件中的 channel_webhooks 字段配置）
const genericWebhookChannels = new Set([
  'synologychat',
  'twitch',
]);

// 渠道类型到通知账户类型的映射
export const channelToAccountType: Record<string, string> = {
  'feishu': 'feishu',
  'wecom': 'wecom',
  'dingtalk': 'dingtalk',
  'telegram': 'telegram',
  'discord': 'discord',
  'slack': 'slack',
  'generic_webhook': 'generic_webhook',
  'wechat': 'wxpusher',
  'wxpusher': 'wxpusher',
  'qq': 'qmsg',
  'qmsg': 'qmsg',
  'email': 'email',
  'resend': 'resend',
  'smtp': 'smtp',
  // New mappings
  'googlechat': 'googlechat',
  'line': 'line',
  'matrix': 'matrix',
  'mattermost': 'mattermost',
  'msteams': 'msteams',
  'nextcloud_talk': 'nextcloud_talk',
  'nextcloudtalk': 'nextcloud_talk',
  'irc': 'irc',
  'synologychat': 'synologychat',
  'twitch': 'twitch',
  // New channels (batch 2)
  'ntfy': 'ntfy',
  'pushover': 'pushover',
  'apprise': 'apprise',
  'serverchan': 'serverchan',
  'pushplus': 'pushplus',
  'bark': 'bark',
  'gotify': 'gotify',
  'meow': 'meow',
  'pushme': 'pushme',
  'pushdeer': 'pushdeer',
  'twilio': 'twilio',
  'wecomapp': 'wecomapp',
  // Wave 2 channels (checkboxes 15-22)
  'serverchan3': 'serverchan3',
  'xizhi': 'xizhi',
  'anpush': 'anpush',
  'chanify': 'chanify',
  'pushback': 'pushback',
  'simplepush': 'simplepush',
  'zulip': 'zulip',
  'rocketchat': 'rocketchat',
  'fcm': 'fcm',
  'twilio_whatsapp': 'twilio_whatsapp',
};

/**
 * 主分发链（sendNotifications 中的 if/else）可处理的渠道 ID。
 * 与 `__tests__/channel-integrity.test.ts` 共享：渠道目录中的每个渠道都必须在此集合中，
 * 否则说明它被列入了支持的渠道目录却没有真正的发送分支。
 */
export const DISPATCHABLE_CHANNELS = new Set<string>([
  // Webhook
  'feishu',
  'wecom',
  'dingtalk',
  'discord',
  'slack',
  'googlechat',
  'irc',
  'synologychat',
  'twitch',
  'generic_webhook',
  'rocketchat',
  // Token
  'resend',
  'smtp',
  'telegram',
  'line',
  'matrix',
  'mattermost',
  'msteams',
  'nextcloud_talk',
  'wxpusher',
  'qmsg',
  'serverchan',
  'pushplus',
  'bark',
  'gotify',
  'meow',
  'pushme',
  'pushdeer',
  'twilio',
  'wecomapp',
  'ntfy',
  'pushover',
  'apprise',
  'serverchan3',
  'xizhi',
  'anpush',
  'chanify',
  'pushback',
  'simplepush',
  'zulip',
  'fcm',
  'twilio_whatsapp',
  // Legacy aliases（旧事件里可能仍存有这些渠道 ID）
  'wechat',
  'qq',
  'email',
]);

/**
 * 回退分发链（sendSingleChannel）可处理的渠道 ID。必须与上面的集合保持一致——
 * 两个集合由 `channel-integrity.test.ts` 同时校验。
 */
export const FALLBACK_DISPATCHABLE_CHANNELS = new Set<string>([
  // Webhook
  'feishu',
  'wecom',
  'dingtalk',
  'discord',
  'slack',
  'googlechat',
  'irc',
  'synologychat',
  'twitch',
  'generic_webhook',
  'rocketchat',
  // Token
  'resend',
  'smtp',
  'telegram',
  'line',
  'matrix',
  'mattermost',
  'msteams',
  'nextcloud_talk',
  'wxpusher',
  'qmsg',
  'serverchan',
  'pushplus',
  'bark',
  'gotify',
  'meow',
  'pushme',
  'pushdeer',
  'twilio',
  'wecomapp',
  'ntfy',
  'pushover',
  'apprise',
  'serverchan3',
  'xizhi',
  'anpush',
  'chanify',
  'pushback',
  'simplepush',
  'zulip',
  'fcm',
  'twilio_whatsapp',
  // Legacy aliases（旧事件里可能仍存有这些渠道 ID）
  'wechat',
  'qq',
  'email',
]);

/**
 * 根据账户类型获取通知配置
 */
function getChannelConfigFromAccount(
  account: any,
  channel: string
): { webhook?: string; token?: string; secret?: string; chat_id?: string; priority?: number; server_url?: string; sessionData?: any; toUser?: string; email?: string; apiKey?: string; emails?: string[]; fromEmail?: string } | null {
  // 直接使用账户的字段
  switch (channel) {
    // Email channels
    case 'email':
    case 'resend': {
      const recipient = account.chat_id?.trim();
      const normalized = recipient && recipient.includes('@') ? recipient.toLowerCase() : null;
      const emails = normalized ? [normalized] : [];
      return {
        apiKey: account.token,
        emails,
        fromEmail: account.webhook || 'onboarding@resend.dev',
      };
    }
    
    case 'smtp':
      return (account.webhook && account.token && account.chat_id)
        ? { webhook: account.webhook, token: account.token, secret: account.secret, chat_id: account.chat_id }
        : null;
    
    // Webhook-based channels
    case 'feishu':
    case 'wecom':
    case 'discord':
    case 'slack':
    case 'googlechat':
    case 'irc':
    case 'synologychat':
    case 'twitch':
      return account.webhook ? { webhook: account.webhook } : null;
    
    case 'generic_webhook':
      return account.webhook
        ? { webhook: account.webhook, secret: account.secret }
        : null;
    
    case 'dingtalk':
      return (account.webhook && account.secret)
        ? { webhook: account.webhook, secret: account.secret }
        : account.webhook ? { webhook: account.webhook } : null;
    
    // Token-based channels
    case 'telegram':
      return (account.token && account.chat_id)
        ? { token: account.token, chat_id: account.chat_id }
        : null;
    
    case 'line':
    case 'wxpusher':
    case 'qmsg':
      return (account.token && account.chat_id)
        ? { token: account.token, chat_id: account.chat_id }
        : null;
    
    case 'matrix':
      return (account.webhook && account.token && account.chat_id)
        ? { webhook: account.webhook, token: account.token, chat_id: account.chat_id, server_url: account.webhook }
        : null;
    
    case 'mattermost':
    case 'nextcloud_talk':
      return (account.webhook && account.token && account.chat_id)
        ? { webhook: account.webhook, token: account.token, chat_id: account.chat_id, server_url: account.webhook }
        : null;
    
    case 'msteams':
      return (account.token && account.chat_id)
        ? { token: account.token, chat_id: account.chat_id }
        : null;
    
    // New token-based channels (batch 2)
    case 'serverchan':
      return account.token
        ? { token: account.token }
        : null;
    
    case 'pushplus':
      return account.token
        ? { token: account.token, chat_id: account.chat_id }
        : null;
    
    case 'bark':
      return (account.webhook && account.token)
        ? { webhook: account.webhook, token: account.token, chat_id: account.chat_id, secret: account.secret }
        : null;
    
    case 'gotify':
      return (account.webhook && account.token)
        ? { webhook: account.webhook, token: account.token, chat_id: account.chat_id }
        : null;
    
    case 'meow':
      return account.token
        ? { token: account.token }
        : null;
    
    case 'pushme':
      return account.token
        ? { token: account.token }
        : null;

    case 'pushdeer':
      return account.token
        ? { token: account.token, webhook: account.webhook }
        : null;

    case 'twilio':
      return (account.token && account.secret && account.webhook && account.chat_id)
        ? { token: account.token, secret: account.secret, webhook: account.webhook, chat_id: account.chat_id }
        : null;
    
    case 'wecomapp':
      return (account.token && account.secret && account.chat_id && account.webhook)
        ? { token: account.token, secret: account.secret, chat_id: account.chat_id, webhook: account.webhook }
        : null;
    
    case 'ntfy':
      return (account.webhook && account.token)
        ? { webhook: account.webhook, token: account.token }
        : null;
    
    case 'pushover': {
      if (!account.token || !account.secret) return null;
      const rawPriority = account.chat_id != null ? parseInt(String(account.chat_id), 10) : 0;
      const priority = Number.isFinite(rawPriority) && rawPriority >= -2 && rawPriority <= 2 ? rawPriority : 0;
      return { token: account.token, secret: account.secret, priority };
    }
    
    case 'apprise':
      return account.webhook
        ? { webhook: account.webhook, token: account.token }
        : null;

    // Wave 2 channels (checkboxes 15-22)
    case 'serverchan3':
      return account.token
        ? { token: account.token, webhook: account.webhook }
        : null;

    case 'xizhi':
      return account.token ? { token: account.token } : null;

    case 'anpush':
      return account.token
        ? { token: account.token, chat_id: account.chat_id }
        : null;

    case 'chanify':
      // 服务器地址可留空（默认官方 API），设备 Token 必填
      return account.token
        ? { webhook: account.webhook, token: account.token }
        : null;

    case 'pushback':
      return (account.token && account.chat_id)
        ? { token: account.token, chat_id: account.chat_id }
        : null;

    case 'simplepush':
      return account.token ? { token: account.token } : null;

    case 'zulip':
      return (account.webhook && account.token && account.chat_id && account.secret)
        ? { webhook: account.webhook, token: account.token, chat_id: account.chat_id, secret: account.secret }
        : null;

    case 'rocketchat':
      return account.webhook ? { webhook: account.webhook } : null;

    case 'fcm':
      return (account.token && account.chat_id)
        ? { token: account.token, chat_id: account.chat_id }
        : null;

    case 'twilio_whatsapp':
      return (account.token && account.secret && account.webhook && account.chat_id)
        ? { token: account.token, secret: account.secret, webhook: account.webhook, chat_id: account.chat_id }
        : null;
    
    default:
      return null;
  }
}

/**
 * Per-channel result entry returned by sendNotifications.
 * Every requested channel must produce one entry: success, failure, or
 * 'no_configuration' when no account/legacy config resolves for it.
 */
type ChannelResultEntry = { success: boolean; error?: string; accountId?: number; recipients?: string[] };
type ChannelResultMap = Record<string, ChannelResultEntry>;

/**
 * Send notifications for an event through specified channels
 * 
 * This is the main notification dispatcher. It:
 * 1. Loads user configuration and notification accounts
 * 2. Applies relationship mapping to the event name
 * 3. Routes to appropriate channel handlers (email, webhook, plugin)
 * 4. Handles retries with exponential backoff
 * 
 * @param event - The event object from database (raw row)
 * @param userId - The user's ID
 * @param channels - Array of channel IDs to send through (e.g., ['resend', 'telegram'])
 */
export async function sendNotifications(
  event: any,
  userId: number,
  channels: string[],
  options?: { skipQuietHours?: boolean; profileId?: number | null },
): Promise<ChannelResultMap> {
  event = normalizeEventForNotification(event as Record<string, unknown>);
  const config = await getUserConfig(userId);

  const userTimezone = config?.timezone || 'Asia/Shanghai';
  if (!options?.skipQuietHours && isInQuietHours(config?.quiet_hours_start, config?.quiet_hours_end, userTimezone)) {
    console.log(`[Notifications] Skipping send during quiet hours for user ${userId}`);
    const quietHourResults: ChannelResultMap = {
      _quiet_hours: { success: false, error: 'quiet_hours' },
    };
    for (const ch of new Set(channels)) {
      quietHourResults[ch] = { success: false, error: 'quiet_hours' };
    }
    return quietHourResults;
  }

  // Vercel / cloud: only HTTP-based channels
  const requestedChannels = channels.slice();
  const supportedChannels = filterSupportedChannels(requestedChannels);
  // Ids dropped by filterSupportedChannels must still be reported (never silently omitted).
  const droppedChannels = [...new Set(requestedChannels.filter((ch) => !supportedChannels.includes(ch)))];
  channels = supportedChannels;
  if (channels.length === 0) {
    const skippedResults: ChannelResultMap = {
      _skipped: { success: false, error: 'no_supported_channels' },
    };
    for (const ch of droppedChannels) {
      skippedResults[ch] = { success: false, error: 'unsupported_channel' };
    }
    return skippedResults;
  }

  const channelWebhooks = config?.channel_webhooks || {};
  
  // 获取关系映射
  const mappings = await getRelationshipMappings(userId, event.id);
  // Apply default relationship mapping for all channels
  const defaultMappedName = applyRelationshipMapping(event.name, mappings);
  const mappedEvent: any = { ...event, name: defaultMappedName };

  const conflictHint = await getConflictHint(userId, String(event.date).slice(0, 10), Number(event.id) || undefined);
  if (conflictHint) {
    mappedEvent.conflictHint = conflictHint;
  }
  
  // Try to get user-customized template for this event type
  const userTemplate = await getEventTemplate(userId, event.type);
  if (userTemplate) {
    const blessing = getBlessing(event.type, event.reminderConfig?.customMessage, event.personName, event.reminderRecipientName);
    const today = new Date();
    const eventDate = new Date(event.date);
    const daysUntil = Math.max(0, Math.ceil((eventDate.getTime() - today.getTime()) / (86400 * 1000)));
    const renderedContent = generateNotificationContent(
      userTemplate.template_content,
      {
        name: mappedEvent.name,
        date: event.date,
        type: event.type,
        personName: event.person_name || event.personName,
        lunarDate: formatLunarLabel(event.lunar_date),
        calendarType: event.calendar_type,
      },
      daysUntil,
      blessing,
      event.reminder_time
    );
    mappedEvent.customMessage = renderedContent;
  }

  if (conflictHint) {
    const base = mappedEvent.customMessage
      || `**日期:** ${event.date}\n**类型:** ${event.type}`;
    mappedEvent.customMessage = `${base}\n\n📅 ${conflictHint}`;
  }

  // C34: 默认模板也追加农历标签
  const lunarLabel = formatLunarLabel(event.lunar_date);
  if (lunarLabel && !mappedEvent.customMessage) {
    mappedEvent.customMessage = `**日期:** ${event.date}（${lunarLabel}）\n**类型:** ${event.type}`;
  } else if (lunarLabel && mappedEvent.customMessage && !mappedEvent.customMessage.includes(lunarLabel)) {
    mappedEvent.customMessage = `${mappedEvent.customMessage}\n📅 ${lunarLabel}`;
  }
  
  // 获取事件绑定的通知账户ID
  const boundAccountIds: number[] = (() => {
    const raw = event.notification_account_ids;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter((id): id is number => typeof id === 'number');
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : [];
    } catch {
      return [];
    }
  })();
  
  // 获取用户所有通知账户
  const allAccounts = await getNotificationAccounts(userId);

  // 档案级通知路由（checkbox 70）：该档案存在显式路由行时，只有这些账户参与
  // 「未显式绑定账户」的渠道解析与失败回退；没有路由行 = 回退全部启用账户。
  // 事件级 notification_account_ids 绑定不受影响（下面 boundAccountIds 分支仍优先）。
  const routedAccountIds = await resolveProfileRoutedAccountIds(userId, options?.profileId);
  const eligibleAccounts = routedAccountIds === null
    ? allAccounts
    : allAccounts.filter((account) => routedAccountIds.has(Number(account.id)));
  
  // 构建账户ID到账户的映射
  const accountsMap = new Map<number, any>();
  for (const account of allAccounts) {
    accountsMap.set(account.id, account);
  }
  
  // 为每个渠道准备配置（支持多账号：一个渠道可能有多个账号）
  const channelConfigsMap: Record<string, any[]> = {};
  
  for (const ch of channels) {
    const configs: any[] = [];
    
    if (boundAccountIds.length > 0) {
      // 找到所有匹配渠道类型的已绑定账户
      const accountType = channelToAccountType[ch];
      for (const accountId of boundAccountIds) {
        const account = accountsMap.get(accountId);
        if (account && account.type === accountType && account.is_active) {
          const accountConfig = getChannelConfigFromAccount(account, ch);
          if (accountConfig) configs.push(accountConfig);
        }
      }
    } else {
      // 未显式绑定时，使用该渠道所有已启用的通知账号（与渠道测试页一致）。
      // 档案路由存在时只在这些账户里选（eligibleAccounts），否则就是全部启用账户。
      const accountType = channelToAccountType[ch];
      if (accountType) {
        for (const account of eligibleAccounts) {
          if (account.type === accountType && account.is_active) {
            const accountConfig = getChannelConfigFromAccount(account, ch);
            if (accountConfig) configs.push(accountConfig);
          }
        }
      }
    }
    
    // 最后回退 legacy user_configs 全局字段
    if (configs.length === 0) {
      const globalConfig: any = {};
      switch (ch) {
        case 'feishu':
          if (config?.feishu_webhook) globalConfig.webhook = config.feishu_webhook;
          break;
        case 'wecom':
          if (config?.wecom_webhook) globalConfig.webhook = config.wecom_webhook;
          break;
        case 'dingtalk':
          if (config?.dingtalk_webhook && config?.dingtalk_secret) {
            globalConfig.webhook = config.dingtalk_webhook;
            globalConfig.secret = config.dingtalk_secret;
          }
          break;
        case 'telegram':
          if (config?.telegram_bot_token && config?.telegram_chat_id) {
            globalConfig.token = config.telegram_bot_token;
            globalConfig.chat_id = config.telegram_chat_id;
          }
          break;
        case 'discord':
          if (config?.discord_webhook) globalConfig.webhook = config.discord_webhook;
          break;
        case 'slack':
          if (config?.slack_webhook) globalConfig.webhook = config.slack_webhook;
          break;
        case 'wechat':
        case 'wxpusher':
          if (config?.wxpusher_app_token && config?.wxpusher_uid) {
            globalConfig.token = config.wxpusher_app_token;
            globalConfig.chat_id = config.wxpusher_uid;
          }
          break;
        case 'qq':
        case 'qmsg':
          if (config?.qmsg_key) {
            globalConfig.token = config.qmsg_key;
            globalConfig.chat_id = config.qmsg_qq;
          }
          break;
        case 'email':
        case 'resend':
          if (config?.resend_api_key) {
            globalConfig.apiKey = config.resend_api_key;
            // Get email addresses from notification_accounts
            const emailAccounts = eligibleAccounts.filter(a => (a.type === 'email' || a.type === 'resend') && a.is_active);
            if (emailAccounts.length > 0) {
              globalConfig.emails = emailAccounts.map((a: any) => a.chat_id || a.name);
            } else if (config?.reminder_emails?.length > 0) {
              // Fallback to legacy reminder_emails
              globalConfig.emails = config.reminder_emails;
            }
          }
          break;
        default:
          if (genericWebhookChannels.has(ch) && channelWebhooks[ch]) {
            globalConfig.webhook = channelWebhooks[ch];
          }
      }
      
      if (Object.keys(globalConfig).length > 0) {
        configs.push(globalConfig);
      }
    }
    
    if (configs.length > 0) {
      channelConfigsMap[ch] = configs;
    }
  }
  
  // 发送通知（每个渠道可能有多个账号配置，独立发送）
  const channelResults: ChannelResultMap = {};
  // 每个被请求的渠道都必须出现在结果里：被 filterSupportedChannels 丢弃的报告 unsupported_channel，
  // 没有任何配置解析出来的报告 no_configuration，而不是静默省略（复选框 12）。
  for (const ch of droppedChannels) {
    channelResults[ch] = { success: false, error: 'unsupported_channel' };
  }
  for (const ch of channels) {
    if (!channelConfigsMap[ch] || channelConfigsMap[ch].length === 0) {
      channelResults[ch] = { success: false, error: 'no_configuration' };
    }
  }
  const channelSendMeta: Record<string, { recipients?: string[] }> = {};
  
  // Build account ID lookup for bound accounts
  const configToAccountId = new Map<any, number>();
  for (const ch of channels) {
    const configs = channelConfigsMap[ch];
    if (!configs) continue;
    const accountType = channelToAccountType[ch];
    for (const cfg of configs) {
      // Find matching account by config reference
      for (const accountId of boundAccountIds) {
        const account = accountsMap.get(accountId);
        if (account && account.type === accountType) {
          const accountConfig = getChannelConfigFromAccount(account, ch);
          if (accountConfig && JSON.stringify(accountConfig) === JSON.stringify(cfg)) {
            configToAccountId.set(cfg, accountId);
          }
        }
      }
    }
  }
  
  const sendTasks: Array<{ channel: string; accountId?: number; promise: Promise<void> }> = channels.flatMap((ch) => {
    const configs = channelConfigsMap[ch];
    if (!configs || configs.length === 0) return [];
    
    return configs.map((chConfig) => ({
      channel: ch,
      accountId: configToAccountId.get(chConfig),
      promise: (async () => {
        try {
        if (!DISPATCHABLE_CHANNELS.has(ch)) {
          throw new Error(`渠道 ${ch} 未注册主分发分支（DISPATCHABLE_CHANNELS）`);
        }
        if (ch === 'feishu' && chConfig.webhook) await retryWithBackoff(() => sendFeishuNotification(mappedEvent, chConfig.webhook));
        else if (ch === 'wecom' && chConfig.webhook) await retryWithBackoff(() => sendWeComNotification(mappedEvent, chConfig.webhook));
        else if (ch === 'dingtalk' && chConfig.webhook && chConfig.secret)
          await retryWithBackoff(() => sendDingTalkNotification(mappedEvent, chConfig.webhook, chConfig.secret));
        else if (ch === 'telegram' && chConfig.token && chConfig.chat_id)
          await retryWithBackoff(() => sendTelegramNotification(mappedEvent, chConfig.token, chConfig.chat_id));
        else if (ch === 'discord' && chConfig.webhook)
          await retryWithBackoff(() => sendDiscordNotification(mappedEvent, chConfig.webhook));
        else if (ch === 'slack' && chConfig.webhook)
          await retryWithBackoff(() => sendSlackNotification(mappedEvent, chConfig.webhook));
        else if (ch === 'googlechat' && chConfig.webhook)
          await retryWithBackoff(() => sendGoogleChatNotification(mappedEvent, chConfig.webhook));
        else if (ch === 'irc' && chConfig.webhook)
          await retryWithBackoff(() => sendIRCNotification(mappedEvent, chConfig.webhook));
        else if (ch === 'line' && chConfig.token && chConfig.chat_id)
          await retryWithBackoff(() => sendLINENotification(mappedEvent, chConfig.token, chConfig.chat_id));
        else if (ch === 'msteams' && chConfig.token && chConfig.chat_id)
          await retryWithBackoff(() => sendMicrosoftTeamsNotification(mappedEvent, chConfig.token, chConfig.chat_id));
        else if ((ch === 'wechat' || ch === 'wxpusher') && chConfig.token && chConfig.chat_id)
          await retryWithBackoff(() => sendWxPusherNotification(mappedEvent, chConfig.token, chConfig.chat_id));
        else if ((ch === 'qq' || ch === 'qmsg') && chConfig.token)
          await retryWithBackoff(() => sendQmsgNotification(mappedEvent, chConfig.token, chConfig.chat_id));
        else if ((ch === 'email' || ch === 'resend') && chConfig.apiKey) {
          const fromEmail = chConfig.fromEmail || 'TimeMark <noreply@timemark.app>';
          const recipientEmails = resolveRecipientEmails(event, chConfig, config);

          if (recipientEmails.length === 0) {
            throw new Error('未配置收件邮箱：请在事件、通知渠道或设置中填写默认邮箱');
          }

          const todayKey = new Date().toISOString().slice(0, 10);
          const minuteKey = new Date().toISOString().slice(0, 16);

          for (const email of recipientEmails) {
            const emailMappedEvent = {
              ...mappedEvent,
              name: applyRelationshipMapping(event.name, mappings, email),
            };
            const idempotencyKey = `reminder-${event.id}-${todayKey}-${userId}-${minuteKey}-${email}`;
            try {
              await retryWithBackoff(() => sendEmailNotification(
                emailMappedEvent,
                chConfig.apiKey,
                fromEmail,
                email,
                idempotencyKey,
                { markdownTemplate: config?.markdown_email_template },
              ));
              await logEmail({
                userId,
                eventId: event.id ? Number(event.id) : null,
                recipient: email,
                status: 'sent',
                subject: emailMappedEvent.name,
                channelType: ch,
              });
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error);
              await logEmail({
                userId,
                eventId: event.id ? Number(event.id) : null,
                recipient: email,
                status: 'failed',
                subject: emailMappedEvent.name,
                errorMessage: errMsg,
                channelType: ch,
              });
              throw error;
            }
          }
          channelSendMeta[ch] = { recipients: recipientEmails };
        }
        else if (ch === 'smtp' && chConfig.webhook && chConfig.token && chConfig.chat_id) {
          const smtpHost = chConfig.webhook;
          const smtpPort = parseInt(chConfig.secret || '587', 10);
          const password = chConfig.token;
          const fromEmail = chConfig.chat_id;
          const smtpRecipients = resolveRecipientEmails(event, chConfig, config);
          if (smtpRecipients.length === 0) {
            throw new Error('未配置 SMTP 收件邮箱：请在事件或设置中填写提醒邮箱');
          }
          for (const recipient of smtpRecipients) {
            const emailMappedEvent = {
              ...mappedEvent,
              name: applyRelationshipMapping(event.name, mappings, recipient),
            };
            await retryWithBackoff(() => sendSmtpNotification(
              emailMappedEvent,
              smtpHost,
              smtpPort,
              password,
              fromEmail,
              recipient,
              { markdownTemplate: config?.markdown_email_template },
            ));
          }
          channelSendMeta[ch] = { recipients: smtpRecipients };
        }
        else if (ch === 'generic_webhook' && chConfig.webhook)
          await retryWithBackoff(() => sendGenericWebhookNotification(mappedEvent, chConfig.webhook, ch));
        else if (ch === 'synologychat' && chConfig.webhook)
          await retryWithBackoff(() => sendSynologyChatNotification(mappedEvent, chConfig.webhook));
        else if (ch === 'twitch' && chConfig.webhook)
          await retryWithBackoff(() => sendTwitchNotification(mappedEvent, chConfig.webhook));
        else if (genericWebhookChannels.has(ch) && chConfig.webhook)
          await retryWithBackoff(() => sendGenericWebhookNotification(mappedEvent, chConfig.webhook, ch));
        // Token-based channels with dedicated APIs
        else if (ch === 'nextcloud_talk' && chConfig.server_url && chConfig.token && chConfig.chat_id)
          await retryWithBackoff(() => sendNextcloudTalkNotification(mappedEvent, chConfig.server_url, chConfig.token, chConfig.chat_id));
        else if (ch === 'mattermost' && chConfig.server_url && chConfig.token && chConfig.chat_id)
          await retryWithBackoff(() => sendMattermostNotification(mappedEvent, chConfig.server_url, chConfig.token, chConfig.chat_id));
        // Matrix channel (token-based with homeserver URL)
        else if (ch === 'matrix' && chConfig.server_url && chConfig.token && chConfig.chat_id)
          await retryWithBackoff(() => sendMatrixNotification(mappedEvent, chConfig.server_url, chConfig.token, chConfig.chat_id));
        // New token-based channels (batch 2)
        else if (ch === 'serverchan' && chConfig.token)
          await retryWithBackoff(() => sendServerChanNotification(mappedEvent, chConfig.token));
        else if (ch === 'pushplus' && chConfig.token)
          await retryWithBackoff(() => sendPushPlusNotification(mappedEvent, chConfig.token, chConfig.chat_id));
        else if (ch === 'bark' && chConfig.webhook && chConfig.token)
          await retryWithBackoff(() => sendBarkNotification(mappedEvent, chConfig.webhook, chConfig.token, chConfig.chat_id, chConfig.secret));
        else if (ch === 'gotify' && chConfig.webhook && chConfig.token)
          await retryWithBackoff(() => sendGotifyNotification(mappedEvent, chConfig.webhook, chConfig.token, chConfig.chat_id ? Number(chConfig.chat_id) : 5));
        else if (ch === 'meow' && chConfig.token)
          await retryWithBackoff(() => sendMeowNotification(mappedEvent, chConfig.token));
        else if (ch === 'pushme' && chConfig.token)
          await retryWithBackoff(() => sendPushMeNotification(mappedEvent, chConfig.token));
        else if (ch === 'pushdeer' && chConfig.token)
          await retryWithBackoff(() => sendPushDeerNotification(mappedEvent, chConfig.token, chConfig.webhook));
        else if (ch === 'twilio' && chConfig.token && chConfig.secret && chConfig.webhook && chConfig.chat_id)
          await retryWithBackoff(() => sendTwilioSmsNotification(
            mappedEvent, chConfig.token, chConfig.secret, chConfig.webhook, chConfig.chat_id,
          ));
        else if (ch === 'wecomapp' && chConfig.token && chConfig.secret && chConfig.chat_id && chConfig.webhook)
          await retryWithBackoff(() => sendWeComAppNotification(mappedEvent, chConfig.token, chConfig.secret, chConfig.chat_id, chConfig.webhook));
        // Ntfy, Pushover, Apprise
        else if (ch === 'ntfy' && chConfig.webhook && chConfig.token)
          await retryWithBackoff(() => sendNtfyNotification(mappedEvent, chConfig.webhook, chConfig.token));
        else if (ch === 'pushover' && chConfig.token && chConfig.secret)
          await retryWithBackoff(() => sendPushoverNotification(mappedEvent, chConfig.token, chConfig.secret, chConfig.priority));
        else if (ch === 'apprise' && chConfig.webhook)
          await retryWithBackoff(() => sendAppriseNotification(mappedEvent, chConfig.webhook, chConfig.token));
        // Wave 2 channels (checkboxes 15-22)
        else if (ch === 'serverchan3' && chConfig.token)
          await retryWithBackoff(() => sendServerChan3Notification(mappedEvent, chConfig.token, chConfig.webhook));
        else if (ch === 'xizhi' && chConfig.token)
          await retryWithBackoff(() => sendXizhiNotification(mappedEvent, chConfig.token));
        else if (ch === 'anpush' && chConfig.token)
          await retryWithBackoff(() => sendAnPushNotification(mappedEvent, chConfig.token, chConfig.chat_id));
        else if (ch === 'chanify' && chConfig.token)
          await retryWithBackoff(() => sendChanifyNotification(mappedEvent, chConfig.webhook, chConfig.token));
        else if (ch === 'pushback' && chConfig.token && chConfig.chat_id)
          await retryWithBackoff(() => sendPushbackNotification(mappedEvent, chConfig.token, chConfig.chat_id));
        else if (ch === 'simplepush' && chConfig.token)
          await retryWithBackoff(() => sendSimplePushNotification(mappedEvent, chConfig.token));
        else if (ch === 'zulip' && chConfig.webhook && chConfig.token && chConfig.chat_id && chConfig.secret)
          await retryWithBackoff(() => sendZulipNotification(mappedEvent, chConfig.webhook, chConfig.token, chConfig.chat_id, chConfig.secret));
        else if (ch === 'rocketchat' && chConfig.webhook)
          await retryWithBackoff(() => sendRocketChatNotification(mappedEvent, chConfig.webhook));
        else if (ch === 'fcm' && chConfig.token && chConfig.chat_id)
          await retryWithBackoff(() => sendFcmNotification(mappedEvent, chConfig.token, chConfig.chat_id));
        else if (ch === 'twilio_whatsapp' && chConfig.token && chConfig.secret && chConfig.webhook && chConfig.chat_id)
          await retryWithBackoff(() => sendTwilioWhatsAppNotification(
            mappedEvent, chConfig.token, chConfig.secret, chConfig.webhook, chConfig.chat_id,
          ));
        else {
          throw new Error(`渠道 ${ch} 配置不完整，无法发送`);
        }
      } catch (e) {
        log.warn({ event: 'notification.channel_send_failed', channel: ch, err: e }, `Channel ${ch} send failed`);
        throw e;
      }
      })(),
    }));
  });
  
  // B23: 渠道发送并发限制 5
  const settled = await mapWithConcurrency(sendTasks, 5, async (task) => {
    try {
      await task.promise;
      return { task, status: 'fulfilled' as const };
    } catch (reason) {
      return { task, status: 'rejected' as const, reason };
    }
  });

  for (const result of settled) {
    const task = result.task;
    const ch = task.channel;
    if (result.status === 'fulfilled') {
      const meta = channelSendMeta[ch];
      channelResults[ch] = {
        success: true,
        accountId: task.accountId,
        ...(meta?.recipients?.length ? { recipients: meta.recipients } : {}),
      };
      // Reset consecutive failure count on success
      if (task.accountId) {
        try {
          await query(
            `UPDATE notification_accounts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [task.accountId]
          );
        } catch { /* ignore */ }
      }
    } else {
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      channelResults[ch] = { success: false, error: errMsg, accountId: task.accountId };
      if (task.accountId) {
        await trackConsecutiveFailure(task.accountId, ch, errMsg);
      }
      if (event.id) {
        // Fire-and-forget: the send result map is returned regardless of whether
        // the retry row can be persisted; a failure is logged, never rethrown.
        enqueueNotificationRetry({
          eventId: Number(event.id),
          userId,
          channel: ch,
          accountId: task.accountId,
          errorMessage: errMsg,
        }).catch(
          logFireAndForget(
            'notification.retry_enqueue_failed',
            `Failed to enqueue retry for ${ch}`,
          ),
        );
      }
    }
  }
  
  // Channel fallback: when primary channel fails, try other active accounts (max 2 fallback attempts)
  // 'no_configuration' / 'unsupported_channel' are capability mistakes, not send failures:
  // they must not trigger fallback sends nor consecutive-failure tracking.
  const failedChannels = Object.entries(channelResults).filter(
    ([, r]) => !r.success && r.error !== 'no_configuration' && r.error !== 'unsupported_channel',
  );
  if (failedChannels.length > 0 && eligibleAccounts.length > 1) {
    // Collect account IDs already tried
    const triedAccountIds = new Set<number>();
    for (const task of sendTasks) {
      if (task.accountId) triedAccountIds.add(task.accountId);
    }
    
    // Find other active accounts not already tried (within the profile's routing, if any)
    const fallbackCandidates = eligibleAccounts.filter(
      a => a.is_active && !triedAccountIds.has(a.id)
    );
    
    let fallbackAttempts = 0;
    const maxFallbacks = 2;
    
    for (const [failedCh] of failedChannels) {
      if (fallbackAttempts >= maxFallbacks) break;
      
      for (const candidate of fallbackCandidates) {
        if (fallbackAttempts >= maxFallbacks) break;
        
        const candidateChannel = Object.entries(channelToAccountType).find(
          ([, type]) => type === candidate.type
        )?.[0];
        if (!candidateChannel) continue;
        
        // Skip if this channel type was already tried and succeeded
        if (channelResults[candidateChannel]?.success) continue;
        
        const fallbackConfig = getChannelConfigFromAccount(candidate, candidateChannel);
        if (!fallbackConfig) continue;
        
        console.log(`[Fallback] Primary channel ${failedCh} failed, trying ${candidateChannel} (account ${candidate.id})`);
        fallbackAttempts++;
        
        try {
          await retryWithBackoff(async () => {
            await sendSingleChannel(candidateChannel, fallbackConfig, mappedEvent, event, config);
          }, 2, 500); // Fewer retries for fallback
          
          channelResults[candidateChannel] = { success: true, accountId: candidate.id };
          console.log(`[Fallback] Successfully sent via ${candidateChannel} (account ${candidate.id})`);
          break; // One successful fallback is enough for this failed channel
        } catch (fallbackErr) {
          const fbErrMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          console.error(`[Fallback] ${candidateChannel} (account ${candidate.id}) also failed: ${fbErrMsg}`);
          channelResults[`${candidateChannel}_fallback`] = { success: false, error: fbErrMsg, accountId: candidate.id };
        }
      }
    }
  }

  const successfulChannels = Object.entries(channelResults)
    .filter(([key, r]) => r.success && !key.startsWith('_'))
    .map(([ch]) => ch);
  if (successfulChannels.length > 0) {
    // C13: 出站 webhook
    if (config?.outbound_webhook_url) {
      // Fire-and-forget: outbound webhook delivery is best-effort and must not
      // affect the channel result map returned to the caller.
      sendGenericWebhookNotification(
        { ...mappedEvent, triggerChannels: successfulChannels },
        config.outbound_webhook_url,
        'outbound',
      ).catch(
        logFireAndForget(
          'notification.outbound_webhook_failed',
          'Failed to deliver outbound webhook',
        ),
      );
    }
  }

  return channelResults;
}

/**
 * Send a notification through a single channel with given config.
 * Used by fallback logic to dispatch to the correct channel handler.
 */
async function sendSingleChannel(ch: string, chConfig: any, mappedEvent: any, event: any, config: any): Promise<void> {
  if (!FALLBACK_DISPATCHABLE_CHANNELS.has(ch)) {
    throw new Error(`No dispatch branch for fallback channel ${ch}`);
  }
  if (ch === 'feishu' && chConfig.webhook) await sendFeishuNotification(mappedEvent, chConfig.webhook);
  else if (ch === 'wecom' && chConfig.webhook) await sendWeComNotification(mappedEvent, chConfig.webhook);
  else if (ch === 'dingtalk' && chConfig.webhook && chConfig.secret)
    await sendDingTalkNotification(mappedEvent, chConfig.webhook, chConfig.secret);
  else if (ch === 'telegram' && chConfig.token && chConfig.chat_id)
    await sendTelegramNotification(mappedEvent, chConfig.token, chConfig.chat_id);
  else if (ch === 'discord' && chConfig.webhook) await sendDiscordNotification(mappedEvent, chConfig.webhook);
  else if (ch === 'slack' && chConfig.webhook) await sendSlackNotification(mappedEvent, chConfig.webhook);
  else if (ch === 'googlechat' && chConfig.webhook) await sendGoogleChatNotification(mappedEvent, chConfig.webhook);
  else if (ch === 'irc' && chConfig.webhook) await sendIRCNotification(mappedEvent, chConfig.webhook);
  else if (ch === 'line' && chConfig.token && chConfig.chat_id)
    await sendLINENotification(mappedEvent, chConfig.token, chConfig.chat_id);
  else if (ch === 'msteams' && chConfig.token && chConfig.chat_id)
    await sendMicrosoftTeamsNotification(mappedEvent, chConfig.token, chConfig.chat_id);
  else if ((ch === 'wechat' || ch === 'wxpusher') && chConfig.token && chConfig.chat_id)
    await sendWxPusherNotification(mappedEvent, chConfig.token, chConfig.chat_id);
  else if ((ch === 'qq' || ch === 'qmsg') && chConfig.token) await sendQmsgNotification(mappedEvent, chConfig.token, chConfig.chat_id);
  // Email-family channels: the fallback chain must cover them too (channel-integrity invariant).
  // Recipients resolve exactly like the main chain so a failed primary can fall back to email.
  else if ((ch === 'email' || ch === 'resend') && chConfig.apiKey) {
    const fromEmail = chConfig.fromEmail || 'TimeMark <noreply@timemark.app>';
    const recipientEmails = resolveRecipientEmails(event, chConfig, config);
    if (recipientEmails.length === 0) {
      throw new Error('未配置收件邮箱：请在事件、通知渠道或设置中填写默认邮箱');
    }
    for (const recipient of recipientEmails) {
      await sendEmailNotification(mappedEvent, chConfig.apiKey, fromEmail, recipient);
    }
  }
  else if (ch === 'smtp' && chConfig.webhook && chConfig.token && chConfig.chat_id) {
    const smtpRecipients = resolveRecipientEmails(event, chConfig, config);
    if (smtpRecipients.length === 0) {
      throw new Error('未配置 SMTP 收件邮箱：请在事件或设置中填写提醒邮箱');
    }
    const smtpPort = parseInt(chConfig.secret || '587', 10);
    for (const recipient of smtpRecipients) {
      await sendSmtpNotification(mappedEvent, chConfig.webhook, smtpPort, chConfig.token, chConfig.chat_id, recipient);
    }
  }
  else if (ch === 'serverchan' && chConfig.token) await sendServerChanNotification(mappedEvent, chConfig.token);
  else if (ch === 'pushplus' && chConfig.token) await sendPushPlusNotification(mappedEvent, chConfig.token, chConfig.chat_id);
  else if (ch === 'bark' && chConfig.webhook && chConfig.token)
    await sendBarkNotification(mappedEvent, chConfig.webhook, chConfig.token, chConfig.chat_id, chConfig.secret);
  else if (ch === 'gotify' && chConfig.webhook && chConfig.token)
    await sendGotifyNotification(mappedEvent, chConfig.webhook, chConfig.token, chConfig.chat_id ? Number(chConfig.chat_id) : 5);
  else if (ch === 'meow' && chConfig.token) await sendMeowNotification(mappedEvent, chConfig.token);
  else if (ch === 'pushme' && chConfig.token) await sendPushMeNotification(mappedEvent, chConfig.token);
  else if (ch === 'pushdeer' && chConfig.token) await sendPushDeerNotification(mappedEvent, chConfig.token, chConfig.webhook);
  else if (ch === 'twilio' && chConfig.token && chConfig.secret && chConfig.webhook && chConfig.chat_id)
    await sendTwilioSmsNotification(mappedEvent, chConfig.token, chConfig.secret, chConfig.webhook, chConfig.chat_id);
  else if (ch === 'wecomapp' && chConfig.token && chConfig.secret && chConfig.chat_id && chConfig.webhook)
    await sendWeComAppNotification(mappedEvent, chConfig.token, chConfig.secret, chConfig.chat_id, chConfig.webhook);
  else if (ch === 'ntfy' && chConfig.webhook && chConfig.token)
    await sendNtfyNotification(mappedEvent, chConfig.webhook, chConfig.token);
  else if (ch === 'pushover' && chConfig.token && chConfig.secret)
    await sendPushoverNotification(mappedEvent, chConfig.token, chConfig.secret);
  else if (ch === 'apprise' && chConfig.webhook)
    await sendAppriseNotification(mappedEvent, chConfig.webhook, chConfig.token);
  // Wave 2 channels (checkboxes 15-22)
  else if (ch === 'serverchan3' && chConfig.token)
    await sendServerChan3Notification(mappedEvent, chConfig.token, chConfig.webhook);
  else if (ch === 'xizhi' && chConfig.token) await sendXizhiNotification(mappedEvent, chConfig.token);
  else if (ch === 'anpush' && chConfig.token)
    await sendAnPushNotification(mappedEvent, chConfig.token, chConfig.chat_id);
  else if (ch === 'chanify' && chConfig.token)
    await sendChanifyNotification(mappedEvent, chConfig.webhook, chConfig.token);
  else if (ch === 'pushback' && chConfig.token && chConfig.chat_id)
    await sendPushbackNotification(mappedEvent, chConfig.token, chConfig.chat_id);
  else if (ch === 'simplepush' && chConfig.token) await sendSimplePushNotification(mappedEvent, chConfig.token);
  else if (ch === 'zulip' && chConfig.webhook && chConfig.token && chConfig.chat_id && chConfig.secret)
    await sendZulipNotification(mappedEvent, chConfig.webhook, chConfig.token, chConfig.chat_id, chConfig.secret);
  else if (ch === 'rocketchat' && chConfig.webhook) await sendRocketChatNotification(mappedEvent, chConfig.webhook);
  else if (ch === 'fcm' && chConfig.token && chConfig.chat_id)
    await sendFcmNotification(mappedEvent, chConfig.token, chConfig.chat_id);
  else if (ch === 'twilio_whatsapp' && chConfig.token && chConfig.secret && chConfig.webhook && chConfig.chat_id)
    await sendTwilioWhatsAppNotification(mappedEvent, chConfig.token, chConfig.secret, chConfig.webhook, chConfig.chat_id);
  else if (ch === 'generic_webhook' && chConfig.webhook)
    await sendGenericWebhookNotification(mappedEvent, chConfig.webhook, ch);
  else if (ch === 'synologychat' && chConfig.webhook)
    await sendSynologyChatNotification(mappedEvent, chConfig.webhook);
  else if (ch === 'twitch' && chConfig.webhook)
    await sendTwitchNotification(mappedEvent, chConfig.webhook);
  else if (genericWebhookChannels.has(ch) && chConfig.webhook)
    await sendGenericWebhookNotification(mappedEvent, chConfig.webhook, ch);
  else throw new Error(`No valid config for channel ${ch}`);
}

/**
 * Track consecutive failures for a notification account.
 * After 3 consecutive failures, auto-disable the account.
 */
async function trackConsecutiveFailure(accountId: number, channelType: string, _errorMsg: string): Promise<void> {
  try {
    // Count recent consecutive failures for this account
    const result = await query(
      `SELECT COUNT(*) as fail_count FROM event_trigger_logs 
       WHERE account_id = $1 AND channel_type = $2 AND status = 'failed'
       AND id > COALESCE(
         (SELECT MAX(id) FROM event_trigger_logs WHERE account_id = $3 AND channel_type = $4 AND status = 'success'),
         0
       )`,
      [accountId, channelType, accountId, channelType]
    );
    const consecutiveFailures = (result.rows[0]?.fail_count || 0) + 1; // +1 for current failure
    
    if (consecutiveFailures >= 3) {
      await query(
        `UPDATE notification_accounts SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [accountId]
      );
      console.log(`[Notifications] Channel ${channelType} (account ${accountId}) disabled after 3 consecutive failures`);
    }
  } catch (error) {
    log.warn(
      { event: 'notification.consecutive_failure_track_failed', accountId, channelType, err: error },
      'Failed to track consecutive failure',
    );
  }
}
