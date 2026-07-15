import { Resend } from 'resend';
import { query } from '../db/index.js';
import { getUserConfig, getNotificationAccounts } from './config.service.js';
import { getContactsByIds, listFixedContacts } from './contact.service.js';
import { escapeHtml } from '../utils/html.js';
import type { BroadcastEmailInput } from '@timemark/shared';

async function resolveRecipients(userId: number, input: BroadcastEmailInput): Promise<string[]> {
  const emails = new Set<string>();
  if (input.recipientEmails) {
    for (const e of input.recipientEmails) emails.add(e.toLowerCase());
  }
  if (input.contactIds?.length) {
    const contacts = await getContactsByIds(userId, input.contactIds);
    for (const c of contacts) {
      if (c.email) emails.add(String(c.email).toLowerCase());
    }
  }
  if (input.useAllContacts) {
    const all = await listFixedContacts(userId);
    for (const c of all) {
      if (c.email) emails.add(String(c.email).toLowerCase());
    }
  }
  return [...emails];
}

async function getResendApiKey(userId: number): Promise<{ apiKey: string; fromEmail: string } | null> {
  const accounts = await getNotificationAccounts(userId);
  const resend = accounts.find((a) => a.type === 'resend' && a.is_active && a.token);
  if (resend?.token) {
    return {
      apiKey: resend.token,
      fromEmail: resend.webhook || 'TimeMark <onboarding@resend.dev>',
    };
  }
  const config = await getUserConfig(userId);
  if (config?.resend_api_key) {
    return { apiKey: config.resend_api_key, fromEmail: 'TimeMark <onboarding@resend.dev>' };
  }
  return null;
}

export async function sendBroadcastEmail(userId: number, input: BroadcastEmailInput) {
  const recipients = await resolveRecipients(userId, input);
  if (recipients.length === 0) {
    throw new Error('没有有效的收件人邮箱');
  }
  if (recipients.length > 500) {
    throw new Error('单次最多发送 500 封邮件');
  }

  const creds = await getResendApiKey(userId);
  if (!creds) {
    throw new Error('请先配置 Resend 邮件通知账户');
  }

  const campaign = await query(
    `INSERT INTO broadcast_campaigns (user_id, subject, body_html, recipient_count, status, recipient_source)
     VALUES ($1, $2, $3, $4, 'sending', $5) RETURNING id`,
    [
      userId,
      input.subject,
      input.html,
      recipients.length,
      input.useAllContacts ? 'all_contacts' : input.contactIds?.length ? 'contacts' : 'manual',
    ],
  );
  const campaignId = campaign.rows[0].id as number;

  const resend = new Resend(creds.apiKey);
  const batchSize = 100;
  let successCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  const footer = `<p style="font-size:12px;color:#94a3b8;margin-top:24px">由 TimeMark 发送 · 如需退订请联系管理员</p>`;

  for (let i = 0; i < recipients.length; i += batchSize) {
    const chunk = recipients.slice(i, i + batchSize);
    const payload = chunk.map((to) => ({
      from: creds.fromEmail,
      to: [to],
      subject: input.subject,
      html: `${input.html}${footer}`,
    }));

    try {
      const { error } = await resend.batch.send(payload, {
        headers: { 'x-batch-validation': 'permissive' },
      } as Parameters<typeof resend.batch.send>[1]);

      if (error) {
        failedCount += chunk.length;
        errors.push(String((error as { message?: string }).message || error));
      } else {
        successCount += chunk.length;
      }

      for (const to of chunk) {
        await query(
          `INSERT INTO email_logs (recipient, status, message_id, broadcast_id) VALUES ($1, $2, $3, $4)`,
          [to, error ? 'failed' : 'sent', null, campaignId],
        ).catch(() => {});
      }
    } catch (err) {
      failedCount += chunk.length;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const status = failedCount === recipients.length ? 'failed' : failedCount > 0 ? 'partial' : 'completed';
  await query(
    `UPDATE broadcast_campaigns SET success_count = $1, failed_count = $2, status = $3, completed_at = CURRENT_TIMESTAMP WHERE id = $4`,
    [successCount, failedCount, status, campaignId],
  );

  return {
    campaignId,
    recipientCount: recipients.length,
    successCount,
    failedCount,
    status,
    errors: errors.slice(0, 10),
  };
}

export async function listBroadcastCampaigns(userId: number) {
  const result = await query(
    `SELECT id, subject, recipient_count, success_count, failed_count, status, created_at, completed_at
     FROM broadcast_campaigns WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId],
  );
  return result.rows;
}

export function renderBroadcastPreview(subject: string, html: string) {
  return {
    subject: escapeHtml(subject),
    htmlPreview: html.slice(0, 2000),
  };
}
