/**
 * 集成 URL 的最后一段路径就是凭证本身：
 *   /api/inbox/receive/<token>       能往收件箱投递
 *   /api/webhook/receive/<token>     能建事件
 *   /api/calendar/feed/<token>.ics   能读全部事件
 *
 * 这些 URL 以前直接明文摆在设置页上，被旁观、截屏、录屏或顺手复制走都很容易，
 * 而拿到 URL 就等于拿到凭证（不需要登录态）。所以显示时默认遮罩令牌，
 * 需要肉眼核对时再临时揭示；复制按钮照旧复制完整值——遮罩只影响显示，不影响使用。
 *
 * ponytail: 只处理 URL 形态的凭证。数据库里回显的 token/secret 字段由后端负责遮罩
 * （见 GET /config/accounts 的 tokenConfigured 标志），前端不二次处理明文。
 */
export function maskCredentialInUrl(url: string): string {
  const slash = url.lastIndexOf('/');
  if (slash < 0) return '•'.repeat(8);
  const last = url.slice(slash + 1);
  // .ics 是订阅器要求的扩展名，不是凭证的一部分，留着才能看出这是个 ICS 链接
  const ext = last.endsWith('.ics') ? '.ics' : '';
  return `${url.slice(0, slash + 1)}${'•'.repeat(8)}${ext}`;
}