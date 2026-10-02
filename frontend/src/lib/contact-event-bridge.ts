import type { ReminderConfig, ContactLabeledEntry } from '@timemark/shared';
import { channelForAccountType } from './channel-account-type';
import {
  normalizeEmail,
  resolveContactGreetingName,
  resolveContactPersonName,
  resolveContactDearSalutation,
} from '@timemark/shared';

export interface FixedContactForEvent {
  id: number;
  name: string;
  nickname?: string;
  relationship?: string | null;
  gender?: string | null;
  email?: string;
  phone?: string;
  telegram_chat_id?: string;
  qq?: string;
  wxpusher_uid?: string;
  channel_account_ids?: number[];
  emails?: ContactLabeledEntry[];
  phones?: ContactLabeledEntry[];
}

/**
 * 账号 type → 事件渠道 value。
 * 以前是一张手抄的整表（44 项），抄漏就让联系人的渠道绑定选不中；现在 identity 由
 * channelForAccountType 兜住，只有历史别名需要显式处理。它返回的是**规范**渠道 id，
 * 与选择器渲染的 value 一致，否则联系人勾了渠道用户在表单里看不到。
 */

function getContactEmails(contact: FixedContactForEvent): string[] {
  const set = new Set<string>();
  for (const e of contact.emails || []) {
    const n = normalizeEmail(e.value);
    if (n) set.add(n);
  }
  const legacy = normalizeEmail(contact.email);
  if (legacy) set.add(legacy);
  return [...set];
}

export function mergeContactIntoReminderConfig(
  contact: FixedContactForEvent,
  accounts: Array<{ id: string | number; type: string }>,
  existing: ReminderConfig,
): ReminderConfig {
  const emailRecipients = [...(existing.emailRecipients || [])];
  for (const email of getContactEmails(contact)) {
    if (!emailRecipients.includes(email)) {
      emailRecipients.push(email);
    }
  }

  const channels = new Set(existing.channels || []);
  const accountIds = new Set((existing.accountIds || []).map(String));

  for (const id of contact.channel_account_ids || []) {
    const acc = accounts.find((a) => Number(a.id) === id);
    if (!acc) continue;
    const ch = channelForAccountType(acc.type);
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
  prev: { personName?: string | null; name?: string; type?: string },
): Partial<{ personName: string; name: string }> {
  const personName = resolveContactPersonName(contact);
  const updates: Partial<{ personName: string; name: string }> = {
    personName,
  };
  if (!prev.name?.trim() && prev.type === 'birthday') {
    updates.name = `${personName} 生日`;
  } else if (!prev.name?.trim() && prev.type === 'anniversary') {
    updates.name = `${personName} 纪念日`;
  }
  return updates;
}

export function applyContactsAsReminders(
  contacts: FixedContactForEvent[],
  accounts: Array<{ id: string | number; type: string }>,
  existingConfig: ReminderConfig,
  prev: { reminderRecipientName?: string | null },
): {
  reminderRecipientName: string;
  reminderRecipientEmail?: string;
  reminderConfig: ReminderConfig;
} {
  let config = { ...existingConfig };
  const names: string[] = [];
  for (const c of contacts) {
    names.push(resolveContactGreetingName(c));
    config = mergeContactIntoReminderConfig(c, accounts, config);
  }
  const firstEmail = contacts.flatMap((c) => getContactEmails(c)).find(Boolean);
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

export { resolveContactGreetingName, resolveContactPersonName, resolveContactDearSalutation };
