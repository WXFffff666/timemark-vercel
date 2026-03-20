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
    // TODO: 集成 Resend API 发送邮件
    // await resend.emails.send({
    //   from: 'security@timemark.app',
    //   to: params.adminEmails,
    //   subject: `Security Alert: Multiple failed login attempts for ${params.username}`,
    //   html: `...`
    // });
  } catch (error) {
    console.error('[sendSecurityAlert] Failed to send alert:', error);
  }
}
