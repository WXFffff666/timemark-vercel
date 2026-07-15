/**
 * Serverless 适用性评估：哪些功能需要外部 cron / 长驻进程
 */
export type SuitabilityResult = {
  suitable: boolean;
  reason?: string;
  needsExternalCron?: boolean;
};

export const SERVERLESS_NOTES: Record<string, string> = {
  wechat_personal: '需要本地微信插件会话，需常驻进程',
  whatsapp: '需要 WhatsApp Web 插件会话，需常驻进程',
  qq_bot: '需要 QQ 机器人插件，需常驻进程',
  signal: '需要 Signal CLI 本地进程',
  imessage: '需要 BlueBubbles/macOS 本地服务',
  zalo: '需要 Zalo 插件会话',
  clawbot: '需要 Clawbot 本地代理',
  nostr: '需要长连接 Nostr relay',
};

export const FEATURE_CRON_REQUIREMENTS: Record<string, { suitable: boolean; note: string }> = {
  'reminder-check': { suitable: true, note: 'Vercel Cron 或 cron-job.org 每分钟调用' },
  'calendar-sync': { suitable: true, note: '需外部 cron 每 15 分钟' },
  'caldav-sync': { suitable: true, note: '需外部 cron 每小时' },
  'lunar-phase-reminders': { suitable: true, note: '需每日 cron 检查农历初一/十五' },
  'channel-health': { suitable: true, note: '建议每日外部 cron' },
  'retry-notifications': { suitable: true, note: '每 5–15 分钟外部 cron' },
  'local-scheduler': { suitable: false, note: 'Docker 本地 scheduler；Vercel 不可用' },
  'im-plugins': { suitable: false, note: '微信/WhatsApp 等需长驻进程，不适合 serverless' },
};

export function checkChannelSuitability(channelId: string): SuitabilityResult {
  const reason = SERVERLESS_NOTES[channelId];
  if (reason) {
    return { suitable: false, reason, needsExternalCron: false };
  }
  return { suitable: true };
}

export function getServerlessFeatureReport(): Array<{ feature: string; suitable: boolean; note: string }> {
  return Object.entries(FEATURE_CRON_REQUIREMENTS).map(([feature, v]) => ({
    feature,
    suitable: v.suitable,
    note: v.note,
  }));
}
