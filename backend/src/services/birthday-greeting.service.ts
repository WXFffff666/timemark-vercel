import { query } from '../db/index.js';
import { sendContactEmail } from './contact-send.service.js';
import { recordEventTrigger } from './trigger-log.service.js';
import { createLogger } from '../utils/logger.js';
import {
  BROADCAST_TEMPLATE_CATEGORIES,
  renderBroadcastTemplate,
  parseContactMethods,
  getAllContactEmails,
  EMAIL_CHANNEL_TYPES,
  composeBirthdayGreeting,
  sanitizeHtmlPreview,
} from '@timemark/shared';
import { formatLunarDateLabel } from '@timemark/shared/templates';

const log = createLogger('birthday-greeting');

/**
 * Checkbox 168: birthday greeting to the linked contact, plus the owner reminder.
 *
 * Separation contract:
 * - The OWNER reminder is the pre-existing scheduled-event path in `jobs/tasks.ts`
 *   (`sendNotifications`) and never consults anything in this module: a contact with
 *   no email / no channel still leaves the owner reminder untouched.
 * - The CONTACT greeting is an explicit owner action (the owner linked the contact to
 *   the birthday event): it is NOT counted as a proactive agent ping (no budget
 *   consumption), and it is idempotent per contact per year.
 * - The recipient list can never leave the linked contact: delivery goes through
 *   `sendContactEmail`, which re-reads the contact and enforces the same
 *   发信白名单 allow-list as the manual send route.
 */
export interface BirthdayGreetingEvent {
  id: number;
  user_id: number;
  type?: string | null;
  /** Explicit link (`events.contact_id`, migration recorded for the integrator). */
  contact_id?: number | null;
  calendar_type?: string | null;
  lunar_date?: unknown;
  /** Legacy per-event lunar birthday (JSON string or object). */
  birth_date_lunar?: unknown;
  date?: string | null;
}

export type BirthdayGreetingSkipReason =
  | 'no_contact_link'
  | 'contact_not_found'
  | 'contact_opted_out'
  | 'contact_no_email'
  | 'no_owner_email_channel'
  | 'owner_email_opt_out'
  | 'lookup_failed';

export type BirthdayGreetingResolution =
  | { action: 'send'; contactId: number; contactName: string; recipients: string[]; context?: GreetingContactContext }
  | { action: 'skip'; reason: BirthdayGreetingSkipReason; contactId?: number; hint?: string };

const CLAIM_PREFIX = 'birthday_greeting';
const CONTACT_NO_EMAIL_HINT = '该联系人没有邮箱，本次未给 TA 发送生日祝福';
const CONTACT_NOT_FOUND_HINT = '链接的联系人已不存在，本次未发送生日祝福';

function contactClaimKey(contactId: number, year: string): string {
  return `${CLAIM_PREFIX}:contact#${contactId}#${year}`;
}

function eventClaimKey(eventId: number, year: string): string {
  return `${CLAIM_PREFIX}:event#${eventId}#${year}`;
}

/**
 * Resolve whether this birthday event can greet its linked contact. Read-only:
 * never sends, never throws, never touches the owner reminder path.
 */
export async function resolveBirthdayGreeting(
  event: BirthdayGreetingEvent,
): Promise<BirthdayGreetingResolution> {
  const contactId = Number(event.contact_id);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    return { action: 'skip', reason: 'no_contact_link' };
  }

  let contact: Record<string, unknown> | undefined;
  try {
    const result = await query(
      `SELECT id, name, nickname, email, contact_methods, greeting_opt_out, relationship, gender, notes
       FROM fixed_contacts WHERE id = $1 AND user_id = $2`,
      [contactId, event.user_id],
    );
    contact = result.rows[0] as Record<string, unknown> | undefined;
  } catch (error) {
    // Feature is dark until the recorded migration lands; the owner reminder is unaffected.
    log.warn({ eventId: event.id, contactId, err: error }, 'Birthday greeting contact lookup failed');
    return { action: 'skip', reason: 'lookup_failed' };
  }
  if (!contact) {
    return { action: 'skip', reason: 'contact_not_found', contactId, hint: CONTACT_NOT_FOUND_HINT };
  }

  const contactName = String(contact.name || contact.nickname || '朋友');

  if (contact.greeting_opt_out === true) {
    return { action: 'skip', reason: 'contact_opted_out', contactId };
  }

  const methods = parseContactMethods(contact.contact_methods, {
    email: contact.email as string | null,
  });
  const recipients = getAllContactEmails(methods, contact.email as string | null);
  if (recipients.length === 0) {
    return { action: 'skip', reason: 'contact_no_email', contactId, hint: CONTACT_NO_EMAIL_HINT };
  }

  try {
    const cfg = await query(
      'SELECT email_opt_out, resend_api_key FROM user_configs WHERE user_id = $1',
      [event.user_id],
    );
    const cfgRow = (cfg.rows[0] ?? {}) as { email_opt_out?: unknown; resend_api_key?: unknown };
    if (cfgRow.email_opt_out === true) {
      return { action: 'skip', reason: 'owner_email_opt_out', contactId };
    }
    const accounts = await query(
      'SELECT type FROM notification_accounts WHERE user_id = $1 AND is_active = TRUE',
      [event.user_id],
    );
    const legacyResend = typeof cfgRow.resend_api_key === 'string' && cfgRow.resend_api_key.trim() !== '';
    const hasEmailChannel = legacyResend
      || accounts.rows.some((row) => EMAIL_CHANNEL_TYPES.has(String((row as { type?: unknown }).type ?? '')));
    if (!hasEmailChannel) {
      return { action: 'skip', reason: 'no_owner_email_channel', contactId };
    }
  } catch (error) {
    log.warn({ eventId: event.id, contactId, err: error }, 'Birthday greeting owner-channel lookup failed');
    return { action: 'skip', reason: 'lookup_failed', contactId };
  }

  return {
    action: 'send',
    contactId,
    contactName,
    recipients,
    context: {
      contactId,
      name: contactName,
      nickname: typeof contact.nickname === 'string' ? contact.nickname : null,
      relationship: typeof contact.relationship === 'string' ? contact.relationship : null,
      gender: typeof contact.gender === 'string' ? contact.gender : null,
      notes: typeof contact.notes === 'string' ? contact.notes : null,
    },
  };
}

/** Existing broadcast templates (生日祝福 category) rendered for the real contact. */
export function buildBirthdayGreetingContent(
  contactName: string,
  event: BirthdayGreetingEvent,
): { subject: string; html: string } {
  const category = BROADCAST_TEMPLATE_CATEGORIES.find((c) => c.id === 'birthday');
  const variant = category?.greetingVariants.find((v) => v.id === 'warm') ?? category?.greetingVariants[0];
  const subject = `${contactName}，生日快乐 🎂`;

  const isDualCalendar = event.calendar_type === 'lunar' || event.calendar_type === 'both';
  const lunarLabel = isDualCalendar
    ? formatLunarDateLabel(event.lunar_date ?? event.birth_date_lunar)
    : '';
  const dateYmd = String(event.date ?? '').slice(0, 10);
  const dateLine = dateYmd ? `<p>📅 ${dateYmd}${lunarLabel ? `（${lunarLabel}）` : ''}</p>` : '';

  const parts = [
    variant?.greetingHtml ?? '<p>{{contact_name}}，生日快乐！</p>',
    category?.bodyHtml ?? '',
    dateLine,
    category?.closingHtml ?? '',
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .map((part) => renderBroadcastTemplate(part, { contact_name: contactName, subject }));

  return {
    subject,
    html: `<div style="font-family:sans-serif;line-height:1.7;color:#222;font-size:15px">${parts.join('\n')}</div>`,
  };
}

// ---------------------------------------------------------------------------
// v2.25: AI 双路祝福内容（组合引擎兜底）+ draft 模式 + greeting_history
// ---------------------------------------------------------------------------

export interface GreetingContactContext {
  contactId: number;
  name: string;
  nickname?: string | null;
  relationship?: string | null;
  gender?: string | null;
  notes?: string | null;
}

export interface GreetingUserPrefs {
  greetingMode: 'auto' | 'draft';
  greetingAiEnabled: boolean;
  timezone: string;
}

const GREETING_DATELINE_HTML = (event: BirthdayGreetingEvent): string => {
  const isDualCalendar = event.calendar_type === 'lunar' || event.calendar_type === 'both';
  const lunarLabel = isDualCalendar
    ? formatLunarDateLabel(event.lunar_date ?? event.birth_date_lunar)
    : '';
  const dateYmd = String(event.date ?? '').slice(0, 10);
  return dateYmd ? `📅 ${dateYmd}${lunarLabel ? `（${lunarLabel}）` : ''}` : '';
};

/** 组合引擎路径（确定性、零依赖；预演页与 cron 共用，所见即所发） */
export function composeGreetingContentFallback(
  userId: number,
  contact: GreetingContactContext,
  event: BirthdayGreetingEvent,
): { subject: string; html: string; source: 'composer' } {
  const dateLineFull = GREETING_DATELINE_HTML(event);
  const composed = composeBirthdayGreeting({
    contactId: contact.contactId,
    year: String(event.date ?? '').slice(0, 4) || String(new Date().getFullYear()),
    name: contact.name,
    nickname: contact.nickname,
    relationship: contact.relationship,
    notes: contact.notes,
    dateLine: dateLineFull || undefined,
  });
  return { subject: composed.subject, html: composed.html, source: 'composer' };
}

/**
 * AI 路径：gateway.chat(lite) 按联系人上下文生成个性化祝福正文。
 * 任何失败（未配置 AiDisabledError / 超时 / 空输出）返回 null —— 调用方回落组合引擎，
 * 祝福永远发得出去。AI 输出只取纯文本正文（HTML 由本地拼装），并过 sanitize-html。
 */
/** v2.26: 单日 AI 祝福上限——超限自动回落组合引擎（防 API 额度被打爆/函数超时） */
export const GREETING_AI_DAILY_LIMIT = 20;

/** 当日已生成的 AI 祝福条数（greeting_history.source='ai' 且今天创建） */
export async function countAiGreetingsToday(userId: number): Promise<number> {
  try {
    const result = await query(
      `SELECT COUNT(*) AS n FROM greeting_history
       WHERE user_id = $1 AND source = 'ai' AND status IN ('sent','draft')
         AND created_at > date_trunc('day', NOW())`,
      [userId],
    );
    return Number((result.rows[0] as { n?: unknown })?.n ?? 0);
  } catch {
    return Number.MAX_SAFE_INTEGER; // 表不可用时保守视为超限
  }
}

export async function composeGreetingContentWithAi(
  userId: number,
  contact: GreetingContactContext,
  event: BirthdayGreetingEvent,
  options: { tone?: string | null } = {},
): Promise<{ subject: string; html: string; source: 'ai' } | null> {
  // 预算闸（v2.26）：当日 AI 条数超限直接回落组合引擎，调用方无感
  if ((await countAiGreetingsToday(userId)) >= GREETING_AI_DAILY_LIMIT) {
    log.info({ userId, contactId: contact.contactId }, 'AI greeting daily budget exhausted; falling back to composer');
    return null;
  }
  try {
    const { chat, AiDisabledError } = await import('./ai/gateway.js');
    const name = contact.nickname?.trim() || contact.name;
    const tone = options.tone?.trim() || '';
    const toneLine = tone ? `5. 语气要求：${tone.slice(0, 40)}。` : '';
    const relationBits = [
      contact.relationship ? `与机主关系：${contact.relationship}` : '',
      contact.gender && contact.gender !== 'unknown' ? `性别：${contact.gender === 'male' ? '男' : contact.gender === 'female' ? '女' : ''}` : '',
      contact.notes?.trim() ? `备注：${contact.notes.trim().slice(0, 120)}` : '',
    ].filter(Boolean);
    const messages = [
      {
        role: 'system' as const,
        content: [
          '你是机主的私人助手，为机主的好友写一条生日祝福。要求：',
          '1. 60-120 字，中文，温暖自然，像朋友写的，不要华丽辞藻堆砌；',
          '2. 结合给出的关系与备注信息个性化；备注是机主与对方的私事，可自然化用但不要照抄；',
          '3. 直接输出祝福正文，不要标题、不要称呼行重复姓名超过一次、不要签名、不要解释；',
          '4. 输出一行正文即可。',
          toneLine,
        ].filter(Boolean).join('\n'),
      },
      {
        role: 'user' as const,
        content: `给好友「${name}」写生日祝福。${relationBits.join('；')}`,
      },
    ];
    const result = await chat(messages, { tier: 'lite', maxTokens: 300, useCache: false });
    const trimmed = result.content.trim().slice(0, 600);
    if (!trimmed) return null;
    const composed = composeBirthdayGreeting({
      contactId: contact.contactId,
      year: String(event.date ?? '').slice(0, 4) || String(new Date().getFullYear()),
      name: contact.name,
      nickname: contact.nickname,
    });
    const sanitized = sanitizeHtmlPreview(trimmed);
    const paragraphs = sanitized
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p style="margin:0 0 14px;line-height:1.8">${p}</p>`)
      .join('');
    const dateHtml = GREETING_DATELINE_HTML(event);
    const html = [
      '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">',
      '<div style="background:linear-gradient(135deg,#a5b4fc,#818cf8);padding:28px 24px;text-align:center">',
      '<p style="margin:0;font-size:28px">🎂</p>',
      `<p style="margin:6px 0 0;font-size:18px;font-weight:600;color:#fff">${composed.subject.replace(' 🎂', '')}</p>`,
      '</div>',
      `<div style="padding:24px;background:#fff;color:#1e293b;font-size:15px">`,
      dateHtml ? `<p style="color:#64748b;font-size:13px;margin:0 0 12px">${dateHtml}</p>` : '',
      paragraphs,
      '</div>',
      '</div>',
    ].filter(Boolean).join('\n');
    return { subject: composed.subject, html, source: 'ai' };
  } catch (error) {
    const { AiDisabledError } = await import('./ai/gateway.js');
    if (!(error instanceof AiDisabledError)) {
      log.warn({ userId, contactId: contact.contactId, err: error }, 'AI greeting generation failed; falling back to composer');
    }
    return null;
  }
}

/** 读取用户祝福偏好（v79 列；行为缺省 = auto + AI 开） */
export async function getGreetingUserPrefs(userId: number): Promise<GreetingUserPrefs> {
  try {
    const result = await query(
      'SELECT greeting_mode, greeting_ai_enabled, timezone FROM user_configs WHERE user_id = $1',
      [userId],
    );
    const row = (result.rows[0] ?? {}) as { greeting_mode?: unknown; greeting_ai_enabled?: unknown; timezone?: unknown };
    const mode = String(row.greeting_mode ?? 'auto');
    return {
      greetingMode: mode === 'draft' ? 'draft' : 'auto',
      greetingAiEnabled: row.greeting_ai_enabled !== false,
      timezone: typeof row.timezone === 'string' && row.timezone ? row.timezone : 'Asia/Shanghai',
    };
  } catch {
    return { greetingMode: 'auto', greetingAiEnabled: true, timezone: 'Asia/Shanghai' };
  }
}

/**
 * 组合最终祝福内容：AI 优先（可关）→ 组合引擎兜底。
 * 单入口，cron / 预演 / 草稿共用（所见即所发）。
 */
export async function composeFinalGreeting(
  userId: number,
  contact: GreetingContactContext,
  event: BirthdayGreetingEvent,
  prefs?: GreetingUserPrefs,
  options: { tone?: string | null; aiEnabledOverride?: boolean } = {},
): Promise<{ subject: string; html: string; source: 'ai' | 'composer'; tone?: string | null }> {
  const resolved = prefs ?? await getGreetingUserPrefs(userId);
  // v2.26: 分批——tasks.ts 每 tick 传入 aiEnabledOverride=false 可把本条让给组合引擎
  const aiAllowed = resolved.greetingAiEnabled && options.aiEnabledOverride !== false;
  if (aiAllowed) {
    const ai = await composeGreetingContentWithAi(userId, contact, event, { tone: options.tone });
    if (ai) return { ...ai, tone: options.tone ?? null };
  }
  return { ...composeGreetingContentFallback(userId, contact, event), tone: options.tone ?? null };
}

/** 当年是否已有同联系人的 greeting 记录（draft 去重 / 发送幂等的第二道闸） */
export async function hasGreetingHistory(
  userId: number,
  contactId: number,
  year: string,
  statuses: string[],
): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM greeting_history
     WHERE user_id = $1 AND contact_id = $2 AND year = $3 AND status = ANY($4)
     LIMIT 1`,
    [userId, contactId, year, statuses],
  );
  return result.rows.length > 0;
}

export async function recordGreetingHistory(input: {
  userId: number;
  contactId: number | null;
  eventId: number | null;
  year: string;
  channel: string;
  status: 'sent' | 'draft' | 'failed';
  subject: string;
  bodyHtml: string;
  recipients?: string;
  source?: 'ai' | 'composer';
  tone?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO greeting_history (user_id, contact_id, event_id, year, channel, status, subject, body_html, recipients, source, tone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [input.userId, input.contactId, input.eventId, input.year, input.channel, input.status, input.subject, input.bodyHtml, input.recipients ?? null, input.source ?? 'composer', input.tone ?? null],
  );
}

/**
 * Deliver (or record the skip of) one resolved birthday greeting.
 *
 * Idempotency: a `reminder_send_claims` claim keyed by contact + year is taken BEFORE
 * any outcome, so exactly one greeting/skip row can exist per contact per year even
 * when two cron ticks race. A failed send releases the claim so the next tick retries;
 * a recorded skip holds it (the skip itself is the once-per-year outcome).
 */
export async function deliverBirthdayGreeting(
  event: BirthdayGreetingEvent,
  resolution: BirthdayGreetingResolution,
  year: string,
  options: { aiEnabledOverride?: boolean } = {},
): Promise<'sent' | 'skipped' | 'draft' | 'duplicate' | 'failed'> {
  const claimEventId = resolution.action === 'send'
    ? resolution.contactId
    : resolution.contactId ?? event.id;
  const claimKey = resolution.action === 'send'
    ? contactClaimKey(resolution.contactId, year)
    : resolution.contactId
      ? contactClaimKey(resolution.contactId, year)
      : eventClaimKey(event.id, year);

  const claim = await query(
    `INSERT INTO reminder_send_claims (event_id, trigger_date) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING event_id`,
    [claimEventId, claimKey],
  );
  if (claim.rows.length === 0) return 'duplicate';

  if (resolution.action === 'skip') {
    const recorded = await recordEventTrigger(
      event.id,
      event.user_id,
      'birthday_greeting',
      claimKey,
      'skipped',
      resolution.reason,
    );
    if (!recorded) {
      log.error({ eventId: event.id, reason: resolution.reason }, 'Birthday greeting skip not recorded in 提醒日志');
    }
    log.info({ eventId: event.id, reason: resolution.reason }, 'Birthday greeting skipped');
    return 'skipped';
  }

  // v2.25: 内容组合（AI 优先 → 组合引擎兜底）+ draft/auto 双模式。
  const contactContext: GreetingContactContext =
    resolution.context ?? { contactId: resolution.contactId, name: resolution.contactName };
  const yearOfDate = String(event.date ?? '').slice(0, 4) || year;
  const prefs = await getGreetingUserPrefs(event.user_id);

  if (prefs.greetingMode === 'draft') {
    // 草稿模式：不发送、不占年度 claim（用户确认发送时才占）；同一年已有草稿/已发送则不再重复生成。
    if (await hasGreetingHistory(event.user_id, resolution.contactId, yearOfDate, ['draft', 'sent'])) {
      return 'duplicate';
    }
    const content = await composeFinalGreeting(event.user_id, contactContext, event, prefs, {
      aiEnabledOverride: options.aiEnabledOverride,
    });
    await recordGreetingHistory({
      userId: event.user_id,
      contactId: resolution.contactId,
      eventId: event.id,
      year: yearOfDate,
      channel: 'email',
      status: 'draft',
      subject: content.subject,
      bodyHtml: content.html,
      recipients: resolution.recipients.join(', '),
      source: content.source,
      tone: content.tone,
    });
    log.info({ eventId: event.id, contactId: resolution.contactId, source: content.source }, 'Birthday greeting staged as draft');
    return 'draft';
  }

  // 自动模式：同联系同年若已记录 sent，直接视为重复（第二道幂等闸，claim 之外的兜底）。
  if (await hasGreetingHistory(event.user_id, resolution.contactId, yearOfDate, ['sent'])) {
    return 'duplicate';
  }
  const content = await composeFinalGreeting(event.user_id, contactContext, event, prefs, {
    aiEnabledOverride: options.aiEnabledOverride,
  });
  try {
    const result = await sendContactEmail(event.user_id, resolution.contactId, {
      subject: content.subject,
      html: content.html,
      recipientEmails: resolution.recipients,
    });
    const recorded = await recordEventTrigger(
      event.id,
      event.user_id,
      'birthday_greeting',
      claimKey,
      'success',
      undefined,
      JSON.stringify({ channel: 'email', source: content.source, recipients: result.recipients, failed: result.failed }),
    );
    if (!recorded) {
      log.error({ eventId: event.id, contactId: resolution.contactId }, 'Birthday greeting send not recorded in 提醒日志');
    }
    await recordGreetingHistory({
      userId: event.user_id,
      contactId: resolution.contactId,
      eventId: event.id,
      year: yearOfDate,
      channel: 'email',
      status: 'sent',
      subject: content.subject,
      bodyHtml: content.html,
      recipients: result.recipients.join(', '),
      source: content.source,
      tone: content.tone,
    });
    log.info(
      { eventId: event.id, contactId: resolution.contactId, recipients: result.recipients, source: content.source },
      'Birthday greeting sent to contact',
    );
    return 'sent';
  } catch (error) {
    await query('DELETE FROM reminder_send_claims WHERE event_id = $1 AND trigger_date = $2', [claimEventId, claimKey]);
    await recordEventTrigger(
      event.id,
      event.user_id,
      'birthday_greeting',
      claimKey,
      'failed',
      error instanceof Error ? error.message : String(error),
    );
    await recordGreetingHistory({
      userId: event.user_id,
      contactId: resolution.contactId,
      eventId: event.id,
      year: yearOfDate,
      channel: 'email',
      status: 'failed',
      subject: content.subject,
      bodyHtml: content.html,
      recipients: resolution.recipients.join(', '),
      source: content.source,
    }).catch(() => undefined);
    log.error({ eventId: event.id, contactId: resolution.contactId, err: error }, 'Birthday greeting send failed; claim released for retry');
    return 'failed';
  }
}
