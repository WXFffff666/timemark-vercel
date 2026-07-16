/** 通知渠道类型与联系人字段的对应关系 */
export const CONTACT_CHANNEL_FIELDS: Record<string, keyof ContactChannelFields> = {
  resend: 'email',
  email: 'email',
  smtp: 'email',
  telegram: 'telegramChatId',
  wxpusher: 'wxpusherUid',
  qq: 'qq',
  twilio: 'phone',
};

export interface ContactChannelFields {
  email?: string | null;
  phone?: string | null;
  telegramChatId?: string | null;
  qq?: string | null;
  wxpusherUid?: string | null;
}

export const EMAIL_CHANNEL_TYPES = new Set(['resend', 'email', 'smtp']);

export function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const v = email.trim().toLowerCase();
  return v || null;
}

export function parseChannelAccountIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
}

export function contactHasChannelAddress(
  channelType: string,
  contact: ContactChannelFields,
): boolean {
  const field = CONTACT_CHANNEL_FIELDS[channelType];
  if (!field) return true;
  const value = contact[field];
  return !!(value && String(value).trim());
}

export function getContactAddressForChannel(
  channelType: string,
  contact: ContactChannelFields,
): string | null {
  const field = CONTACT_CHANNEL_FIELDS[channelType];
  if (!field) return null;
  const value = contact[field];
  return value ? String(value).trim() : null;
}
