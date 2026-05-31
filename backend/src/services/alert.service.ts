import { sendSecurityAlertEmail } from './notifications/email.service.js';
import { getUserConfig, getNotificationAccounts } from './config.service.js';
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

    let userId = params.userId;
    const alertContent = buildAlertContent(params);

    // 通过用户已配置的所有通知渠道发送告警
    if (userId) {
      const config = await getUserConfig(userId);
      const channels = config?.alert_channels && config.alert_channels.length > 0
        ? config.alert_channels
        : [];

      // 邮件渠道
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
        console.log('[Security Alert] Email sent');
      }

      // 其他渠道（飞书/企微/钉钉/Telegram等）
      const nonEmailChannels = channels.filter((ch: string) => ch !== 'email');
      if (nonEmailChannels.length > 0) {
        await sendAlertToChannels(userId, nonEmailChannels, alertContent);
      }

      // 没有配置渠道时跳过
    }

    console.log(`[Security Alert] ${params.alertType || 'login_failure'}: ${params.username} from ${params.ip}, failures: ${params.failureCount}, locked: ${params.locked}`);
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
  const accounts = await getNotificationAccounts(userId);
  if (!accounts || accounts.length === 0) return;

  // Filter accounts by type matching the channels parameter, only active ones
  const matchingAccounts = accounts.filter(a => a.is_active && channels.includes(a.type));
  if (matchingAccounts.length === 0) return;

  await Promise.allSettled(matchingAccounts.map(async (account) => {
    try {
      switch (account.type) {
        case 'feishu': {
          const { sendFeishuNotification } = await import('./notifications/feishu.service.js');
          if (account.webhook) await sendFeishuNotification(alertContent, account.webhook);
          break;
        }
        case 'wecom': {
          const { sendWeComNotification } = await import('./notifications/wecom.service.js');
          if (account.webhook) await sendWeComNotification(alertContent, account.webhook);
          break;
        }
        case 'dingtalk': {
          const { sendDingTalkNotification } = await import('./notifications/dingtalk.service.js');
          if (account.webhook && account.secret) await sendDingTalkNotification(alertContent, account.webhook, account.secret);
          break;
        }
        case 'telegram': {
          const { sendTelegramNotification } = await import('./notifications/telegram.service.js');
          if (account.token && account.chat_id) await sendTelegramNotification(alertContent, account.token, account.chat_id);
          break;
        }
        case 'discord': {
          const { sendDiscordNotification } = await import('./notifications/discord.service.js');
          if (account.webhook) await sendDiscordNotification(alertContent, account.webhook);
          break;
        }
        case 'slack': {
          const { sendSlackNotification } = await import('./notifications/slack.service.js');
          if (account.webhook) await sendSlackNotification(alertContent, account.webhook);
          break;
        }
        case 'wechat': {
          const { sendWxPusherNotification } = await import('./notifications/wxpusher.service.js');
          if (account.token && account.chat_id) await sendWxPusherNotification(alertContent, account.token, account.chat_id);
          break;
        }
        case 'qq': {
          const { sendQmsgNotification } = await import('./notifications/qmsg.service.js');
          if (account.token) await sendQmsgNotification(alertContent, account.token, account.chat_id || undefined);
          break;
        }
        case 'resend': {
          const { sendEmailNotification } = await import('./notifications/email.service.js');
          if (account.token && account.chat_id) {
            await sendEmailNotification(alertContent, account.token, account.webhook || 'onboarding@resend.dev', account.chat_id);
          }
          break;
        }
        case 'smtp': {
          const { sendSmtpNotification } = await import('./notifications/smtp.service.js');
          if (account.webhook && account.token && account.chat_id) {
            const smtpHost = account.webhook;
            const smtpPort = parseInt(account.secret || '587', 10);
            const password = account.token;
            const fromEmail = account.chat_id;
            await sendSmtpNotification(alertContent, smtpHost, smtpPort, password, fromEmail, fromEmail);
          }
          break;
        }
      }

      console.log(`[Security Alert] ${account.type} notification sent via account "${account.name}"`);
    } catch (e) {
      console.error(`[Security Alert] Failed to send to ${account.type} (${account.name}):`, e);
    }
  }));
}