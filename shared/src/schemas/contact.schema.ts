import { z } from 'zod';
import { cadenceDaysSchema } from '../types/crm.js';

const emailField = z.email('邮箱格式不正确').optional().or(z.literal(''));
const optionalText = z.string().max(200).optional().or(z.literal(''));

export const labeledValueSchema = z.object({
  label: z.string().max(50).optional().default(''),
  value: z.string().min(1).max(200),
});

const labeledList = z.array(labeledValueSchema).max(20).optional().default([]);

const contactBaseSchema = z.object({
  name: z.string().min(1, '姓名不能为空').max(100),
  nickname: optionalText,
  /** @deprecated 使用 emails 数组；保留兼容 */
  email: emailField,
  phone: optionalText,
  telegramChatId: optionalText,
  qq: optionalText,
  wxpusherUid: optionalText,
  emails: labeledList,
  phones: labeledList,
  telegrams: labeledList,
  qqs: labeledList,
  wxpusherUids: labeledList,
  /** 绑定的通知渠道账号 ID 列表（可多选） */
  channelAccountIds: z.array(z.number().int().positive()).default([]),
  /** 与我的关系（见 contact-relationship.ts 预设列表） */
  relationship: optionalText,
  /** v79: 联系人生日（YYYY-MM-DD）——未建生日事件也能触发祝福 */
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '生日格式应为 YYYY-MM-DD').optional().or(z.literal('')),
  /** v79: 该联系人退出祝福（greeting_opt_out） */
  greetingOptOut: z.boolean().optional(),
  /** 性别：用于非亲属称呼先生/女士 */
  gender: z.enum(['male', 'female', 'unknown']).optional().default('unknown'),
  notes: z.string().max(500).optional(),
  /** 联系节奏天数（预设 7/14/30/60/90/180/365 或自定义正整数）；null 清除 */
  cadenceDays: cadenceDaysSchema.nullish(),
  /** 是否启用节奏提醒（checkbox 62 的提醒任务读取该开关） */
  cadenceEnabled: z.boolean().optional(),
});

function hasAnyContactMethod(d: z.infer<typeof contactBaseSchema>): boolean {
  const lists = [d.emails, d.phones, d.telegrams, d.qqs, d.wxpusherUids];
  if (lists.some((arr) => (arr?.length ?? 0) > 0)) return true;
  return !!(d.email || d.phone || d.telegramChatId || d.qq || d.wxpusherUid);
}

export const contactSendEmailSchema = z.object({
  accountId: z.number().int().positive().optional(),
  subject: z.string().min(1, '主题不能为空').max(200),
  html: z.string().min(1, '内容不能为空').max(50000),
  /** 指定收件邮箱；留空则发往联系人全部邮箱 */
  recipientEmails: z.array(z.email()).min(1).max(20).optional(),
});

export const createFixedContactSchema = contactBaseSchema.refine(hasAnyContactMethod, {
  message: '至少填写一种联系方式（邮箱/手机/Telegram/QQ/WxPusher）',
});

export const updateFixedContactSchema = contactBaseSchema.partial().extend({
  name: z.string().min(1).max(100).optional(),
});

export type CreateFixedContactInput = z.infer<typeof contactBaseSchema>;
export type UpdateFixedContactInput = z.infer<typeof updateFixedContactSchema>;
export type ContactSendEmailInput = z.infer<typeof contactSendEmailSchema>;
