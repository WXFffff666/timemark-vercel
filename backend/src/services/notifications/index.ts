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
import { sendNostrNotification } from './nostr.service.js';

// Plugin channel services
import { sendNotification as sendWechatNotification } from './wechaty.service.js';
import { sendNotification as sendWhatsappNotification } from './whatsapp.service.js';
import { sendNotification as sendQQNotification } from './qqbot.service.js';
import { sendNotification as sendSignalNotification } from './signal.service.js';
import { sendNotification as sendZaloNotification } from './zalo.service.js';
import { sendNotification as sendBlueBubblesNotification } from './bluebubbles.service.js';

import { getUserConfig, getRelationshipMappings, getNotificationAccounts, getEventTemplate } from '../config.service.js';

// 通用 Webhook 渠道（通过配置文件中的 channel_webhooks 字段配置）
const genericWebhookChannels = new Set([
  'whatsapp',
  'signal',
  'imessage',
  'bluebubbles',
  'zalo',
  'zalo_personal',
  'network_chat',
  'nextcloudtalk',
  'nostr',
  'irc',
  'synologychat',
  'twitch',
  'matrix',
  'mattermost',
  'msteams',
  'line',
  'googlechat',
]);

// 渠道类型到通知账户类型的映射
const channelToAccountType: Record<string, string> = {
  'feishu': 'feishu',
  'wecom': 'wecom',
  'dingtalk': 'dingtalk',
  'telegram': 'telegram',
  'discord': 'discord',
  'slack': 'slack',
  'wechat': 'wxpusher',
  'qq': 'qmsg',
  'email': 'email',
  // New mappings
  'googlechat': 'googlechat',
  'line': 'line',
  'matrix': 'matrix',
  'mattermost': 'mattermost',
  'msteams': 'msteams',
  'nextcloudtalk': 'nextcloudtalk',
  'nostr': 'nostr',
  'irc': 'irc',
  'synologychat': 'synologychat',
  'twitch': 'twitch',
  'whatsapp': 'whatsapp',
  'signal': 'signal',
  'zalo': 'zalo',
  // Plugin channels
  'wechat_personal': 'wechat_personal',
  'qq_bot': 'qq_bot',
  'imessage': 'imessage',
};

/**
 * 根据账户类型获取通知配置
 */
function getChannelConfigFromAccount(
  account: any,
  channel: string
): { webhook?: string; token?: string; secret?: string; chat_id?: string; server_url?: string; sessionData?: any; toUser?: string } | null {
  // 直接使用账户的字段
  switch (channel) {
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
    case 'email':
      return (account.token && account.chat_id)
        ? { token: account.token, chat_id: account.chat_id, fromEmail: account.webhook }
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
    
    // Plugin-based channels
    case 'wechat_personal':
    case 'whatsapp':
    case 'qq_bot':
    case 'signal':
      return (account.session_data || account.token)
        ? { 
            sessionData: account.session_data || account.token,
            toUser: account.chat_id 
          }
        : null;
    
    default:
      return null;
  }
}

/**
 * 应用关系映射转换事件名称
 */
function applyRelationshipMapping(
  eventName: string,
  mappings: any[],
  recipientEmail?: string,
  recipientType?: string
): string {
  if (!mappings || mappings.length === 0) {
    return eventName;
  }

  // 优先通过收件人类型匹配
  if (recipientType) {
    const typeMapping = mappings.find(m => m.recipient_type === recipientType);
    if (typeMapping) {
      return eventName.replace(typeMapping.from_relation, typeMapping.to_relation);
    }
  }

  // 其次通过收件人邮箱匹配
  if (recipientEmail) {
    const emailMapping = mappings.find(m => m.recipient_email === recipientEmail);
    if (emailMapping) {
      return eventName.replace(emailMapping.from_relation, emailMapping.to_relation);
    }
  }

  // 最后尝试模糊匹配
  for (const mapping of mappings) {
    if (eventName.includes(mapping.from_relation)) {
      return eventName.replace(mapping.from_relation, mapping.to_relation);
    }
  }

  return eventName;
}

export async function sendNotifications(event: any, userId: number, channels: string[]): Promise<void> {
  const config = await getUserConfig(userId);
  const channelWebhooks = config?.channel_webhooks || {};
  
  // 获取关系映射
  const mappings = await getRelationshipMappings(userId, event.id);
  
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
  
  // 构建账户ID到账户的映射
  const accountsMap = new Map<number, any>();
  for (const account of allAccounts) {
    accountsMap.set(account.id, account);
  }
  
  // 为每个渠道准备配置（优先使用绑定的账户，否则使用全局配置）
  const channelConfigs: Record<string, any> = {};
  
  for (const ch of channels) {
    // 查找该渠道绑定的账户
    let accountConfig: any = null;
    
    if (boundAccountIds.length > 0) {
      // 找到第一个匹配渠道类型的已绑定账户
      const accountType = channelToAccountType[ch];
      for (const accountId of boundAccountIds) {
        const account = accountsMap.get(accountId);
        if (account && account.type === accountType && account.is_active) {
          accountConfig = getChannelConfigFromAccount(account, ch);
          if (accountConfig) break;
        }
      }
    }
    
    // 如果找到了账户配置，使用它；否则使用全局配置
    if (accountConfig) {
      channelConfigs[ch] = accountConfig;
    } else {
      // 使用全局配置
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
          if (config?.wxpusher_app_token && config?.wxpusher_uid) {
            globalConfig.token = config.wxpusher_app_token;
            globalConfig.chat_id = config.wxpusher_uid;
          }
          break;
        case 'qq':
          if (config?.qmsg_key) {
            globalConfig.token = config.qmsg_key;
            globalConfig.chat_id = config.qmsg_qq;
          }
          break;
        case 'email':
          if (config?.resend_api_key && config?.reminder_emails?.length > 0) {
            globalConfig.apiKey = config.resend_api_key;
            globalConfig.emails = config.reminder_emails;
          }
          break;
        default:
          if (genericWebhookChannels.has(ch) && channelWebhooks[ch]) {
            globalConfig.webhook = channelWebhooks[ch];
          }
      }
      
      if (Object.keys(globalConfig).length > 0) {
        channelConfigs[ch] = globalConfig;
      }
    }
  }
  
  // 发送通知
  await Promise.allSettled(channels.map(async (ch) => {
    const chConfig = channelConfigs[ch];
    if (!chConfig) return;
    
    try {
      if (ch === 'feishu' && chConfig.webhook) await sendFeishuNotification(event, chConfig.webhook);
      else if (ch === 'wecom' && chConfig.webhook) await sendWeComNotification(event, chConfig.webhook);
      else if (ch === 'dingtalk' && chConfig.webhook && chConfig.secret)
        await sendDingTalkNotification(event, chConfig.webhook, chConfig.secret);
      else if (ch === 'telegram' && chConfig.token && chConfig.chat_id)
        await sendTelegramNotification(event, chConfig.token, chConfig.chat_id);
      else if (ch === 'discord' && chConfig.webhook)
        await sendDiscordNotification(event, chConfig.webhook);
      else if (ch === 'slack' && chConfig.webhook)
        await sendSlackNotification(event, chConfig.webhook);
      else if (ch === 'wechat' && chConfig.token && chConfig.chat_id)
        await sendWxPusherNotification(event, chConfig.token, chConfig.chat_id);
      else if (ch === 'qq' && chConfig.token)
        await sendQmsgNotification(event, chConfig.token, chConfig.chat_id);
      else if (ch === 'email' && chConfig.token && chConfig.chat_id && chConfig.fromEmail) {
        // 使用账户配置发送邮件
        await sendEmailNotification(
          event,
          chConfig.token,  // API Key (token字段)
          chConfig.fromEmail,  // 发件人邮箱 (webhook字段)
          chConfig.chat_id  // 收件人邮箱 (chat_id字段)
        );
      }
      else if (ch === 'email' && chConfig.apiKey && chConfig.emails?.length > 0) {
        // 为每个收件人单独发送邮件，应用不同的关系映射
        await Promise.allSettled(chConfig.emails.map(async (email: string) => {
          const mappedEvent = {
            ...event,
            name: applyRelationshipMapping(event.name, mappings, email)
          };
          await sendEmailNotification(
            mappedEvent,
            chConfig.apiKey,
            'TimeMark <noreply@timemark.app>',
            email
          );
        }));
      }
      else if (genericWebhookChannels.has(ch) && chConfig.webhook)
        await sendGenericWebhookNotification(event, chConfig.webhook, ch);
      // Plugin-based channels
      else if (ch === 'wechat_personal' && chConfig.sessionData) {
        const toUser = chConfig.toUser || event.personName || 'me';
        await sendWechatNotification(event, chConfig.sessionData, toUser);
      }
      else if (ch === 'whatsapp' && chConfig.sessionData) {
        const toUser = chConfig.toUser || event.personName || '';
        await sendWhatsappNotification(event, chConfig.sessionData, toUser);
      }
      else if (ch === 'qq_bot' && chConfig.sessionData) {
        const toUser = chConfig.toUser || event.personName || '';
        await sendQQNotification(event, chConfig.sessionData, toUser);
      }
      else if (ch === 'signal' && chConfig.sessionData) {
        const toUser = chConfig.toUser || event.personName || '';
        await sendSignalNotification(event, chConfig.sessionData, toUser);
      }
      else if (ch === 'zalo' && chConfig.sessionData) {
        const toUser = chConfig.toUser || event.personName || '';
        await sendZaloNotification(event, chConfig.sessionData, toUser);
      }
      else if (ch === 'imessage' && chConfig.sessionData) {
        const toUser = chConfig.toUser || event.personName || '';
        await sendBlueBubblesNotification(event, chConfig.sessionData, toUser);
      }
    } catch (e) {
      console.error(`Failed ${ch}:`, e);
    }
  }));
}
