import { sendSecurityAlertEmail } from './notifications/email.service.js';

export async function sendSecurityAlert(params: {
  adminEmails: string[];
  username: string;
  ip: string;
  userAgent: string;
  failureCount: number;
  locked: boolean;
  // 可选：指定发送渠道ID列表
  channelAccounts?: number[];
}): Promise<void> {
  try {
    console.log('[Security Alert] Multiple failed login attempts:', {
      username: params.username,
      ip: params.ip,
      failureCount: params.failureCount,
      locked: params.locked,
      channels: params.channelAccounts
    });

    // 1. 发送邮件告警（默认）
    if (process.env.RESEND_API_KEY && params.adminEmails.length > 0) {
      await sendSecurityAlertEmail(
        {
          adminEmails: params.adminEmails,
          username: params.username,
          ip: params.ip,
          userAgent: params.userAgent,
          failureCount: params.failureCount,
          locked: params.locked
        },
        process.env.RESEND_API_KEY,
        'TimeMark Security <security@timemark.app>'
      );
      console.log('[Security Alert] Email notification sent successfully');
    } else {
      console.warn('[Security Alert] Email not sent: RESEND_API_KEY not configured or no admin emails');
    }

    // 2. 如果指定了渠道账户，发送到对应通知渠道
    if (params.channelAccounts && params.channelAccounts.length > 0) {
      const { sendNotificationsToChannel } = await import('./notifications/index.js');
      await sendNotificationsToChannel({
        id: 0,
        user_id: 0,
        name: 'Security Alert',
        date: new Date().toISOString().split('T')[0],
        type: 'other',
        calendar_type: 'gregorian',
        reminder_config: null,
        reminder_emails: null,
        reminder_template: null,
        reminder_time: '09:00',
        reminder_days_before: null,
        notification_channels: [],
        notification_account_ids: params.channelAccounts,
        relationship_mapping_id: null,
        created_at: new Date().toISOString()
      }, {
        username: params.username,
        ip: params.ip,
        failureCount: params.failureCount,
        locked: params.locked
      });
      console.log('[Security Alert] Channel notifications sent to:', params.channelAccounts);
    }
  } catch (error) {
    console.error('[sendSecurityAlert] Failed to send alert:', error);
  }
}
