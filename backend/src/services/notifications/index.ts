import { sendFeishuNotification } from './feishu.service';
import { sendWeComNotification } from './wecom.service';
import { sendDingTalkNotification } from './dingtalk.service';
import { sendTelegramNotification } from './telegram.service';
import { sendDiscordNotification } from './discord.service';
import { sendSlackNotification } from './slack.service';
import { sendWxPusherNotification } from './wxpusher.service';
import { sendQmsgNotification } from './qmsg.service';
import { sendGenericWebhookNotification } from './generic-webhook.service';
import { getUserConfig } from '../config.service';

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

export async function sendNotifications(event: any, userId: number, channels: string[]): Promise<void> {
  const config = await getUserConfig(userId);
  const channelWebhooks = config?.channel_webhooks || {};

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
      else if (genericWebhookChannels.has(ch) && typeof channelWebhooks[ch] === 'string' && channelWebhooks[ch])
        await sendGenericWebhookNotification(event, channelWebhooks[ch], ch);
    } catch (e) {
      console.error(`Failed ${ch}:`, e);
    }
  }));
}
