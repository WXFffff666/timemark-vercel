import { query } from '../db/index.js';
import { NOTIFICATION_PRESETS } from '@timemark/shared/notification-presets';
import { filterSupportedChannels } from './notifications/supported-channels.js';

/**
 * 用户「已有渠道」的兜底解析：notification_accounts 中 is_active = TRUE 的账户类型
 * （同一类型多账户只解析一次，实际发送时 sendNotifications 会按类型选用账户）。
 *
 * 与 lunar-reminders.service.ts 的默认渠道约定一致：不要求用户为每个条目额外配置
 * 提醒规则，也能走已配置的默认/启用渠道。fresh install 上如果连一个启用账户都没有，
 * 这里自然返回 []（没有任何渠道可送达）。
 */
export async function resolveActiveAccountChannels(userId: number): Promise<string[]> {
  const accounts = await query(
    `SELECT DISTINCT type FROM notification_accounts
     WHERE user_id = $1 AND is_active = TRUE
       AND (suspended_until IS NULL OR suspended_until <= NOW())`,
    [userId],
  );
  const types = (accounts.rows as Array<{ type?: unknown }>)
    .map((row) => (typeof row.type === 'string' ? row.type : ''))
    .filter(Boolean);
  return filterSupportedChannels(types);
}

/**
 * 按条件规则、通知套餐与事件渠道，解析本次提醒应使用的渠道列表。
 * 优先级：条件规则 > 套餐分级 > 事件自身渠道 > 用户已启用渠道（默认兜底）
 *
 * 兜底的存在意义：UI 创建的到期项/证件/库存/保养条目默认不带 reminder_config，
 * 事件表单也允许不勾选渠道；若这里返回 []，迭代器会把条目静默跳过（用户完全收不到
 * 提醒，即便他已经配置了通知渠道）。只有在前面全部解析不到渠道时才回退到
 * notification_accounts（与 resolveRecipientEmails 的「回退到用户配置」同构）。
 */
export async function resolveReminderChannels(
  userId: number,
  eventChannels: string[],
  daysUntil: number,
): Promise<string[]> {
  const base = filterSupportedChannels(
    Array.isArray(eventChannels) ? eventChannels.filter(Boolean) : [],
  );

  const rules = await query(
    `SELECT days_before, channels FROM conditional_reminder_rules
     WHERE user_id = $1 AND days_before = $2`,
    [userId, daysUntil],
  );
  if (rules.rows.length > 0) {
    const raw = rules.rows[0].channels;
    const channels = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(channels) && channels.length > 0) {
      return filterSupportedChannels(channels);
    }
  }

  const cfg = await query(
    'SELECT notification_preset FROM user_configs WHERE user_id = $1',
    [userId],
  );
  const presetId = cfg.rows[0]?.notification_preset as string | null;
  if (presetId && NOTIFICATION_PRESETS[presetId]) {
    const tier = NOTIFICATION_PRESETS[presetId].tiers.find((t) => t.daysBefore === daysUntil);
    if (tier?.channels?.length) {
      return filterSupportedChannels(tier.channels);
    }
  }

  if (base.length > 0) return base;

  return resolveActiveAccountChannels(userId);
}

/**
 * 档案级通知账户路由（D5，checkbox 70）。
 *
 * `profile_channel_accounts(profile_id, account_id)` 决定该档案的提醒可以走哪些
 * 通知账户：
 * - 存在路由行 → 只有这些账户可选（显式路由优先）；
 * - 不存在路由行 → 返回 null，调用方回退到「全部启用账户」（引入路由前的行为，
 *   老用户不做任何配置也照常收到提醒）；
 * - profileId 缺失（null/undefined）→ 同样返回 null（无档案上下文 = 不施加路由）。
 *
 * 只影响「用哪个账户发」，不影响「用哪些渠道发」：渠道选择仍由事件/规则解析，
 * 事件级 `notification_account_ids` 绑定始终最优先（见 sendNotifications）。
 */
export async function resolveProfileRoutedAccountIds(
  userId: number,
  profileId: number | null | undefined,
): Promise<Set<number> | null> {
  if (profileId == null || !Number.isInteger(Number(profileId))) return null;

  const result = await query(
    `SELECT pca.account_id
     FROM profile_channel_accounts pca
     JOIN profiles p ON p.id = pca.profile_id
     WHERE pca.profile_id = $1 AND p.user_id = $2`,
    [Number(profileId), userId],
  );
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  // 空结果（或畸形 mock）= 该档案没有显式路由 → 全部启用账户。
  if (rows.length === 0) return null;

  const ids = rows
    .map((row) => Number((row as { account_id?: unknown }).account_id))
    .filter((id) => Number.isInteger(id) && id > 0);
  return ids.length > 0 ? new Set(ids) : null;
}
