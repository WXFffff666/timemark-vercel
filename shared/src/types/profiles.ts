/**
 * 家庭多档案（D5，checkbox 68/69）—— Zod 校验与行类型。
 *
 * 个人家庭模型：self（我，迁移为每个用户自动创建）、family（家人）、pet（宠物）。
 * 不引入组织 / 团队 / 席位（非多租户）。`profileId` 在各领域查询里是可选过滤：
 * 省略 = 全部档案（与引入档案前的 API 形状一致），显式给出时必须属于当前用户，
 * 否则路由返回 404（防存在性泄露）。
 */
import { z } from 'zod';

export const PROFILE_KINDS = ['self', 'family', 'pet'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

/** 档案时区：IANA 名称（与 user_configs.timezone 同一约定） */
const profileTimezoneSchema = z.string().trim().min(1).max(64);

/** 农历生日：与事件 lunar_date 相同的 JSON 结构（month/day/isLeap），原样存储 */
const lunarBirthdaySchema = z.record(z.string(), z.unknown());

export const createProfileSchema = z.object({
  name: z.string().trim().min(1, '档案名称不能为空').max(100),
  /** 称呼：妈妈 / 爸爸 / 儿子 …（自由文本） */
  relation: z.string().trim().max(100).nullish(),
  /**
   * self 由迁移为每个用户自动创建且不可再建/删除/改类；API 新建仅接受 family|pet。
   * 省略 = family。
   */
  kind: z.enum(['family', 'pet']).optional(),
  birthDate: z.iso.date().nullish(),
  lunarBirthday: lunarBirthdaySchema.nullish(),
  /** emoji / 短图标 */
  avatarEmoji: z.string().max(16).nullish(),
  timezone: profileTimezoneSchema.nullish(),
  sortOrder: z.number().int().min(-10000).max(10000).optional(),
  isActive: z.boolean().optional(),
});
export type CreateProfileInput = z.infer<typeof createProfileSchema>;

/**
 * PATCH 语义：只更新给出的字段。`kind` 只允许 family|pet（self 档案的类别不可变，
 * 且一个用户至多一个 self - 数据库部分唯一索引兜底）。
 */
export const updateProfileSchema = createProfileSchema.partial();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * 档案通知路由（D5，checkbox 70）：`PUT /api/profiles/:id/accounts` 的请求体。
 * `accountIds` 为空数组 = 清除该档案的显式路由 → 回退「全部启用账户」。
 * 每个 id 必须是当前用户拥有的通知账户，服务端逐一校验（他人的账户 = 400，不泄露）。
 */
export const setProfileAccountsSchema = z.object({
  accountIds: z.array(z.number().int().positive()).max(500),
});
export type SetProfileAccountsInput = z.infer<typeof setProfileAccountsSchema>;

/** 档案 → 通知账户路由（checkbox 70）的读取形状 */
export interface ProfileAccountRouting {
  profile_id: number;
  account_ids: number[];
}

export interface ProfileRecord {
  id: number;
  user_id: number;
  name: string;
  relation: string | null;
  kind: ProfileKind;
  birth_date: string | null;
  lunar_birthday: Record<string, unknown> | null;
  avatar_emoji: string | null;
  timezone: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}
