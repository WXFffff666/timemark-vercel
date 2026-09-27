/**
 * 库存（D12）— Zod 校验与类型
 *
 * 领域：食品 (food)、药品 (medicine)、耗材 (supply)、其它 (other)。
 * 库存项是可消耗实体：数量 + 低库存阈值，可选购买日与到期日。
 * 带 expires_at 的库存项复用到期中心的提醒引擎
 * （backend/src/jobs/tasks.ts 的 dated 迭代器，同一张 reminder_send_claims，
 * send key 用 `inventory:` 前缀与事件/到期项隔离）。
 *
 * 明确不做条码扫描：需要摄像头与付费 OCR，超出本领域范围。
 */
import { z } from 'zod';
import { expiryReminderConfigSchema } from './expiry.js';

/** 库存分类 */
export const INVENTORY_CATEGORIES = ['food', 'medicine', 'supply', 'other'] as const;
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];
export const inventoryCategorySchema = z.enum(INVENTORY_CATEGORIES);

/**
 * 提醒配置与到期中心同构（enabled / daysBeforeList / reminderTimes / channels /
 * accountIds / customMessage），因为两者共用同一个提醒引擎与 JSONB 约定。
 */
export const inventoryReminderConfigSchema = expiryReminderConfigSchema;
export type InventoryReminderConfig = z.infer<typeof inventoryReminderConfigSchema>;

const ymdDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD');

const inventoryItemFieldsSchema = z.object({
  name: z.string().min(1, '名称不能为空').max(200),
  category: inventoryCategorySchema.optional(),
  /** 数量；支持小数（如 0.5 kg）。负数被拒绝 */
  quantity: z.number().min(0, '数量不能为负数').optional(),
  unit: z.string().max(50).nullish(),
  /** 低库存阈值：quantity <= threshold 视为低库存；null 表示不跟踪 */
  lowStockThreshold: z.number().min(0, '低库存阈值不能为负数').nullish(),
  purchasedAt: ymdDateSchema.nullish(),
  /** 到期日；null/缺省 = 非易腐品，永不进入 GET /expiring */
  expiresAt: ymdDateSchema.nullish(),
  location: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
  reminderConfig: inventoryReminderConfigSchema.nullish(),
  isActive: z.boolean().optional(),
  /** 预留：D5 家庭档案 */
  profileId: z.number().int().positive().nullish(),
});

function expiryNotBeforePurchase(data: {
  purchasedAt?: string | null;
  expiresAt?: string | null;
}): boolean {
  if (!data.purchasedAt || !data.expiresAt) return true;
  return data.expiresAt >= data.purchasedAt;
}

const EXPIRY_BEFORE_PURCHASE_MESSAGE = 'expires_at 不能早于 purchased_at';

export const createInventoryItemSchema = inventoryItemFieldsSchema.refine(
  expiryNotBeforePurchase,
  { message: EXPIRY_BEFORE_PURCHASE_MESSAGE, path: ['expiresAt'] },
);

/** PATCH：全字段可选；跨字段 refine 只在两个字段都出现时生效（与到期中心一致） */
export const updateInventoryItemSchema = inventoryItemFieldsSchema
  .partial()
  .refine(expiryNotBeforePurchase, {
    message: EXPIRY_BEFORE_PURCHASE_MESSAGE,
    path: ['expiresAt'],
  });

/** POST /:id/consume — 消耗数量必须为正数（0 或负数不具备语义） */
export const consumeInventoryItemSchema = z.object({
  quantity: z.number().positive('消耗数量必须大于 0').max(1_000_000, '单次消耗数量过大'),
});

export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;
export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;
export type ConsumeInventoryItemInput = z.infer<typeof consumeInventoryItemSchema>;
