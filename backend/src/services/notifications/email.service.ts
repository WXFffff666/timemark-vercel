import { Resend } from 'resend';
import { getBlessing } from '@timemark/shared/blessings';
import {
  buildNaturalReminderText,
  buildReminderEmailBodies,
  buildReminderSubject,
  htmlToPlainText,
  renderPlainMarkdownToHtml,
} from '@timemark/shared';
import { escapeHtml } from '../../utils/html.js';

export async function sendEmailNotification(
  event: any,
  apiKey: string,
  fromEmail: string,
  toEmail: string,
  idempotencyKey?: string,
  options?: { bcc?: string[]; markdownTemplate?: string | null },
): Promise<void> {
  const resend = new Resend(String(apiKey));

  const rc = event.reminderConfig || event.reminder_config;
  const rcCustom =
    typeof rc === 'object' && rc && 'customMessage' in rc
      ? String((rc as { customMessage?: unknown }).customMessage || '')
      : '';

  const blessing = getBlessing(
    String(event.type || 'other'),
    rcCustom || undefined,
    event.personName != null ? String(event.personName) : event.person_name != null ? String(event.person_name) : undefined,
    event.reminderRecipientName != null
      ? String(event.reminderRecipientName)
      : event.reminder_recipient_name != null
        ? String(event.reminder_recipient_name)
        : undefined,
  );

  const eventName = String(event.name ?? '');
  const eventDate = String(event.date ?? '');
  const eventType = String(event.type ?? 'other');
  const customMessage = String(event.customMessage || rcCustom || '').trim();

  const subject = buildReminderSubject(eventName, eventType, eventDate);

  let html: string;
  let text: string;

  if (options?.markdownTemplate?.trim()) {
    const vars = {
      name: eventName,
      date: eventDate,
      type: eventType,
      blessing,
      message: customMessage || buildNaturalReminderText({
        name: eventName,
        date: eventDate,
        type: eventType,
        blessing,
        customMessage,
      }),
    };
    html = renderPlainMarkdownToHtml(options.markdownTemplate, vars);
    text = htmlToPlainText(html);
  } else {
    const bodies = buildReminderEmailBodies({
      name: eventName,
      date: eventDate,
      type: eventType,
      blessing,
      customMessage: customMessage || undefined,
    });
    html = bodies.html;
    text = bodies.text;
  }

  const { error } = await resend.emails.send({
    from: String(fromEmail),
    to: String(toEmail),
    ...(options?.bcc?.length ? { bcc: options.bcc } : {}),
    subject,
    html,
    text,
    ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }
}

export async function sendSecurityAlertEmail(
  params: {
    adminEmails: string[];
    username: string;
    ip: string;
    userAgent: string;
    failureCount: number;
    locked: boolean;
    alertType?: 'login_failure' | 'new_device' | 'password_change';
  },
  apiKey: string,
  fromEmail: string,
): Promise<void> {
  const resend = new Resend(apiKey);

  const alertType = params.alertType || 'login_failure';
  const titles: Record<string, string> = {
    login_failure: '登录异常',
    new_device: '新设备登录',
    password_change: '密码已修改',
  };
  const title = titles[alertType] || '安全通知';

  const text = [
    `${title}`,
    ``,
    `账户：${params.username}`,
    `IP：${params.ip}`,
    `设备：${params.userAgent}`,
    params.failureCount ? `失败次数：${params.failureCount}` : '',
    params.locked !== undefined ? `状态：${params.locked ? '已锁定' : '警告'}` : '',
    ``,
    `时间：${new Date().toLocaleString('zh-CN')}`,
    `如非本人操作，请尽快检查账户安全。`,
  ]
    .filter(Boolean)
    .join('\n');

  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#222;white-space:pre-wrap">${escapeHtml(text)}</body></html>`;

  const { error } = await resend.emails.send({
    from: fromEmail,
    to: params.adminEmails,
    subject: `账户安全：${params.username} · ${title}`,
    html,
    text,
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }
}
