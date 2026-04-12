import { sendSecurityAlertEmail } from './notifications/email.service.js';
import { getUserConfig } from './config.service.js';
import { sendNotifications } from './notifications/index.js';

export type AlertType = 'login_failure' | 'new_device' | 'password_change';

export async function sendSecurityAlert(params: {
  userId?: number;
  adminEmails: string[];
  username: string;
  ip: string;
  userAgent: string;
  failureCount: number;
  locked: boolean;
  alertType?: AlertType;
}): Promise<void> {
  try {
    console.log('[Security Alert]', params.alertType || 'login_failure', {
      username: params.username,
      ip: params.ip,
      failureCount: params.failureCount,
      locked: params.locked
    });

    let channels: string[] = ['email'];
    let userId = params.userId;

    if (userId) {
      const config = await getUserConfig(userId);
      if (config?.alert_channels && config.alert_channels.length > 0) {
        channels = config.alert_channels;
      }
    }

    const alertContent = buildAlertContent(params);

    if (channels.includes('email') && process.env.RESEND_API_KEY && params.adminEmails.length > 0) {
      await sendSecurityAlertEmail(
        {
          adminEmails: params.adminEmails,
          username: params.username,
          ip: params.ip,
          userAgent: params.userAgent,
          failureCount: params.failureCount,
          locked: params.locked,
          alertType: params.alertType
        },
        process.env.RESEND_API_KEY,
        'TimeMark Security <security@timemark.app>'
      );
      console.log('[Security Alert] Email notification sent');
    }

    if (userId && channels.length > 0 && !channels.includes('email')) {
      await sendAlertToChannels(userId, channels, alertContent);
    }
  } catch (error) {
    console.error('[sendSecurityAlert] Failed to send alert:', error);
  }
}

function buildAlertContent(params: {
  username: string;
  ip: string;
  userAgent: string;
  failureCount: number;
  locked: boolean;
  alertType?: AlertType;
}): any {
  const typeLabels: Record<string, string> = {
    login_failure: '登录失败告警',
    new_device: '新设备登录告警',
    password_change: '密码修改告警'
  };

  const title = typeLabels[params.alertType || 'login_failure'];
  const alertEvent = {
    id: 0,
    name: `🔔 ${title}`,
    event_date: new Date().toISOString().split('T')[0],
    event_type: 'other',
    calendar_type: 'gregorian',
    reminder_times: [],
    notification_account_ids: [],
    personName: params.username,
    customMessage: `用户名: ${params.username}\nIP: ${params.ip}\nUser-Agent: ${params.userAgent}\n失败次数: ${params.failureCount}\n账户锁定: ${params.locked ? '是' : '否'}`
  };

  return alertEvent;
}

async function sendAlertToChannels(userId: number, channels: string[], alertContent: any): Promise<void> {
  const userConfig = await getUserConfig(userId);
  if (!userConfig) return;

  await Promise.allSettled(channels.map(async (ch) => {
    if (ch === 'email') return;

    try {
      let config: any = null;

      switch (ch) {
        case 'feishu':
          if (userConfig.feishu_webhook) config = { webhook: userConfig.feishu_webhook };
          break;
        case 'wecom':
          if (userConfig.wecom_webhook) config = { webhook: userConfig.wecom_webhook };
          break;
        case 'dingtalk':
          if (userConfig.dingtalk_webhook) {
            config = { webhook: userConfig.dingtalk_webhook };
            if (userConfig.dingtalk_secret) config.secret = userConfig.dingtalk_secret;
          }
          break;
        case 'telegram':
          if (userConfig.telegram_bot_token && userConfig.telegram_chat_id) {
            config = { token: userConfig.telegram_bot_token, chat_id: userConfig.telegram_chat_id };
          }
          break;
        case 'discord':
          if (userConfig.discord_webhook) config = { webhook: userConfig.discord_webhook };
          break;
        case 'slack':
          if (userConfig.slack_webhook) config = { webhook: userConfig.slack_webhook };
          break;
        case 'wechat':
          if (userConfig.wxpusher_app_token && userConfig.wxpusher_uid) {
            config = { token: userConfig.wxpusher_app_token, chat_id: userConfig.wxpusher_uid };
          }
          break;
        case 'qq':
          if (userConfig.qmsg_key) {
            config = { token: userConfig.qmsg_key, chat_id: userConfig.qmsg_qq };
          }
          break;
      }

      if (!config) return;

      const { sendFeishuNotification } = await import('./notifications/feishu.service.js');
      const { sendWeComNotification } = await import('./notifications/wecom.service.js');
      const { sendDingTalkNotification } = await import('./notifications/dingtalk.service.js');
      const { sendTelegramNotification } = await import('./notifications/telegram.service.js');
      const { sendDiscordNotification } = await import('./notifications/discord.service.js');
      const { sendSlackNotification } = await import('./notifications/slack.service.js');
      const { sendWxPusherNotification } = await import('./notifications/wxpusher.service.js');
      const { sendQmsgNotification } = await import('./notifications/qmsg.service.js');

      if (ch === 'feishu' && config.webhook) await sendFeishuNotification(alertContent, config.webhook);
      else if (ch === 'wecom' && config.webhook) await sendWeComNotification(alertContent, config.webhook);
      else if (ch === 'dingtalk' && config.webhook && config.secret)
        await sendDingTalkNotification(alertContent, config.webhook, config.secret);
      else if (ch === 'telegram' && config.token && config.chat_id)
        await sendTelegramNotification(alertContent, config.token, config.chat_id);
      else if (ch === 'discord' && config.webhook)
        await sendDiscordNotification(alertContent, config.webhook);
      else if (ch === 'slack' && config.webhook)
        await sendSlackNotification(alertContent, config.webhook);
      else if (ch === 'wechat' && config.token && config.chat_id)
        await sendWxPusherNotification(alertContent, config.token, config.chat_id);
      else if (ch === 'qq' && config.token)
        await sendQmsgNotification(alertContent, config.token, config.chat_id);

      console.log(`[Security Alert] ${ch} notification sent`);
    } catch (e) {
      console.error(`[Security Alert] Failed to send to ${ch}:`, e);
    }
  }));
}