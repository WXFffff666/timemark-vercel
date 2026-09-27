/**
 * 个人 CRM（D4）— Zod 校验与类型
 *
 * 领域：联系人互动记录（interactions）、约定（contact_promises）、礼物往来
 * （gift_records）以及联系节奏（fixed_contacts.cadence_days / cadence_enabled /
 * last_contact_at，迁移 v39）。
 *
 * `last_contact_at` 是派生字段：读取时取「最新互动时间」，没有互动时回落到
 * 存储列（见 backend/src/services/contact-crm.service.ts）。
 * 本文件只做数据校验/类型，不发明联系人评分或排名。
 */
import { z } from 'zod';

/** 互动方式 */
export const INTERACTION_KINDS = [
  'call',
  'message',
  'meeting',
  'meal',
  'visit',
  'gift',
  'other',
] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

/** 礼物方向：送出的 / 收到的 */
export const GIFT_DIRECTIONS = ['given', 'received'] as const;
export type GiftDirection = (typeof GIFT_DIRECTIONS)[number];

/** 预设联系节奏（天）；除预设外也允许自定义正整数 */
export const CADENCE_DAY_PRESETS = [7, 14, 30, 60, 90, 180, 365] as const;
/** 自定义节奏上限（10 年），防止误输入 */
export const CADENCE_DAYS_MAX = 3650;

export const interactionKindSchema = z.enum(INTERACTION_KINDS);
export const giftDirectionSchema = z.enum(GIFT_DIRECTIONS);

/** 联系节奏天数：正整数（含自定义），null 表示未设置 */
export const cadenceDaysSchema = z
  .number()
  .int('节奏天数必须为整数')
  .positive('节奏天数必须大于 0')
  .max(CADENCE_DAYS_MAX, `节奏天数不能超过 ${CADENCE_DAYS_MAX}`);

const isoInstantSchema = z.union([
  z.iso.datetime({ offset: true }),
  z.iso.datetime(),
  z.iso.date(),
]);

/** POST /api/contacts/:id/interactions */
export const createInteractionSchema = z.object({
  kind: interactionKindSchema,
  /** 发生时间（ISO 8601 或 YYYY-MM-DD）；缺省为当前时间。不允许未来时间 */
  occurredAt: isoInstantSchema.optional(),
  summary: z.string().max(2000).nullish(),
  mood: z.string().max(50).nullish(),
});
export type CreateInteractionInput = z.infer<typeof createInteractionSchema>;

/** POST /api/contacts/:id/promises */
export const createContactPromiseSchema = z.object({
  text: z.string().min(1, '内容不能为空').max(2000),
  /** 截止日期；null/缺省 = 无期限的约定（合法） */
  dueAt: z.iso.date().nullish(),
});
export type CreateContactPromiseInput = z.infer<typeof createContactPromiseSchema>;

/** POST /api/contacts/:id/gifts */
export const createGiftRecordSchema = z.object({
  description: z.string().min(1, '礼物描述不能为空').max(500),
  direction: giftDirectionSchema,
  occasion: z.string().max(200).nullish(),
  /** 金额（整数分）；null/缺省表示不记录金额 */
  amountCents: z.number().int('金额必须为整数分').min(0, '金额不能为负数').nullish(),
  /** 发生日期 YYYY-MM-DD；缺省为今天 */
  occurredAt: z.iso.date().nullish(),
});
export type CreateGiftRecordInput = z.infer<typeof createGiftRecordSchema>;

/** fixed_contacts 上的节奏列（v39） */
export interface ContactCadenceFields {
  cadence_days: number | null;
  last_contact_at: string | null;
  cadence_enabled: boolean;
}

export interface InteractionRow {
  id: number;
  user_id: number;
  contact_id: number;
  kind: InteractionKind;
  occurred_at: string;
  summary: string | null;
  mood: string | null;
  created_at: string;
}

export interface ContactPromiseRow {
  id: number;
  contact_id: number;
  text: string;
  due_at: string | null;
  done_at: string | null;
  created_at: string;
}

export interface GiftRecordRow {
  id: number;
  contact_id: number;
  description: string;
  direction: GiftDirection;
  occasion: string | null;
  amount_cents: number | null;
  occurred_at: string;
  created_at: string;
}

/**
 * 时间线合并条目（interactions + promises + gifts，按时间倒序）。
 * 三个来源的字段并集，未命中的来源字段为 null；`type` 是判别字段。
 */
export interface TimelineEntry {
  type: 'interaction' | 'promise' | 'gift';
  id: number;
  /** 排序锚点：互动用 occurred_at，约定用 done_at/due_at/created_at，礼物用 occurred_at */
  at: string;
  interaction_kind: InteractionKind | null;
  summary: string | null;
  mood: string | null;
  promise_text: string | null;
  due_at: string | null;
  done_at: string | null;
  gift_description: string | null;
  direction: GiftDirection | null;
  occasion: string | null;
  /** BIGINT：node-postgres 返回字符串（与 expiry_items.amount_cents 一致） */
  amount_cents: string | number | null;
  created_at: string | null;
}

/** GET /api/contacts/due 返回的到期联系人（联系人行 + 派生节奏字段） */
export interface DueContactRow {
  id: number;
  user_id: number;
  name: string;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  relationship: string | null;
  gender: string | null;
  cadence_days: number;
  cadence_enabled: boolean;
  /** 存储列（可能落后于互动记录） */
  last_contact_at: string | null;
  /** 派生：MAX(interactions.occurred_at) 优先，否则存储列 */
  effective_last_contact_at: string | null;
  /** 派生：effective_last_contact_at + cadence_days；从未联系时为 null */
  next_due_at: string | null;
}
