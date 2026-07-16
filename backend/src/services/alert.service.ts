import { getUserConfig, getNotificationAccounts } from './config.service.js';
import { sendNotifications } from './notifications/index.js';
import { resolveEmailAccount, sendRawEmail } from './email-send.service.js';
import { sendSecurityAlertEmail } from './notifications/email.service.js';
import { EMAIL_CHANNEL_TYPES, parseChannelAccountIds } from '@timemark/shared';

export type AlertType = 'login_failure' | 'new_device' | 'password_change';

function buildAlertHtml(params: {
  username: string;
  ip: string;
  userAgent: string;
  failureCount: number;
  locked: boolean;
  lockMinutes?: number;
  timezone?: string;
}): { subject: string; body: string } {
  const lockInfo = params.locked
    ? `已锁定 ${params.lockMinutes ?? Math.floor(params.failureCount / 5) * 5} 分钟`
    : '未锁定';
  const subject = params.locked ? '🔒 账户锁定告警' : '⚠️ 登录失败告警';
  const body = [
    `用户名: ${params.username}`,
    `IP: ${params.ip}`,
    `失败次数: ${params.failureCount}`,
    `状态: ${lockInfo}`,
    `时间: ${new Date().toLocaleString('zh-CN', { timeZone: params.timezone || 'Asia/Shanghai' })}`,
    `设备: ${params.userAgent}`,
  ].join('\n');
  return { subject, body };
}

export async function sendSecurityAlert(params: {
  userId?: number;
  adminEmails: string[];
  username: string;
  ip: string;
  userAgent: string;
  failureCount: number;
  locked: boolean;
  lockMinutes?: number;
  alertType?: AlertType;
}): Promise<void> {
  try {
    if (!params.userId) {
      console.log('[Security Alert] No userId — skip');
      return;
    }

    const config = await getUserConfig(params.userId);
    const alertEmails: string[] = Array.isArray(config?.alert_emails) ? config.alert_emails : [];
    const alertAccountIds = parseChannelAccountIds(config?.alert_account_ids);
    const legacyChannels: string[] = Array.isArray(config?.alert_channels) ? config.alert_channels : [];

    if (alertEmails.length === 0 && alertAccountIds.length === 0 && legacyChannels.length === 0) {
      console.log('[Security Alert] No alert recipients configured — skip');
      return;
    }

    const accounts = await getNotificationAccounts(params.userId);
    const activeAccounts = accounts.filter((a) => a.is_active);
    const { subject, body } = buildAlertHtml({
      ...params,
      timezone: config?.timezone,
    });

    let dispatched = false;

    // 1. 绑定的通知渠道账号
    if (alertAccountIds.length > 0) {
      const selected = activeAccounts.filter((a) => alertAccountIds.includes(Number(a.id)));
      if (selected.length > 0) {
        const channelTypes = [...new Set(selected.map((a) => a.type))];
        const alertEvent = {
          id: 0,
          name: subject,
          event_date: new Date().toISOString().split('T')[0],
          event_type: 'other',
          calendar_type: 'gregorian',
          reminder_times: [],
          notification_account_ids: selected.map((a) => a.id),
          personName: params.username,
          customMessage: body,
          reminderConfig: {
            emailRecipients: alertEmails,
          },
        };
        await sendNotifications(alertEvent, params.userId, channelTypes, { skipQuietHours: true });
        dispatched = true;
        console.log(`[Security Alert] Dispatched via ${selected.length} account(s)`);
      }
    }

    // 2. 独立告警邮箱（HTML 安全告警模板）
    const emailTargets = [...new Set([
      ...alertEmails,
      ...params.adminEmails.filter(Boolean),
    ])];
    if (emailTargets.length > 0) {
      try {
        const creds = await resolveEmailAccount(params.userId);
        const htmlBody = `<pre style="font-family:sans-serif;white-space:pre-wrap">${body}</pre>`;
        for (const to of emailTargets) {
          if (creds.type === 'resend' || creds.type === 'email') {
            await sendSecurityAlertEmail(
              {
                adminEmails: [to],
                username: params.username,
                ip: params.ip,
                userAgent: params.userAgent,
                failureCount: params.failureCount,
                locked: params.locked,
                alertType: params.alertType,
              },
              creds.apiKey!,
              creds.fromEmail,
            );
          } else {
            await sendRawEmail(creds, to, subject, htmlBody);
          }
        }
        dispatched = true;
        console.log(`[Security Alert] Sent to ${emailTargets.length} email(s)`);
      } catch (emailErr) {
        console.error('[Security Alert] Email dispatch failed:', emailErr);
      }
    }

    // 3. 兼容旧版：按渠道类型匹配
    if (!dispatched && legacyChannels.length > 0) {
      const matchingAccounts = activeAccounts.filter((a) => legacyChannels.includes(a.type));
      if (matchingAccounts.length > 0) {
        const alertEvent = {
          id: 0,
          name: subject,
          event_date: new Date().toISOString().split('T')[0],
          event_type: 'other',
          calendar_type: 'gregorian',
          reminder_times: [],
          notification_account_ids: matchingAccounts.map((a) => a.id),
          personName: params.username,
          customMessage: body,
        };
        await sendNotifications(alertEvent, params.userId, legacyChannels, { skipQuietHours: true });
        console.log(`[Security Alert] Legacy dispatch via [${legacyChannels.join(', ')}]`);
      }
    }
  } catch (error) {
    console.error('[sendSecurityAlert] Failed:', error);
  }
}
