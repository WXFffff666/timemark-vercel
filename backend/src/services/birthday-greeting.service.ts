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
  | { action: 'send'; contactId: number; contactName: string; recipients: string[] }
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
      `SELECT id, name, nickname, email, contact_methods, greeting_opt_out
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

  return { action: 'send', contactId, contactName, recipients };
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
): Promise<'sent' | 'skipped' | 'duplicate' | 'failed'> {
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

  const content = buildBirthdayGreetingContent(resolution.contactName, event);
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
      JSON.stringify({ channel: 'email', recipients: result.recipients, failed: result.failed }),
    );
    if (!recorded) {
      log.error({ eventId: event.id, contactId: resolution.contactId }, 'Birthday greeting send not recorded in 提醒日志');
    }
    log.info(
      { eventId: event.id, contactId: resolution.contactId, recipients: result.recipients },
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
    log.error({ eventId: event.id, contactId: resolution.contactId, err: error }, 'Birthday greeting send failed; claim released for retry');
    return 'failed';
  }
}
