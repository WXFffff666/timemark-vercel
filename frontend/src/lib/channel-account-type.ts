/**
 * 事件渠道 ↔ notification_accounts.type
 *
 * 这两份映射以前是手抄的整表（前端各一份，后端一份），于是抄漏就变成功能故障：
 * generic_webhook / pushdeer / twilio 根本没有条目，按钮永远灰着；nextcloud_talk 被映射成
 * nextcloudtalk，而账号是按模板 id 存的，配置了也显示未配置。
 *
 * 后端 channelToAccountType 对每个渠道都是 identity，只有历史别名例外。所以这里只列别名，
 * 其余靠 identity 兜住——新增渠道不需要再改前端。
 *
 * 表的 key 一律是**规范渠道 id**（= 后端模板 id = 选择器渲染的 value），
 * value 是历史上可能已经存进库的账号 type / 事件渠道 value。
 */

/** 规范渠道 id → 历史上同义的账号 type */
const LEGACY_ACCOUNT_TYPES: Record<string, string[]> = {
  wxpusher: ['wechat', 'wechat_official'],
  qmsg: ['qq'],
  nextcloud_talk: ['nextcloudtalk'],
};

/** 账号 type → 规范渠道 id；不是任何渠道的历史别名就按 identity 走 */
const CANONICAL_BY_LEGACY_TYPE: Record<string, string> = Object.entries(LEGACY_ACCOUNT_TYPES)
  .reduce<Record<string, string>>((acc, [channelId, types]) => {
    for (const t of types) acc[t] = channelId;
    return acc;
  }, {});

/**
 * 一个渠道可能对应的账号 type，规范拼写排第一。
 * 两种拼写都留着：老库里可能已经存在另一种 type 的账号。
 */
export function accountTypesForChannel(channelId: string): string[] {
  const canonical = CANONICAL_BY_LEGACY_TYPE[channelId] ?? channelId;
  return [...new Set([canonical, channelId, ...(LEGACY_ACCOUNT_TYPES[canonical] ?? [])])];
}

/**
 * 账号 type → 事件渠道 value（contact-event-bridge 用）。
 * 必须返回**规范** id：选择器只渲染规范渠道，写入别名会让用户看不到自己已选的渠道。
 */
export function channelForAccountType(accountType: string): string {
  return CANONICAL_BY_LEGACY_TYPE[accountType] ?? accountType;
}

/**
 * 事件已保存的 channels 里是否包含该规范渠道（含历史别名）。
 * 老事件存的是 `wechat`，改用模板目录渲染后仍要显示为已勾选，否则一存就丢。
 */
export function isChannelSelected(channels: readonly string[] | undefined, channelId: string): boolean {
  if (!channels) return false;
  return accountTypesForChannel(channelId).some((t) => channels.includes(t));
}