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
  lockMinutes?: number;
  alertType?: AlertType;
}): Promise<void> {
  try {
    console.log('[Security Alert]', params.alertType || 'login_failure', {
      username: params.username,
      ip: params.ip,
      failureCount: params.failureCount,
      locked: params.locked,
      lockMinutes: params.lockMinutes,
    });

    if (!params.userId) {
      console.log('[Security Alert] No userId — skip channel dispatch');
      return;
    }

    const config = await getUserConfig(params.userId);
    const channels: string[] = config?.alert_channels?.length ? config.alert_channels : [];
    if (channels.length === 0) {
      console.log('[Security Alert] No alert_channels configured — skip');
      return;
    }

    const accounts = await getNotificationAccounts(params.userId);
    const matchingAccounts = accounts.filter((a) => a.is_active && channels.includes(a.type));
    if (matchingAccounts.length === 0) {
      console.log('[Security Alert] No active accounts match alert_channels');
      return;
    }

    const lockInfo = params.locked
      ? `已锁定 ${params.lockMinutes ?? Math.floor(params.failureCount / 5) * 5} 分钟`
      : '未锁定';

    const alertEvent = {
      id: 0,
      name: params.locked ? '🔒 账户锁定告警' : '⚠️ 登录失败告警',
      event_date: new Date().toISOString().split('T')[0],
      event_type: 'other',
      calendar_type: 'gregorian',
      reminder_times: [],
      notification_account_ids: matchingAccounts.map((a) => a.id),
      personName: params.username,
      customMessage: [
        `用户名: ${params.username}`,
        `IP: ${params.ip}`,
        `失败次数: ${params.failureCount}`,
        `状态: ${lockInfo}`,
        `时间: ${new Date().toLocaleString('zh-CN', { timeZone: config?.timezone || 'Asia/Shanghai' })}`,
        `设备: ${params.userAgent}`,
      ].join('\n'),
    };

    await sendNotifications(alertEvent, params.userId, channels, { skipQuietHours: true });
    console.log(`[Security Alert] Dispatched to ${matchingAccounts.length} account(s) via [${channels.join(', ')}]`);
  } catch (error) {
    console.error('[sendSecurityAlert] Failed to send alert:', error);
  }
}
