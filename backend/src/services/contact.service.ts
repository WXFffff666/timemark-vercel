import { query } from '../db/index.js';
import type { CreateFixedContactInput, UpdateFixedContactInput } from '@timemark/shared';
import { parseChannelAccountIds } from '@timemark/shared';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mapContactRow(row: Record<string, unknown>) {
  return {
    ...row,
    channel_account_ids: parseChannelAccountIds(row.preferred_channels),
  };
}

export function validateContactFields(contact: {
  email?: string | null;
  phone?: string | null;
  telegram_chat_id?: string | null;
  qq?: string | null;
  wxpusher_uid?: string | null;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (contact.email && !EMAIL_RE.test(contact.email)) errors.push('邮箱格式无效');
  if (contact.qq && !/^\d{5,12}$/.test(contact.qq)) errors.push('QQ 号格式无效');
  if (contact.telegram_chat_id && !/^-?\d+$/.test(contact.telegram_chat_id)) errors.push('Telegram Chat ID 格式无效');
  if (contact.wxpusher_uid && !/^UID_/i.test(contact.wxpusher_uid)) errors.push('WxPusher UID 应以 UID_ 开头');
  const hasChannel = !!(contact.email || contact.phone || contact.telegram_chat_id || contact.qq || contact.wxpusher_uid);
  if (!hasChannel) errors.push('至少一种联系方式');
  return { valid: errors.length === 0, errors };
}

export async function listFixedContacts(userId: number) {
  const result = await query(
    `SELECT id, name, nickname, email, phone, telegram_chat_id, qq, wxpusher_uid,
            preferred_channels, notes, validation_status, last_validated_at, created_at, updated_at
     FROM fixed_contacts WHERE user_id = $1 ORDER BY name ASC`,
    [userId],
  );
  return result.rows.map(mapContactRow);
}

export async function createFixedContact(userId: number, input: CreateFixedContactInput) {
  const validation = validateContactFields({
    email: input.email || null,
    phone: input.phone || null,
    telegram_chat_id: input.telegramChatId || null,
    qq: input.qq || null,
    wxpusher_uid: input.wxpusherUid || null,
  });
  if (!validation.valid) {
    throw new Error(validation.errors.join('; '));
  }

  const result = await query(
    `INSERT INTO fixed_contacts
     (user_id, name, nickname, email, phone, telegram_chat_id, qq, wxpusher_uid, preferred_channels, notes, validation_status, last_validated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'valid',CURRENT_TIMESTAMP)
     RETURNING *`,
    [
      userId,
      input.name,
      input.nickname || null,
      input.email || null,
      input.phone || null,
      input.telegramChatId || null,
      input.qq || null,
      input.wxpusherUid || null,
      JSON.stringify(input.channelAccountIds || []),
      input.notes || null,
    ],
  );
  return mapContactRow(result.rows[0]);
}(userId: number, id: number, input: UpdateFixedContactInput) {
  const existing = await query('SELECT * FROM fixed_contacts WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!existing.rows[0]) return null;

  const merged = {
    email: input.email !== undefined ? input.email : existing.rows[0].email,
    phone: input.phone !== undefined ? input.phone : existing.rows[0].phone,
    telegram_chat_id: input.telegramChatId !== undefined ? input.telegramChatId : existing.rows[0].telegram_chat_id,
    qq: input.qq !== undefined ? input.qq : existing.rows[0].qq,
    wxpusher_uid: input.wxpusherUid !== undefined ? input.wxpusherUid : existing.rows[0].wxpusher_uid,
  };
  const validation = validateContactFields(merged);
  if (!validation.valid) throw new Error(validation.errors.join('; '));

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 0;
  const map: Record<string, unknown> = {
    name: input.name,
    nickname: input.nickname,
    email: input.email,
    phone: input.phone,
    telegram_chat_id: input.telegramChatId,
    qq: input.qq,
    wxpusher_uid: input.wxpusherUid,
    notes: input.notes,
  };
  for (const [col, val] of Object.entries(map)) {
    if (val !== undefined) {
      i++;
      fields.push(`${col} = $${i}`);
      values.push(val === '' ? null : val);
    }
  }
  if (input.channelAccountIds !== undefined) {
    i++;
    fields.push(`preferred_channels = $${i}`);
    values.push(JSON.stringify(input.channelAccountIds));
  }
  i++;
  fields.push(`validation_status = $${i}`);
  values.push('valid');
  i++;
  fields.push(`last_validated_at = CURRENT_TIMESTAMP`);
  i++;
  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id, userId);

  const result = await query(
    `UPDATE fixed_contacts SET ${fields.join(', ')} WHERE id = $${i} AND user_id = $${i + 1} RETURNING *`,
    values,
  );
  return result.rows[0] ? mapContactRow(result.rows[0]) : null;
}

export async function getFixedContact(userId: number, id: number) {
  const result = await query('SELECT * FROM fixed_contacts WHERE id = $1 AND user_id = $2', [id, userId]);
  return result.rows[0] ? mapContactRow(result.rows[0]) : null;
}

export async function deleteFixedContact(userId: number, id: number) {
  const result = await query('DELETE FROM fixed_contacts WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return result.rowCount ? true : false;
}

export async function getContactsByIds(userId: number, ids: number[]) {
  if (ids.length === 0) return [];
  const result = await query(
    `SELECT * FROM fixed_contacts WHERE user_id = $1 AND id = ANY($2::int[])`,
    [userId, ids],
  );
  return result.rows.map(mapContactRow);
}
