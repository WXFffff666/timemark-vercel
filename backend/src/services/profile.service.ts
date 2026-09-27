import { query } from '../db/index.js';
import type { CreateProfileInput, ProfileKind, ProfileRecord, UpdateProfileInput } from '@timemark/shared';
/**
 * 家庭多档案服务（D5，checkbox 68/69）。
 *
 * 约定与 expiry/document 服务相同：
 * - 所有读写由 user_id 限定；他人的档案 = null / false，由路由映射 404（防存在性泄露）。
 * - 每个用户恰好一个 kind='self' 的「我」档案：由 v41 迁移创建；API 不能新建 self、
 *   不能改 self 的类别、不能删除 self（数据库部分唯一索引作最后兜底）。
 * - 删除普通档案依赖 `profile_id REFERENCES profiles(id) ON DELETE SET NULL`：
 *   关联数据保留，只是回到「未指定档案」。
 */

type RawRow = Record<string, unknown>;

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toYmdOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function toLunarBirthday(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function mapProfile(row: RawRow): ProfileRecord {
  const kind = row.kind === 'self' || row.kind === 'pet' ? row.kind : 'family';
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    name: String(row.name ?? ''),
    relation: row.relation == null ? null : String(row.relation),
    kind: kind as ProfileKind,
    birth_date: toYmdOrNull(row.birth_date),
    lunar_birthday: toLunarBirthday(row.lunar_birthday),
    avatar_emoji: row.avatar_emoji == null ? null : String(row.avatar_emoji),
    timezone: row.timezone == null ? null : String(row.timezone),
    sort_order: Number(row.sort_order ?? 0),
    is_active: row.is_active !== false,
    created_at: toIsoOrNull(row.created_at),
    updated_at: toIsoOrNull(row.updated_at),
  };
}

export async function listProfiles(
  userId: number,
  opts: { active?: boolean } = {},
): Promise<ProfileRecord[]> {
  const activeClause = opts.active === undefined ? '' : opts.active ? ' AND is_active = TRUE' : ' AND is_active = FALSE';
  const result = await query(
    `SELECT * FROM profiles WHERE user_id = $1${activeClause} ORDER BY sort_order ASC, id ASC`,
    [userId],
  );
  return result.rows.map((row) => mapProfile(row as RawRow));
}

export async function getProfile(userId: number, id: number): Promise<ProfileRecord | null> {
  const result = await query('SELECT * FROM profiles WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = result.rows[0];
  return row ? mapProfile(row as RawRow) : null;
}

/**
 * 过滤参数的归属校验：档案必须属于该用户且处于启用状态。
 * 路由据此对「不存在 / 他人的 / 已归档 / 格式非法」统一返回 404。
 */
export async function findOwnedProfile(userId: number, profileId: number): Promise<boolean> {
  const result = await query(
    'SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2 AND is_active = TRUE',
    [profileId, userId],
  );
  return result.rows.length > 0;
}

export async function createProfile(userId: number, input: CreateProfileInput): Promise<ProfileRecord> {
  const result = await query(
    `INSERT INTO profiles
       (user_id, name, relation, kind, birth_date, lunar_birthday, avatar_emoji, timezone, sort_order, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 0), COALESCE($10, TRUE))
     RETURNING *`,
    [
      userId,
      input.name,
      input.relation ?? null,
      input.kind ?? 'family',
      input.birthDate ?? null,
      input.lunarBirthday ? JSON.stringify(input.lunarBirthday) : null,
      input.avatarEmoji ?? null,
      input.timezone ?? null,
      input.sortOrder ?? null,
      input.isActive ?? null,
    ],
  );
  return mapProfile(result.rows[0] as RawRow);
}

export async function updateProfile(
  userId: number,
  id: number,
  input: UpdateProfileInput,
): Promise<ProfileRecord | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.name !== undefined) { updates.push(`name = $${paramIndex++}`); values.push(input.name); }
  if (input.relation !== undefined) { updates.push(`relation = $${paramIndex++}`); values.push(input.relation ?? null); }
  if (input.kind !== undefined) { updates.push(`kind = $${paramIndex++}`); values.push(input.kind); }
  if (input.birthDate !== undefined) { updates.push(`birth_date = $${paramIndex++}`); values.push(input.birthDate ?? null); }
  if (input.lunarBirthday !== undefined) {
    updates.push(`lunar_birthday = $${paramIndex++}`);
    values.push(input.lunarBirthday ? JSON.stringify(input.lunarBirthday) : null);
  }
  if (input.avatarEmoji !== undefined) { updates.push(`avatar_emoji = $${paramIndex++}`); values.push(input.avatarEmoji ?? null); }
  if (input.timezone !== undefined) { updates.push(`timezone = $${paramIndex++}`); values.push(input.timezone ?? null); }
  if (input.sortOrder !== undefined) { updates.push(`sort_order = $${paramIndex++}`); values.push(input.sortOrder); }
  if (input.isActive !== undefined) { updates.push(`is_active = $${paramIndex++}`); values.push(input.isActive); }

  if (updates.length === 0) {
    return getProfile(userId, id);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id, userId);
  const result = await query(
    `UPDATE profiles SET ${updates.join(', ')}
     WHERE id = $${paramIndex++} AND user_id = $${paramIndex}
     RETURNING *`,
    values,
  );
  const row = result.rows[0];
  return row ? mapProfile(row as RawRow) : null;
}

export type DeleteProfileResult = 'deleted' | 'not_found' | 'is_self';

/**
 * 删除普通档案：关联数据的 profile_id 由外键置 NULL（数据保留）。
 * 「我」（self）不可删除 - 没有它，回填/默认档案的语义就失去锚点。
 */
export async function deleteProfile(userId: number, id: number): Promise<DeleteProfileResult> {
  const existing = await query('SELECT kind FROM profiles WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!existing.rows[0]) return 'not_found';
  if (existing.rows[0].kind === 'self') return 'is_self';

  await query('DELETE FROM profiles WHERE id = $1 AND user_id = $2', [id, userId]);
  return 'deleted';
}

/* ------------------------------------------------------------------ */
/* 档案级通知路由（D5，checkbox 70）                                    */
/* ------------------------------------------------------------------ */

/**
 * 读取档案显式路由的通知账户 id（升序）。空数组 = 该档案没有路由行 =
 * 「全部启用账户」的默认语义，由 reminder 解析层负责回退。
 */
export async function listProfileAccountIds(userId: number, profileId: number): Promise<number[]> {
  const result = await query(
    `SELECT pca.account_id
     FROM profile_channel_accounts pca
     JOIN profiles p ON p.id = pca.profile_id
     WHERE pca.profile_id = $1 AND p.user_id = $2
     ORDER BY pca.account_id ASC`,
    [profileId, userId],
  );
  return (result.rows as RawRow[])
    .map((row) => Number(row.account_id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

export type SetProfileAccountsResult =
  | { status: 'ok'; accountIds: number[] }
  | { status: 'profile_not_found' }
  | { status: 'invalid_account'; accountId: number };

/**
 * 替换档案的路由集合（全量覆盖，幂等）。约束：
 * - 档案必须属于当前用户且未归档，否则 profile_not_found（路由映射 404）；
 * - 每个 accountId 必须是当前用户拥有的通知账户，否则 invalid_account（路由映射 400）；
 * - 空数组 = 清除路由行 → 回退「全部启用账户」；
 * - 重复 id 去重，避免 UNIQUE 冲突；删除后重建，与 UNIQUE(profile_id, account_id) 一致。
 */
export async function setProfileAccountIds(
  userId: number,
  profileId: number,
  accountIds: number[],
): Promise<SetProfileAccountsResult> {
  const owned = await findOwnedProfile(userId, profileId);
  if (!owned) return { status: 'profile_not_found' };

  const unique = [...new Set(accountIds)].sort((a, b) => a - b);
  if (unique.length > 0) {
    const valid = await query(
      'SELECT id FROM notification_accounts WHERE user_id = $1 AND id = ANY($2::int[])',
      [userId, unique],
    );
    const validIds = new Set((valid.rows as RawRow[]).map((row) => Number(row.id)));
    for (const accountId of unique) {
      if (!validIds.has(accountId)) return { status: 'invalid_account', accountId };
    }
  }

  await query('DELETE FROM profile_channel_accounts WHERE profile_id = $1', [profileId]);
  if (unique.length > 0) {
    await query(
      `INSERT INTO profile_channel_accounts (profile_id, account_id)
       SELECT $1, unnest($2::int[])
       ON CONFLICT (profile_id, account_id) DO NOTHING`,
      [profileId, unique],
    );
  }
  return { status: 'ok', accountIds: unique };
}
