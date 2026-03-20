import { sendFeishuNotification } from './feishu.service';
import { sendWeComNotification } from './wecom.service';
import { sendDingTalkNotification } from './dingtalk.service';
import { sendTelegramNotification } from './telegram.service';
import { getUserConfig } from '../config.service';

export async function sendNotifications(event: any, userId: number, channels: string[]): Promise<void> {
  const config = await getUserConfig(userId);
  await Promise.allSettled(channels.map(async (ch) => {
    try {
      if (ch === 'feishu' && config?.feishu_webhook) await sendFeishuNotification(event, config.feishu_webhook);
      else if (ch === 'wecom' && config?.wecom_webhook) await sendWeComNotification(event, config.wecom_webhook);
      else if (ch === 'dingtalk' && config?.dingtalk_webhook && config?.dingtalk_secret) 
        await sendDingTalkNotification(event, config.dingtalk_webhook, config.dingtalk_secret);
      else if (ch === 'telegram' && config?.telegram_bot_token && config?.telegram_chat_id) 
        await sendTelegramNotification(event, config.telegram_bot_token, config.telegram_chat_id);
    } catch (e) { console.error(`Failed ${ch}:`, e); }
  }));
}
