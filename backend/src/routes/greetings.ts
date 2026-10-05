import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';
import {
  getGreetingUserPrefs,
  composeFinalGreeting,
  hasGreetingHistory,
  recordGreetingHistory,
  type GreetingContactContext,
  type BirthdayGreetingEvent,
} from '../services/birthday-greeting.service.js';
import { sendContactEmail } from '../services/contact-send.service.js';
import { getNotificationAccounts } from '../services/config.service.js';
import { EMAIL_CHANNEL_TYPES, formatZodError } from '@timemark/shared';

const greetings = new Hono<{ Variables: { user: User } }>();

greetings.use('*', authMiddleware);

function yearOfToday(): string {
  return String(new Date().getFullYear());
}

/** 预演窗口内的 MM-DD 匹配（含闰年 02-29 简化处理：非闰年落到 02-28） */
function dateWithinWindow(monthDay: string | null, days: number): number | null {
  if (!monthDay) return null;
  const now = new Date();
  for (let i = 0; i <= days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (md === monthDay) return i;
  }
  return null;
}

// GET /settings — 祝福偏好 + AI 网关可用性
greetings.get('/settings', async (c) => {
  const user = c.get('user');
  const prefs = await getGreetingUserPrefs(Number(user.id));
  let aiConfigured = false;
  try {
    const { getAiStatus } = await import('../services/ai/gateway.js');
    const status = getAiStatus();
    aiConfigured = Boolean(status?.provider);
  } catch {
    aiConfigured = false;
  }
  return c.json({
    success: true,
    data: {
      greetingMode: prefs.greetingMode,
      greetingAiEnabled: prefs.greetingAiEnabled,
      aiConfigured,
    },
  });
});

const settingsSchema = z.object({
  greetingMode: z.enum(['auto', 'draft']),
  greetingAiEnabled: z.boolean(),
});

// POST /settings — 更新祝福偏好
greetings.post('/settings', async (c) => {
  const user = c.get('user');
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error) }, 400);
  }
  const { greetingMode, greetingAiEnabled } = parsed.data;
  await query(
    `INSERT INTO user_configs (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET
       greeting_mode = $2, greeting_ai_enabled = $3, updated_at = CURRENT_TIMESTAMP`,
    [Number(user.id), greetingMode, greetingAiEnabled],
  );
  return c.json({ success: true });
});

// GET /preview?days=30 — 未来 N 天将发祝福的联系人 + 预生成内容（组合引擎确定性预览）
greetings.get('/preview', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const days = Math.min(Math.max(parseInt(c.req.query('days') || '30', 10) || 30, 1), 90);
  const prefs = await getGreetingUserPrefs(userId);

  // 双来源：链接生日事件的联系人（主路）+ 直存 birth_date 的联系人（v79）
  const eventsRes = await query(
    `SELECT e.id, e.user_id, e.contact_id, e.date, e.calendar_type, e.lunar_date, e.birth_date_lunar,
            fc.name, fc.nickname, fc.relationship, fc.notes, fc.gender, fc.greeting_opt_out
     FROM events e
     JOIN fixed_contacts fc ON fc.id = e.contact_id AND fc.user_id = e.user_id
     WHERE e.user_id = $1 AND e.type = 'birthday' AND e.contact_id IS NOT NULL`,
    [userId],
  );
  const contactsRes = await query(
    `SELECT fc.id, fc.name, fc.nickname, fc.relationship, fc.notes, fc.gender,
            fc.birth_date, fc.greeting_opt_out,
            (SELECT COUNT(*) FROM events e2 WHERE e2.contact_id = fc.id AND e2.type = 'birthday') AS linked_events
     FROM fixed_contacts fc
     WHERE fc.user_id = $1 AND fc.birth_date IS NOT NULL`,
    [userId],
  );

  type PreviewRow = {
    contactId: number;
    name: string;
    eventId: number | null;
    daysUntil: number;
    dateLine: string;
    optedOut: boolean;
    email: string | null;
  };
  const rows: PreviewRow[] = [];
  const seenContacts = new Set<number>();

  for (const e of eventsRes.rows as Array<Record<string, unknown>>) {
    const contactId = Number(e.contact_id);
    const md = String(e.date ?? '').slice(5, 10);
    const daysUntil = dateWithinWindow(md, days);
    if (daysUntil === null || seenContacts.has(contactId)) continue;
    seenContacts.add(contactId);
    const event = e as unknown as BirthdayGreetingEvent;
    // v2.26 预演一致性：走 composeFinalGreeting 单入口（AI 开=真实 AI 文案，关/超限=组合引擎），
    // 消除"所见非所发"；AI 日预算闸在 service 内生效，预演不会打爆额度。
    const composed = await composeFinalGreeting(
      userId,
      { contactId, name: String(e.name ?? ''), nickname: e.nickname as string | null, relationship: e.relationship as string | null, notes: e.notes as string | null },
      event,
    );
    rows.push({
      contactId,
      name: String(e.name ?? ''),
      eventId: Number(e.id),
      daysUntil,
      dateLine: md,
      optedOut: e.greeting_opt_out === true,
      email: null,
      ...({ preview: composed } as object),
    });
  }
  for (const fc of contactsRes.rows as Array<Record<string, unknown>>) {
    const contactId = Number(fc.id);
    if (seenContacts.has(contactId)) continue;
    const md = String(fc.birth_date ?? '').slice(5, 10);
    const daysUntil = dateWithinWindow(md, days);
    if (daysUntil === null) continue;
    seenContacts.add(contactId);
    const composed = await composeFinalGreeting(
      userId,
      { contactId, name: String(fc.name ?? ''), nickname: fc.nickname as string | null, relationship: fc.relationship as string | null, notes: fc.notes as string | null },
      { id: 0, user_id: userId, date: `${yearOfToday()}-${md}` },
    );
    rows.push({
      contactId,
      name: String(fc.name ?? ''),
      eventId: null,
      daysUntil,
      dateLine: md,
      optedOut: fc.greeting_opt_out === true,
      email: null,
      ...({ preview: composed } as object),
    });
  }

  rows.sort((a, b) => a.daysUntil - b.daysUntil);
  return c.json({
    success: true,
    data: {
      greetingMode: prefs.greetingMode,
      greetingAiEnabled: prefs.greetingAiEnabled,
      windowDays: days,
      rows,
    },
  });
});

// GET /history?year= — 祝福历史
greetings.get('/history', async (c) => {
  const user = c.get('user');
  const year = c.req.query('year') || yearOfToday();
  if (!/^\d{4}$/.test(year)) {
    return c.json({ success: false, error: 'year 必须是 4 位年份' }, 400);
  }
  const result = await query(
    `SELECT g.id, g.contact_id, g.event_id, g.year, g.channel, g.status, g.subject,
            left(g.body_html, 400) AS body_preview, g.recipients, g.source, g.created_at,
            fc.name AS contact_name
     FROM greeting_history g
     LEFT JOIN fixed_contacts fc ON fc.id = g.contact_id
     WHERE g.user_id = $1 AND g.year = $2
     ORDER BY g.created_at DESC
     LIMIT 100`,
    [Number(user.id), year],
  );
  return c.json({ success: true, data: { year, rows: result.rows } });
});

const aiPreviewSchema = z.object({
  contactId: z.number().int().positive(),
  eventId: z.number().int().nonnegative().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tone: z.string().max(40).optional(),
});

// POST /preview-ai — 单条 AI 预览 / 草稿换一版（用户点按触发，单次一条，
// 受 AI 日预算闸约束；预演列表自动部分仍是 composeFinalGreeting 单入口）。
greetings.post('/preview-ai', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const parsed = aiPreviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error) }, 400);
  }
  const { contactId, tone } = parsed.data;
  const date = parsed.data.date || `${yearOfToday()}-01-01`;
  const eventId = parsed.data.eventId ?? 0;

  const contactRes = await query(
    `SELECT id, name, nickname, relationship, gender, notes, greeting_opt_out
     FROM fixed_contacts WHERE id = $1 AND user_id = $2`,
    [contactId, userId],
  );
  const contact = contactRes.rows[0] as Record<string, unknown> | undefined;
  if (!contact) return c.json({ success: false, error: '联系人不存在' }, 404);
  if (contact.greeting_opt_out === true) {
    return c.json({ success: false, error: '该联系人已退出祝福' }, 400);
  }

  const prefs = await getGreetingUserPrefs(userId);
  if (!prefs.greetingAiEnabled) {
    return c.json({ success: false, error: 'AI 个性化生成未开启（设置 → 生日祝福）' }, 400);
  }

  const content = await composeFinalGreeting(
    userId,
    {
      contactId,
      name: String(contact.name ?? ''),
      nickname: contact.nickname as string | null,
      relationship: contact.relationship as string | null,
      gender: contact.gender as string | null,
      notes: contact.notes as string | null,
    },
    { id: eventId, user_id: userId, date },
    prefs,
    { tone },
  );
  return c.json({
    success: true,
    data: { subject: content.subject, html: content.html, source: content.source, tone: tone ?? null },
  });
});

const sendDraftSchema = z.object({ draftId: z.number().int().positive() });

// POST /send-draft — 发送一条草稿（占年度 claim → 白名单投递 → history 更新为 sent）
greetings.post('/send-draft', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const parsed = sendDraftSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error) }, 400);
  }
  const draftId = parsed.data.draftId;
  const draftRes = await query(
    `SELECT id, contact_id, event_id, year, subject, body_html, recipients
     FROM greeting_history
     WHERE id = $1 AND user_id = $2 AND status = 'draft'`,
    [draftId, userId],
  );
  const draft = draftRes.rows[0] as
    | { id: number; contact_id: number; event_id: number | null; year: string; subject: string; body_html: string; recipients: string }
    | undefined;
  if (!draft) return c.json({ success: false, error: '草稿不存在或已处理' }, 404);

  const contactId = Number(draft.contact_id);
  // 占年度 claim（与自动路径同一把锁，防重复）
  const claimKey = `birthday_greeting:contact#${contactId}#${draft.year}`;
  const claim = await query(
    `INSERT INTO reminder_send_claims (event_id, trigger_date) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING event_id`,
    [contactId, claimKey],
  );
  if (claim.rows.length === 0) {
    return c.json({ success: false, error: '该联系人今年的祝福已处理' }, 409);
  }
  try {
    const recipients = draft.recipients.split(',').map((r) => r.trim()).filter(Boolean);
    const result = await sendContactEmail(userId, contactId, {
      subject: draft.subject,
      html: draft.body_html,
      recipientEmails: recipients,
    });
    await query(
      `UPDATE greeting_history SET status = 'sent', created_at = CURRENT_TIMESTAMP, recipients = $2
       WHERE id = $1`,
      [draftId, result.recipients.join(', ') || draft.recipients],
    );
    if (draft.event_id) {
      await query(
        `INSERT INTO event_trigger_logs (event_id, user_id, trigger_type, trigger_date, status, channel_results)
         VALUES ($1, $2, 'birthday_greeting', $3, 'success', $4)`,
        [draft.event_id, userId, claimKey, JSON.stringify({ channel: 'email', recipients: result.recipients })],
      );
    }
    return c.json({ success: true, data: { recipients: result.recipients, failed: result.failed } });
  } catch (error) {
    await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [contactId, claimKey]);
    return c.json({ success: false, error: error instanceof Error ? error.message : '发送失败' }, 500);
  }
});

// POST /discard-draft — 丢弃草稿
greetings.post('/discard-draft', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const draftId = Number(body.draftId);
  if (!Number.isInteger(draftId) || draftId <= 0) {
    return c.json({ success: false, error: '缺少有效的 draftId' }, 400);
  }
  const result = await query(
    `DELETE FROM greeting_history WHERE id = $1 AND user_id = $2 AND status = 'draft'`,
    [draftId, Number(user.id)],
  );
  if (result.rowCount === 0) return c.json({ success: false, error: '草稿不存在' }, 404);
  return c.json({ success: true });
});

// GET /channels-check — 祝福投递能力自检（联系人邮箱/机主邮件渠道）
greetings.get('/channels-check', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const accounts = await getNotificationAccounts(userId);
  const hasEmailChannel = accounts.some(
    (a) => a.is_active !== false && EMAIL_CHANNEL_TYPES.has(String(a.type)),
  );
  const contactsRes = await query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE (email IS NOT NULL AND email <> '') OR contact_methods::text LIKE '%@%') AS with_email,
            COUNT(*) FILTER (WHERE birth_date IS NOT NULL) AS with_birth_date,
            COUNT(*) FILTER (WHERE greeting_opt_out) AS opted_out
     FROM fixed_contacts WHERE user_id = $1`,
    [userId],
  );
  return c.json({
    success: true,
    data: {
      ownerEmailChannel: hasEmailChannel,
      contacts: contactsRes.rows[0],
    },
  });
});

export default greetings;
