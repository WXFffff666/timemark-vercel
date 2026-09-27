/**
 * 周期摘要的区块键（checkbox 80）。
 *
 * - 单一事实来源：后端用它做校验/过滤，前端渲染时用同一套 key 做标签映射
 *   （`frontend/src/components/digest/DigestSettings.tsx`）。
 * - **空选择即「全部」**：`[]` / null / 非法值都会被归一化为 `null`（= 全部区块），
 *   这样即使用户把区块全部取消勾选，也绝不会渲染出一份空摘要
 *   （`selectDigestSections` 对 null 直接原样返回）。
 * - 收件人覆盖在此处清洗：拆分多个分隔符、丢弃非邮箱 / 含控制字符（CR/LF/尖括号）/
 *   超长项，去重并封顶，保证恶意字符串不可能进入邮件收件人头部。
 */

export const DIGEST_SECTION_KEYS = [
  'upcoming',
  'overdue',
  'spend',
  'habits',
  'medications',
  'maintenance',
  'goals',
] as const;

export type DigestSectionKey = (typeof DIGEST_SECTION_KEYS)[number];

export function isDigestSectionKey(value: unknown): value is DigestSectionKey {
  return typeof value === 'string' && (DIGEST_SECTION_KEYS as readonly string[]).includes(value);
}

/** `[]` / 非法 / 全非法 → null（= 全部）；否则按固定顺序返回去重后的合法 key。 */
export function normalizeDigestSections(raw: unknown): DigestSectionKey[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<DigestSectionKey>();
  for (const item of raw) {
    if (isDigestSectionKey(item)) seen.add(item);
  }
  const list = DIGEST_SECTION_KEYS.filter((key) => seen.has(key));
  return list.length > 0 ? [...list] : null;
}

/**
 * 收件人覆盖清洗。接受字符串数组；每个元素可再按逗号/分号/空白拆多个地址。
 * 只有形如 `a@b.c` 的地址保留；CR/LF/`<`/`>` 一律丢弃；去重；最多 20 条。
 */
export function sanitizeDigestRecipients(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    // Reject the WHOLE element when it carries header-injection characters, so a
    // `\r\n` payload can never be re-split into a valid-looking address.
    if (/[\r\n<>]/.test(item)) continue;
    for (const part of item.split(/[,，;；\s]+/)) {
      const email = part.trim().toLowerCase();
      if (!email || email.length > 254) continue;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      if (!out.includes(email)) out.push(email);
    }
  }
  return out.slice(0, 20);
}
