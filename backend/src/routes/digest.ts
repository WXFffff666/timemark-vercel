import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { sendDigestForUser, buildDigestPreview, type DigestPeriod } from '../services/digest.service.js';
import { normalizeDigestSections } from '../services/digest-sections.js';
import type { User } from '@timemark/shared';

/**
 * 摘要按需发送 + 预览（checkbox 79 / 80）。
 *
 * - `POST /api/digest/send` — 登录用户为自己的账户立即生成并投递一份月度/年度摘要
 *   （Inbox 消息 + 带 PDF 附件的邮件）。cron 版本见 `GET /api/cron/digest`。
 * - `POST /api/digest/preview` — 只渲染、不发送；返回结构化摘要数据供前端在弹窗中
 *   展示真实内容（无邮件渠道也照常返回，并用 `reason` 说明缺哪一环）。
 *
 * 这是确定性渲染；带 AI 叙述的版本是 checkbox 108。
 */
const digest = new Hono<{ Variables: { user: User } }>();
digest.use('*', authMiddleware);

function parsePeriod(raw: unknown): DigestPeriod | null {
  return raw === 'monthly' || raw === 'yearly' ? raw : null;
}

digest.post('/send', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const period = parsePeriod((body as Record<string, unknown>).period ?? c.req.query('period') ?? 'monthly');
  if (!period) {
    return c.json({ success: false, error: 'period 必须是 monthly 或 yearly' }, 400);
  }

  try {
    const result = await sendDigestForUser(Number(user.id), period);
    return c.json({ success: true, data: result });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : '摘要发送失败' }, 500);
  }
});

digest.post('/preview', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const raw = body as Record<string, unknown>;
  const period = parsePeriod(raw.period ?? c.req.query('period') ?? 'monthly');
  if (!period) {
    return c.json({ success: false, error: 'period 必须是 monthly 或 yearly' }, 400);
  }

  try {
    const preview = await buildDigestPreview(Number(user.id), period, new Date(), {
      sections: raw.sections === undefined ? undefined : normalizeDigestSections(raw.sections),
      recipients: raw.recipients === undefined ? undefined : raw.recipients,
    });
    return c.json({ success: true, data: preview });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : '摘要预览失败' }, 500);
  }
});

export default digest;
