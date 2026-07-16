import { query } from '../db/index.js';
import { getFixedContact } from './contact.service.js';
import { getNotificationAccounts } from './config.service.js';
import { resolveEmailAccount, sendRawEmail } from './email-send.service.js';
import {
  EMAIL_CHANNEL_TYPES,
  getContactAddressForChannel,
  parseChannelAccountIds,
} from '@timemark/shared';
import type { ContactSendEmailInput } from '@timemark/shared';

export async function sendContactEmail(
  userId: number,
  contactId: number,
  input: ContactSendEmailInput,
) {
  const contact = await getFixedContact(userId, contactId);
  if (!contact) throw new Error('联系人不存在');
  if (!contact.email) throw new Error('该联系人未配置邮箱地址');

  const boundIds = parseChannelAccountIds(contact.channel_account_ids ?? contact.preferred_channels);
  const accounts = await getNotificationAccounts(userId);
  const activeAccounts = accounts.filter((a) => a.is_active !== false);

  let accountId = input.accountId;
  if (!accountId && boundIds.length > 0) {
    const emailBound = boundIds.find((id) => {
      const acc = activeAccounts.find((a) => Number(a.id) === id);
      return acc && EMAIL_CHANNEL_TYPES.has(acc.type);
    });
    if (emailBound) accountId = emailBound;
  }

  const creds = await resolveEmailAccount(userId, accountId);
  const account = activeAccounts.find((a) => Number(a.id) === creds.id);
  if (account && !getContactAddressForChannel(account.type, {
    email: contact.email,
    phone: contact.phone,
    telegramChatId: contact.telegram_chat_id,
    qq: contact.qq,
    wxpusherUid: contact.wxpusher_uid,
  })) {
    throw new Error(`联系人缺少 ${account.type} 渠道所需的联系方式`);
  }

  await sendRawEmail(creds, String(contact.email), input.subject, input.html);

  await query(
    `INSERT INTO email_logs (recipient, status, subject) VALUES ($1, 'sent', $2)`,
    [contact.email, input.subject],
  ).catch(() => {});

  return {
    contactId,
    accountId: creds.id,
    accountName: creds.name,
    recipient: contact.email,
  };
}
