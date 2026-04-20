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
import { applyRelationshipMapping } from '@timemark/shared/relationship';

// 通用 Webhook 渠道（通过配置文件中的 channel_webhooks 字段配置）
const genericWebhookChannels = new Set([
  'whatsapp',
  'signal',
  'imessage',
  'bluebubbles',
  'zalo',
  'zalo_personal',
  'network_chat',
  'nostr',
  'irc',
  'synologychat',
  'twitch',
  'matrix',
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
  'nextcloud_talk': 'nextcloud_talk',
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
): { webhook?: string; token?: string; secret?: string; chat_id?: string; server_url?: string; sessionData?: any; toUser?: string; email?: string } | null {
  // 直接使用账户的字段
  switch (channel) {
    // Email channel
    case 'email':
      return { email: account.chat_id || account.name };
    
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

export async function sendNotifications(event: any, userId: number, channels: string[]): Promise<void> {
  const config = await getUserConfig(userId);
  const channelWebhooks = config?.channel_webhooks || {};
  
  // 获取关系映射
  const mappings = await getRelationshipMappings(userId, event.id);
  // Apply default relationship mapping for all channels
  const defaultMappedName = applyRelationshipMapping(event.name, mappings);
  const mappedEvent = { ...event, name: defaultMappedName };
  
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
    }
    
    // 如果没有绑定的账户配置，使用全局配置
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
          if (config?.resend_api_key) {
            globalConfig.apiKey = config.resend_api_key;
            // Get email addresses from notification_accounts
            const emailAccounts = allAccounts.filter(a => a.type === 'email' && a.is_active);
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
  await Promise.allSettled(channels.flatMap((ch) => {
    const configs = channelConfigsMap[ch];
    if (!configs || configs.length === 0) return [];
    
    return configs.map(async (chConfig) => {
      try {
        if (ch === 'feishu' && chConfig.webhook) await sendFeishuNotification(mappedEvent, chConfig.webhook);
        else if (ch === 'wecom' && chConfig.webhook) await sendWeComNotification(mappedEvent, chConfig.webhook);
        else if (ch === 'dingtalk' && chConfig.webhook && chConfig.secret)
          await sendDingTalkNotification(mappedEvent, chConfig.webhook, chConfig.secret);
        else if (ch === 'telegram' && chConfig.token && chConfig.chat_id)
          await sendTelegramNotification(mappedEvent, chConfig.token, chConfig.chat_id);
        else if (ch === 'discord' && chConfig.webhook)
          await sendDiscordNotification(mappedEvent, chConfig.webhook);
        else if (ch === 'slack' && chConfig.webhook)
          await sendSlackNotification(mappedEvent, chConfig.webhook);
        else if (ch === 'wechat' && chConfig.token && chConfig.chat_id)
          await sendWxPusherNotification(mappedEvent, chConfig.token, chConfig.chat_id);
        else if (ch === 'qq' && chConfig.token)
          await sendQmsgNotification(mappedEvent, chConfig.token, chConfig.chat_id);
        else if (ch === 'email' && chConfig.apiKey && chConfig.emails?.length > 0) {
          // 为每个收件人单独发送邮件，应用不同的关系映射（per-recipient）
          await Promise.allSettled(chConfig.emails.map(async (email: string) => {
            const emailMappedEvent = {
              ...event,
              name: applyRelationshipMapping(event.name, mappings, email)
            };
            await sendEmailNotification(
              emailMappedEvent,
              chConfig.apiKey,
              'TimeMark <noreply@timemark.app>',
              email
            );
          }));
        }
        else if (genericWebhookChannels.has(ch) && chConfig.webhook)
          await sendGenericWebhookNotification(mappedEvent, chConfig.webhook, ch);
        // Token-based channels with dedicated APIs
        else if (ch === 'nextcloud_talk' && chConfig.server_url && chConfig.token && chConfig.chat_id)
          await sendNextcloudTalkNotification(mappedEvent, chConfig.server_url, chConfig.token, chConfig.chat_id);
        else if (ch === 'mattermost' && chConfig.server_url && chConfig.token && chConfig.chat_id)
          await sendMattermostNotification(mappedEvent, chConfig.server_url, chConfig.token, chConfig.chat_id);
        // Matrix channel (token-based with homeserver URL)
        else if (ch === 'matrix' && chConfig.server_url && chConfig.token && chConfig.chat_id)
          await sendMatrixNotification(mappedEvent, chConfig.server_url, chConfig.token, chConfig.chat_id);
        // Plugin-based channels
        else if (ch === 'wechat_personal' && chConfig.sessionData) {
          const toUser = chConfig.toUser || mappedEvent.personName || 'me';
          await sendWechatNotification(mappedEvent, chConfig.sessionData, toUser);
        }
        else if (ch === 'whatsapp' && chConfig.sessionData) {
          const toUser = chConfig.toUser || mappedEvent.personName || '';
          await sendWhatsappNotification(mappedEvent, chConfig.sessionData, toUser);
        }
        else if (ch === 'qq_bot' && chConfig.sessionData) {
          const toUser = chConfig.toUser || mappedEvent.personName || '';
          await sendQQNotification(mappedEvent, chConfig.sessionData, toUser);
        }
        else if (ch === 'signal' && chConfig.sessionData) {
          const toUser = chConfig.toUser || mappedEvent.personName || '';
          await sendSignalNotification(mappedEvent, chConfig.sessionData, toUser);
        }
        else if (ch === 'zalo' && chConfig.sessionData) {
          const toUser = chConfig.toUser || mappedEvent.personName || '';
          await sendZaloNotification(mappedEvent, chConfig.sessionData, toUser);
        }
        else if (ch === 'imessage' && chConfig.sessionData) {
          const toUser = chConfig.toUser || mappedEvent.personName || '';
          await sendBlueBubblesNotification(mappedEvent, chConfig.sessionData, toUser);
        }
      } catch (e) {
        console.error(`Failed ${ch}:`, e);
      }
    });
  }));
}
