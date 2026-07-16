import type { ReminderConfig } from '@timemark/shared';
import { normalizeEmail } from '@timemark/shared';

export interface FixedContactForEvent {
  id: number;
  name: string;
  nickname?: string;
  email?: string;
  phone?: string;
  telegram_chat_id?: string;
  qq?: string;
  wxpusher_uid?: string;
  channel_account_ids?: number[];
}

/** 通知账号 type → 事件表单 channel value */
export const ACCOUNT_TYPE_TO_CHANNEL: Record<string, string> = {
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
  nextcloudtalk: 'nextcloud_talk',
  wxpusher: 'wxpusher',
  qmsg: 'qmsg',
  serverchan: 'serverchan',
  pushplus: 'pushplus',
  bark: 'bark',
  gotify: 'gotify',
  meow: 'meow',
  pushme: 'pushme',
  pushdeer: 'pushdeer',
  wecomapp: 'wecomapp',
  ntfy: 'ntfy',
  pushover: 'pushover',
  apprise: 'apprise',
};

export function mergeContactIntoReminderConfig(
  contact: FixedContactForEvent,
  accounts: Array<{ id: string | number; type: string }>,
  existing: ReminderConfig,
): ReminderConfig {
  const emailRecipients = [...(existing.emailRecipients || [])];
  const normalized = normalizeEmail(contact.email);
  if (normalized && !emailRecipients.includes(normalized)) {
    emailRecipients.push(normalized);
  }

  const channels = new Set(existing.channels || []);
  const accountIds = new Set((existing.accountIds || []).map(String));

  for (const id of contact.channel_account_ids || []) {
    const acc = accounts.find((a) => Number(a.id) === id);
    if (!acc) continue;
    const ch = ACCOUNT_TYPE_TO_CHANNEL[acc.type] || acc.type;
    channels.add(ch);
    accountIds.add(String(acc.id));
  }

  return {
    ...existing,
    emailRecipients,
    channels: [...channels],
    accountIds: [...accountIds],
  };
}

export function applyContactAsPerson(
  contact: FixedContactForEvent,
  prev: { personName?: string; name?: string; type?: string },
): Partial<{ personName: string; name: string }> {
  const displayName = contact.nickname || contact.name;
  const updates: Partial<{ personName: string; name: string }> = {
    personName: displayName,
  };
  if (!prev.name?.trim() && prev.type === 'birthday') {
    updates.name = `${contact.name} 生日`;
  }
  return updates;
}

export function applyContactsAsReminders(
  contacts: FixedContactForEvent[],
  accounts: Array<{ id: string | number; type: string }>,
  existingConfig: ReminderConfig,
  prev: { reminderRecipientName?: string },
): {
  reminderRecipientName: string;
  reminderRecipientEmail?: string;
  reminderConfig: ReminderConfig;
} {
  let config = { ...existingConfig };
  const names: string[] = [];
  for (const c of contacts) {
    names.push(c.nickname || c.name);
    config = mergeContactIntoReminderConfig(c, accounts, config);
  }
  const firstEmail = contacts.map((c) => normalizeEmail(c.email)).find(Boolean);
  return {
    reminderRecipientName: names.join('、') || prev.reminderRecipientName || '',
    reminderRecipientEmail: firstEmail || undefined,
    reminderConfig: config,
  };
}

export function applyContactAsReminder(
  contact: FixedContactForEvent,
  accounts: Array<{ id: string | number; type: string }>,
  existingConfig: ReminderConfig,
  prev: { reminderRecipientName?: string; reminderRecipientEmail?: string },
): {
  reminderRecipientName: string;
  reminderRecipientEmail?: string;
  reminderConfig: ReminderConfig;
} {
  return applyContactsAsReminders([contact], accounts, existingConfig, prev);
}
