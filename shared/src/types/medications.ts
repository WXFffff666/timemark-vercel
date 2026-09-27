/**
 * 家庭用药与健康日程（D3，checkbox 71/72/73）—— Zod 校验与行类型。
 *
 * 提醒与记录 ONLY：不做医疗建议、不接药房、不对这些数据做任何 AI 推断。
 * 时间点用 `schedule_times`（TEXT[]，HH:mm）表达，绝不套用事件提醒的
 * ±2 分钟 `reminder_time` 模型。`schedule_times` 允许为空（PRN / 按需），
 * 此时不生成任何计划剂量。
 */
import { z } from 'zod';

export const MEDICATION_FORMS = ['tablet', 'capsule', 'liquid', 'injection', 'patch', 'drops', 'other'] as const;
export type MedicationForm = (typeof MEDICATION_FORMS)[number];

export const DOSE_STATUSES = ['taken', 'skipped', 'missed', 'pending'] as const;
export type DoseStatus = (typeof DOSE_STATUSES)[number];

/** 用户可写的剂量状态：missed / pending 由系统决定，不接受客户端写入 */
export const LOGGABLE_DOSE_STATUSES = ['taken', 'skipped'] as const;
export type LoggableDoseStatus = (typeof LOGGABLE_DOSE_STATUSES)[number];

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间必须是 HH:mm（24 小时制）');
const ymdSchema = z.iso.date();

/** 去重后的提醒时间：重复项不是错误，但落库前归一（避免同一时刻出现两条计划） */
const scheduleTimesSchema = z
  .array(timeSchema)
  .max(48)
  .transform((times) => [...new Set(times)].sort())
  .default([]);

const medicationFields = z.object({
  name: z.string().trim().min(1, '药品名称不能为空').max(200),
  dosage: z.string().trim().max(200).nullish(),
  form: z.enum(MEDICATION_FORMS).optional(),
  /** 每天的计划服药时刻 HH:mm；空数组 = PRN / 按需，不生成计划剂量 */
  scheduleTimes: scheduleTimesSchema,
  /** 每周哪几天（0=周日..6=周六）；省略 = 每天 */
  scheduleDays: z.array(z.number().int().min(0).max(6)).max(7).nullish(),
  startDate: ymdSchema,
  endDate: ymdSchema.nullish(),
  stockQuantity: z.number().min(0).nullish(),
  stockUnit: z.string().trim().max(50).nullish(),
  /** 每次服用的单位数；必须 > 0（数据库 CHECK 同款约束，0 一律 400） */
  unitsPerDose: z.number().gt(0).optional(),
  refillThreshold: z.number().min(0).nullish(),
  prescriber: z.string().trim().max(200).nullish(),
  pharmacy: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  isActive: z.boolean().optional(),
  /** 关键用药：可绕过免打扰时段（必须是显式选择，绝不隐式绕过） */
  isCritical: z.boolean().optional(),
  profileId: z.number().int().positive().nullish(),
});

function checkDateOrder(
  value: { startDate?: string; endDate?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.startDate && value.endDate && value.endDate < value.startDate) {
    ctx.addIssue({ code: 'custom', message: '结束日期不能早于开始日期', path: ['endDate'] });
  }
}

export const createMedicationSchema = medicationFields.superRefine(checkDateOrder);
export type CreateMedicationInput = z.infer<typeof createMedicationSchema>;

export const updateMedicationSchema = medicationFields.partial().superRefine(checkDateOrder);
export type UpdateMedicationInput = z.infer<typeof updateMedicationSchema>;

/** POST /api/doses/:id/log 请求体：只接受 taken / skipped */
export const logDoseSchema = z.object({
  status: z.enum(LOGGABLE_DOSE_STATUSES),
  note: z.string().trim().max(500).nullish(),
});
export type LogDoseInput = z.infer<typeof logDoseSchema>;

export interface MedicationRecord {
  id: number;
  user_id: number;
  profile_id: number | null;
  name: string;
  dosage: string | null;
  form: MedicationForm;
  schedule_times: string[];
  schedule_days: number[] | null;
  start_date: string;
  end_date: string | null;
  stock_quantity: number | null;
  stock_unit: string | null;
  units_per_dose: number;
  refill_threshold: number | null;
  prescriber: string | null;
  pharmacy: string | null;
  notes: string | null;
  is_active: boolean;
  is_critical: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface MedicationDoseRecord {
  id: number;
  medication_id: number;
  user_id: number;
  scheduled_for: string;
  logged_at: string | null;
  status: DoseStatus;
  note: string | null;
  created_at: string | null;
}

/** GET /api/medications/today 的一行：剂量 + 所属药品摘要 */
export interface TodayDose extends MedicationDoseRecord {
  medication: Pick<
    MedicationRecord,
    'id' | 'name' | 'dosage' | 'form' | 'units_per_dose' | 'stock_unit' | 'is_critical' | 'profile_id'
  >;
}

/** 依从性统计的一档（整体或单个药品）：只有已结算剂量计入百分比与连胜 */
export interface AdherenceBucket {
  taken: number;
  skipped: number;
  missed: number;
  /** taken + skipped + missed（pending 不计入分母） */
  total: number;
  /** taken / total 的百分数，四舍五入到整数；total=0 时为 0 */
  percentage: number;
  /** 从 to 日往前连续「全部服用（有 taken、无 skipped/missed）」的天数 */
  currentStreak: number;
}

export interface MedicationAdherence extends AdherenceBucket {
  medicationId: number;
  name: string;
}

export interface AdherenceReport {
  from: string;
  to: string;
  overall: AdherenceBucket;
  medications: MedicationAdherence[];
}

export type RefillReason = 'threshold' | 'days_of_supply' | 'both';

/** GET /api/medications/refills 的一行 */
export interface RefillItem {
  medicationId: number;
  name: string;
  profile_id: number | null;
  stockQuantity: number;
  stockUnit: string | null;
  unitsPerDose: number;
  refillThreshold: number | null;
  /** 预计可维持天数（无法推算时为 null：无库存 / 无计划时刻） */
  daysOfSupply: number | null;
  reason: RefillReason;
}
