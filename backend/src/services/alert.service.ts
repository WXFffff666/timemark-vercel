import { sendSecurityAlertEmail } from './notifications/email.service.js';

export async function sendSecurityAlert(params: {
  adminEmails: string[];
  username: string;
  ip: string;
  userAgent: string;
  failureCount: number;
  locked: boolean;
}): Promise<void> {
  try {
    console.log('[Security Alert] Multiple failed login attempts:', {
      username: params.username,
      ip: params.ip,
      failureCount: params.failureCount,
      locked: params.locked
    });

    // 发送邮件告警
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
  } catch (error) {
    console.error('[sendSecurityAlert] Failed to send alert:', error);
  }
}
