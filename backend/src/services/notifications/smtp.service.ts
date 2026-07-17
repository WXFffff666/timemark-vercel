import { getBlessing } from '@timemark/shared/blessings';
import {
  buildNaturalReminderText,
  buildReminderEmailBodies,
  buildReminderSubject,
  htmlToPlainText,
  renderPlainMarkdownToHtml,
} from '@timemark/shared';
import { createSmtpTransporter } from '../../utils/smtp-transporter.js';

export async function sendSmtpNotification(
  event: any,
  smtpHost: string,
  smtpPort: number,
  password: string,
  fromEmail: string,
  toEmail: string,
  options?: { markdownTemplate?: string | null },
): Promise<void> {
  const port = smtpPort || 587;
  const transporter = createSmtpTransporter(smtpHost, port, fromEmail, password);

  const rcCustom = event.reminderConfig?.customMessage;
  const blessing = getBlessing(
    event.type,
    rcCustom,
    event.personName,
    event.reminderRecipientName,
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

  await transporter.sendMail({
    from: fromEmail,
    to: toEmail,
    subject,
    html,
    text,
  });
}
