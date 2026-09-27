/**
 * 到期项（到期中心 D1）— Zod 校验与类型
 *
 * 领域：订阅 (subscription)、账单 (bill)、保险 (insurance)、域名 (domain)、
 * 保修 (warranty)、自定义 (custom)。到期项是独立于 events 的实体：
 * 它携带费用/周期元数据，并通过既有提醒引擎发出提醒（见 backend jobs/tasks.ts）。
 */
import { z } from 'zod';

/** 到期项类型 */
export const EXPIRY_KINDS = [
  'subscription',
  'bill',
  'insurance',
  'domain',
  'warranty',
  'custom',
] as const;
export type ExpiryItemKind = (typeof EXPIRY_KINDS)[number];

/** 续费周期；`once` 为一次性，永不自动续期（renew 会被拒绝） */
export const EXPIRY_CYCLES = ['once', 'monthly', 'quarterly', 'yearly', 'custom'] as const;
export type ExpiryCycle = (typeof EXPIRY_CYCLES)[number];

export const expiryKindSchema = z.enum(EXPIRY_KINDS);
export const expiryCycleSchema = z.enum(EXPIRY_CYCLES);

const ymdDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD');
const hhmmTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式必须为 HH:mm');

/** 到期项提醒配置（写入 expiry_items.reminder_config JSONB） */
export const expiryReminderConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /** 提前提醒天数；缺省时引擎使用 [30, 7, 3, 1, 0] */
  daysBeforeList: z.array(z.number().int().min(0).max(3650)).max(20).optional(),
  /** 提醒时刻（用户时区）；缺省 09:00 */
  reminderTimes: z.array(hhmmTimeSchema).max(10).optional(),
  /** 通知渠道 id 列表（与事件的 notification_channels 同义） */
  channels: z.array(z.string().min(1).max(50)).max(20).optional(),
  /** 指定通知账号 id 列表 */
  accountIds: z.array(z.number().int().positive()).max(20).optional(),
  /** 自定义提醒文案（可选） */
  customMessage: z.string().max(2000).optional(),
});
export type ExpiryReminderConfig = z.infer<typeof expiryReminderConfigSchema>;

const expiryItemFieldsSchema = z.object({
  kind: expiryKindSchema,
  title: z.string().min(1, '名称不能为空').max(200),
  vendor: z.string().max(200).nullish(),
  /** 金额（整数分）；负数被拒绝。null/缺省表示不记录金额 */
  amountCents: z.number().int('金额必须为整数分').min(0, '金额不能为负数').nullish(),
  /** ISO 4217 三字母代码；存储前统一大写 */
  currency: z.string().regex(/^[A-Za-z]{3}$/, '货币必须为 3 位字母代码').optional(),
  cycle: expiryCycleSchema.optional(),
  /** cycle 为 custom 时必填（正整数天） */
  cycleDays: z.number().int().positive().max(3650).nullish(),
  startDate: ymdDateSchema.nullish(),
  nextDueDate: ymdDateSchema,
  autoRenew: z.boolean().optional(),
  notes: z.string().max(2000).nullish(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  reminderConfig: expiryReminderConfigSchema.nullish(),
  isActive: z.boolean().optional(),
  /** 预留：D5 家庭档案 */
  profileId: z.number().int().positive().nullish(),
});

function dueDateNotBeforeStart(data: {
  startDate?: string | null;
  nextDueDate?: string | null;
}): boolean {
  if (!data.startDate || !data.nextDueDate) return true;
  return data.nextDueDate >= data.startDate;
}

function customCycleHasDays(data: { cycle?: ExpiryCycle; cycleDays?: number | null }): boolean {
  if (data.cycle !== 'custom') return true;
  return typeof data.cycleDays === 'number' && data.cycleDays > 0;
}

const DUE_BEFORE_START_MESSAGE = 'next_due_date 不能早于 start_date';
const CUSTOM_CYCLE_MESSAGE = 'cycle 为 custom 时必须提供 cycle_days';

export const createExpiryItemSchema = expiryItemFieldsSchema
  .refine(dueDateNotBeforeStart, { message: DUE_BEFORE_START_MESSAGE, path: ['nextDueDate'] })
  .refine(customCycleHasDays, { message: CUSTOM_CYCLE_MESSAGE, path: ['cycleDays'] });

export const updateExpiryItemSchema = expiryItemFieldsSchema
  .partial()
  .refine(dueDateNotBeforeStart, { message: DUE_BEFORE_START_MESSAGE, path: ['nextDueDate'] })
  .refine(customCycleHasDays, { message: CUSTOM_CYCLE_MESSAGE, path: ['cycleDays'] });

export type CreateExpiryItemInput = z.infer<typeof createExpiryItemSchema>;
export type UpdateExpiryItemInput = z.infer<typeof updateExpiryItemSchema>;
