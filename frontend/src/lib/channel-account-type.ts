/**
 * 通知渠道 value → notification_accounts.type。
 * 必须与 backend/src/services/notifications/index.ts 的 `channelToAccountType` 对齐：
 * Wave 2 渠道（serverchan3/xizhi/anpush/chanify/pushback/simplepush/zulip/rocketchat/fcm/twilio_whatsapp）
 * 的账号类型与渠道 id 同名（identity 映射）。
 *
 * 提取为纯函数供事件表单的事件渠道选择器与联系人气道绑定共用，并可直接单测
 * （原先内联在 EventForm.tsx 里，新增渠道漏配会导致按钮永远灰掉）。
 */
export const CHANNEL_TO_ACCOUNT_TYPE: Record<string, string> = {
  email: 'email',
  resend: 'resend',
  smtp: 'smtp',
  feishu: 'feishu',
  wecom: 'wecom',
  dingtalk: 'dingtalk',
  telegram: 'telegram',
  discord: 'discord',
  slack: 'slack',
  googlechat: 'googlechat',
  irc: 'irc',
  synologychat: 'synologychat',
  twitch: 'twitch',
  line: 'line',
  matrix: 'matrix',
  mattermost: 'mattermost',
  msteams: 'msteams',
  nextcloud_talk: 'nextcloudtalk',
  qmsg: 'qmsg',
  wxpusher: 'wxpusher',
  serverchan: 'serverchan',
  pushplus: 'pushplus',
  bark: 'bark',
  gotify: 'gotify',
  meow: 'meow',
  pushme: 'pushme',
  wecomapp: 'wecomapp',
  ntfy: 'ntfy',
  pushover: 'pushover',
  apprise: 'apprise',
  // Wave 2 channels (checkboxes 15-22)
  serverchan3: 'serverchan3',
  xizhi: 'xizhi',
  anpush: 'anpush',
  chanify: 'chanify',
  pushback: 'pushback',
  simplepush: 'simplepush',
  zulip: 'zulip',
  rocketchat: 'rocketchat',
  fcm: 'fcm',
  twilio_whatsapp: 'twilio_whatsapp',
};

export function channelToAccountTypeFor(channelId: string): string | undefined {
  return CHANNEL_TO_ACCOUNT_TYPE[channelId];
}
