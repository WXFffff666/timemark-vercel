import { getContactAddressForChannel } from '@timemark/shared';
import { createLogger } from '../utils/logger.js';
import { getFixedContact, getContactChannelFields } from './contact.service.js';
import { getNotificationAccounts } from './config.service.js';
import { sendTelegramNotification } from './notifications/telegram.service.js';
import { sendWxPusherNotification } from './notifications/wxpusher.service.js';
import { sendTwilioSmsNotification } from './notifications/twilio.service.js';

/**
 * v2.27 遗留1：生日祝福多渠道投递。
 *
 * 邮件仍是主渠道（resolveBirthdayGreeting 的 send/claim 语义不变）；本模块在邮件
 * 发送成功后，把祝福的纯文本版「尽力而为」补投到联系人配置的其他渠道——
 * telegram（chat_id）/ wxpusher（uid）/ twilio 短信（phone）。前提是用户在
 * notification_accounts 里有对应类型的启用账户；没有账户或联系人没有对应地址
 * 的渠道直接跳过，绝不让补投失败拖垮主投递结果。
 */

const log = createLogger('greeting.channel-delivery');

export type GreetingExtraChannel = 'telegram' | 'wxpusher' | 'twilio';

const EXTRA_CHANNEL_TYPES: readonly GreetingExtraChannel[] = ['telegram', 'wxpusher', 'twilio'];

export interface GreetingChannelDeliveryResult {
  channel: GreetingExtraChannel;
  address: string;
  ok: boolean;
  error?: string;
}

/** HTML 祝福正文 → 各渠道纯文本（渠道消息不支持 HTML）。 */
export function greetingHtmlToText(html: string, subject: string): string {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return subject ? `${subject}\n\n${text}` : text;
}

/**
 * 把祝福文本补投到联系人的全部可用渠道。逐渠道独立 try/catch——
 * 一个渠道失败不影响其他渠道，也不向调用方抛出。
 */
export async function deliverGreetingToExtraChannels(
  userId: number,
  contactId: number,
  text: string,
): Promise<GreetingChannelDeliveryResult[]> {
  const results: GreetingChannelDeliveryResult[] = [];
  if (!text.trim()) return results;

  let contact;
  try {
    contact = await getFixedContact(userId, contactId);
  } catch {
    return results;
  }
  if (!contact) return results;

  const channelFields = getContactChannelFields(contact);
  const accounts = (await getNotificationAccounts(userId).catch(() => []))
    .filter((a) => a.is_active !== false);

  for (const type of EXTRA_CHANNEL_TYPES) {
    const account = accounts.find((a) => a.type === type);
    if (!account) continue;
    const address = getContactAddressForChannel(type, channelFields);
    if (!address) continue;

    try {
      if (type === 'telegram') {
        await sendTelegramNotification({ customMessage: text }, account.token ?? '', address);
      } else if (type === 'wxpusher') {
        await sendWxPusherNotification({ customMessage: text }, account.token ?? '', address);
      } else {
        // twilio 配置映射（与 notifications/index.ts 相同）：token=SID、secret=AuthToken、
        // webhook=发信号码；收件号用联系人自己的手机号而不是账户 chat_id。
        await sendTwilioSmsNotification(
          { type: 'birthday', name: '生日祝福', customMessage: text },
          account.token ?? '',
          account.secret ?? '',
          account.webhook ?? '',
          address,
        );
      }
      results.push({ channel: type, address, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ channel: type, address, ok: false, error: message });
      log.warn(
        { event: 'greeting.extra_channel_failed', userId, contactId, channel: type, err: error },
        '祝福补投渠道失败（不影响主投递）',
      );
    }
  }
  return results;
}
