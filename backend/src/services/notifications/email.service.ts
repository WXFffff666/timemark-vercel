import { Resend } from 'resend';
import { getBlessing } from '@timemark/shared/blessings';
import {
  buildNaturalReminderText,
  buildReminderEmailBodies,
  buildReminderSubject,
  buildStyledReminderEmailBodies,
  formatLunarDateLabel,
  htmlToPlainText,
  normalizeEmailTemplateStyle,
  renderPlainMarkdownToHtml,
} from '@timemark/shared';
import { escapeHtml } from '../../utils/html.js';

export async function sendEmailNotification(
  event: any,
  apiKey: string,
  fromEmail: string,
  toEmail: string,
  idempotencyKey?: string,
  options?: { bcc?: string[]; markdownTemplate?: string | null; templateStyle?: string | null },
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
  // checkbox 169: 双历展示。农历标签原样读自持久化的 lunar_date（绝不重算），
  // 仅 lunar/both 事件会带上；公历事件 calendarType='gregorian' → 输出逐字节不变。
  const lunarLabel = formatLunarDateLabel(event.lunar_date);
  const calendarType = String(event.calendar_type ?? event.calendarType ?? 'gregorian');

  const subject = buildReminderSubject(eventName, eventType, eventDate, lunarLabel, calendarType);

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
        lunarDate: lunarLabel || undefined,
        calendarType,
      }),
    };
    html = renderPlainMarkdownToHtml(options.markdownTemplate, vars);
    text = htmlToPlainText(html);
  } else {
    // v78: 模板风格可选（classic=旧模板逐字节不变；card/minimal 为新模板）。
    const bodies = buildStyledReminderEmailBodies(
      {
        name: eventName,
        date: eventDate,
        type: eventType,
        blessing,
        customMessage: customMessage || undefined,
        lunarDate: lunarLabel || undefined,
        calendarType,
      },
      normalizeEmailTemplateStyle(options?.templateStyle),
    );
    html = bodies.html;
    text = bodies.text;
  }

  // 送达性头：Reply-To 指回发件地址（个人提醒无需收回复）；List-Unsubscribe 用
  // 一键退订语法（RFC 8058）。个人单用户部署没有真正的退订端点，用 mailto: 形式
  // —— Gmail/Yahoo 认可 mailto: 退订头，缺头反而更容易被判为营销邮件。
  const fromAddress = String(fromEmail);
  const deliverabilityHeaders: Record<string, string> = {
    'Reply-To': fromAddress.includes('@') ? fromAddress : 'noreply@timemark.app',
    'List-Unsubscribe': `<mailto:${fromAddress.includes('@') ? fromAddress : 'noreply@timemark.app'}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'X-Entity-Ref-ID': `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };

  const { error } = await resend.emails.send({
    from: fromAddress,
    to: String(toEmail),
    ...(options?.bcc?.length ? { bcc: options.bcc } : {}),
    subject,
    html,
    text,
    headers: {
      ...deliverabilityHeaders,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
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
