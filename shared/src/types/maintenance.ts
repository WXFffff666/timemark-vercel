/**
 * 保养计划（D12）— Zod 校验与类型
 *
 * 资产：车辆 (vehicle)、家电 (appliance)、设备 (device)、其它 (other)。
 * 间隔可以是按日期（interval_days）或按用量（interval_usage，单位 km|hours|cycles），
 * 至少要有其一——否则计划无法计算「下次保养」。
 *
 * 日期间隔通过既有提醒引擎发出提醒（backend/src/jobs/tasks.ts，同一张
 * reminder_send_claims，`maintenance:` 前缀）；用量间隔不做通知，而是在
 * 剩余量进入阈值的 10% 时由同一调度写一条收件箱提醒（sendMaintenanceUsageNudges）。
 *
 * 明确不读取车辆里程表：没有可靠的免硬件数据源，current_usage 由用户/保养记录写入。
 */
import { z } from 'zod';
import { expiryReminderConfigSchema } from './expiry.js';

/** 资产类型 */
export const ASSET_KINDS = ['vehicle', 'appliance', 'device', 'other'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const assetKindSchema = z.enum(ASSET_KINDS);

/** 用量单位 */
export const USAGE_UNITS = ['km', 'hours', 'cycles'] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];
export const usageUnitSchema = z.enum(USAGE_UNITS);

/**
 * 提醒配置与到期中心同构（enabled / daysBeforeList / reminderTimes / channels /
 * accountIds / customMessage），因为两者共用同一个提醒引擎与 JSONB 约定。
 */
export const maintenanceReminderConfigSchema = expiryReminderConfigSchema;
export type MaintenanceReminderConfig = z.infer<typeof maintenanceReminderConfigSchema>;

const ymdDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD');

const maintenancePlanFieldsSchema = z.object({
  assetName: z.string().min(1, '资产名称不能为空').max(200),
  assetKind: assetKindSchema.optional(),
  /** 按日期间隔（天）；与 intervalUsage 至少填一个 */
  intervalDays: z.number().int('日期间隔必须为整数天').positive('日期间隔必须大于 0').max(36500).nullish(),
  /** 按用量间隔；与 intervalDays 至少填一个 */
  intervalUsage: z.number().int('用量间隔必须为整数').positive('用量间隔必须大于 0').max(10_000_000).nullish(),
  usageUnit: usageUnitSchema.nullish(),
  currentUsage: z.number().min(0, '当前用量不能为负数').nullish(),
  lastDoneAt: ymdDateSchema.nullish(),
  nextDueAt: ymdDateSchema.nullish(),
  nextDueUsage: z.number().min(0, '下次保养用量不能为负数').nullish(),
  notes: z.string().max(2000).nullish(),
  reminderConfig: maintenanceReminderConfigSchema.nullish(),
  isActive: z.boolean().optional(),
  /** 预留：D5 家庭档案 */
  profileId: z.number().int().positive().nullish(),
});

export const NO_INTERVAL_MESSAGE =
  '必须至少设置一个保养间隔：按日期（intervalDays）或按用量（intervalUsage）';

function hasAtLeastOneInterval(data: { intervalDays?: number | null; intervalUsage?: number | null }): boolean {
  return data.intervalDays != null || data.intervalUsage != null;
}

export const createMaintenancePlanSchema = maintenancePlanFieldsSchema.refine(hasAtLeastOneInterval, {
  message: NO_INTERVAL_MESSAGE,
  path: ['intervalDays'],
});

/**
 * PATCH：全字段可选。这里故意不做「至少一个间隔」refine——partial 时两个字段都可能
 * 不出现，Zod 无法知道库里的旧值；真正的「改完两个间隔都为 null」由服务层在合并
 * 现状后拒绝（返回 400 + NO_INTERVAL_MESSAGE）。
 */
export const updateMaintenancePlanSchema = maintenancePlanFieldsSchema.partial();

/** POST /:id/log — 记录一次保养 */
export const recordMaintenanceLogSchema = z.object({
  doneAt: ymdDateSchema,
  /** 本次保养时的用量读数；计划带 intervalUsage 时必填（服务层校验） */
  usageAt: z.number().min(0, '用量读数不能为负数').nullish(),
  costCents: z.number().int('金额必须为整数分').min(0, '金额不能为负数').nullish(),
  notes: z.string().max(2000).nullish(),
});

export type CreateMaintenancePlanInput = z.infer<typeof createMaintenancePlanSchema>;
export type UpdateMaintenancePlanInput = z.infer<typeof updateMaintenancePlanSchema>;
export type RecordMaintenanceLogInput = z.infer<typeof recordMaintenanceLogSchema>;
