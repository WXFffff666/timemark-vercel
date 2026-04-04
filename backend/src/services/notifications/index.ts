import { sendFeishuNotification } from './feishu.service';
import { sendWeComNotification } from './wecom.service';
import { sendDingTalkNotification } from './dingtalk.service';
import { sendTelegramNotification } from './telegram.service';
import { sendDiscordNotification } from './discord.service';
import { sendSlackNotification } from './slack.service';
import { sendWxPusherNotification } from './wxpusher.service';
import { sendQmsgNotification } from './qmsg.service';
import { sendGenericWebhookNotification } from './generic-webhook.service';
import { sendEmailNotification } from './email.service';
import { getUserConfig, getRelationshipMappings } from '../config.service';

const genericWebhookChannels = new Set([
  'whatsapp',
  'google_chat',
  'signal',
  'imessage',
  'bluebubbles',
  'irc',
  'microsoft_teams',
  'matrix',
  'line',
  'mattermost',
  'nextcloud_talk',
  'nostr',
  'synology_chat',
  'tlon',
  'twitch',
  'zalo',
  'zalo_personal',
  'network_chat',
]);

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

  await Promise.allSettled(channels.map(async (ch) => {
    try {
      if (ch === 'feishu' && config?.feishu_webhook) await sendFeishuNotification(event, config.feishu_webhook);
      else if (ch === 'wecom' && config?.wecom_webhook) await sendWeComNotification(event, config.wecom_webhook);
      else if (ch === 'dingtalk' && config?.dingtalk_webhook && config?.dingtalk_secret)
        await sendDingTalkNotification(event, config.dingtalk_webhook, config.dingtalk_secret);
      else if (ch === 'telegram' && config?.telegram_bot_token && config?.telegram_chat_id)
        await sendTelegramNotification(event, config.telegram_bot_token, config.telegram_chat_id);
      else if (ch === 'discord' && config?.discord_webhook)
        await sendDiscordNotification(event, config.discord_webhook);
      else if (ch === 'slack' && config?.slack_webhook)
        await sendSlackNotification(event, config.slack_webhook);
      else if (ch === 'wechat' && config?.wxpusher_app_token && config?.wxpusher_uid)
        await sendWxPusherNotification(event, config.wxpusher_app_token, config.wxpusher_uid);
      else if (ch === 'qq' && config?.qmsg_key)
        await sendQmsgNotification(event, config.qmsg_key, config.qmsg_qq);
      else if (ch === 'email' && config?.resend_api_key && config?.reminder_emails?.length > 0) {
        // 为每个收件人单独发送邮件，应用不同的关系映射
        await Promise.allSettled(config.reminder_emails.map(async (email: string) => {
          const mappedEvent = {
            ...event,
            name: applyRelationshipMapping(event.name, mappings, email)
          };
          await sendEmailNotification(
            mappedEvent,
            config.resend_api_key,
            'TimeMark <noreply@timemark.app>',
            email
          );
        }));
      }
      else if (genericWebhookChannels.has(ch) && typeof channelWebhooks[ch] === 'string' && channelWebhooks[ch])
        await sendGenericWebhookNotification(event, channelWebhooks[ch], ch);
    } catch (e) {
      console.error(`Failed ${ch}:`, e);
    }
  }));
}
