import { z } from 'zod';

const emailField = z.string().email('邮箱格式不正确').optional().or(z.literal(''));
const optionalText = z.string().max(200).optional().or(z.literal(''));

const contactBaseSchema = z.object({
  name: z.string().min(1, '姓名不能为空').max(100),
  nickname: optionalText,
  email: emailField,
  phone: optionalText,
  telegramChatId: optionalText,
  qq: optionalText,
  wxpusherUid: optionalText,
  /** 绑定的通知渠道账号 ID 列表 */
  channelAccountIds: z.array(z.number().int().positive()).default([]),
  notes: z.string().max(500).optional(),
});

export const contactSendEmailSchema = z.object({
  accountId: z.number().int().positive().optional(),
  subject: z.string().min(1, '主题不能为空').max(200),
  html: z.string().min(1, '内容不能为空').max(50000),
});

export const createFixedContactSchema = contactBaseSchema.refine(
  (d) => !!(d.email || d.phone || d.telegramChatId || d.qq || d.wxpusherUid),
  { message: '至少填写一种联系方式（邮箱/手机/Telegram/QQ/WxPusher）' },
);

export const updateFixedContactSchema = contactBaseSchema.partial().extend({
  name: z.string().min(1).max(100).optional(),
});

export type CreateFixedContactInput = z.infer<typeof contactBaseSchema>;
export type UpdateFixedContactInput = z.infer<typeof updateFixedContactSchema>;
export type ContactSendEmailInput = z.infer<typeof contactSendEmailSchema>;
