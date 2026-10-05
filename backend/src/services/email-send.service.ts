import { Resend } from 'resend';
import { htmlToPlainText } from '@timemark/shared';
import { getNotificationAccounts } from './config.service.js';import { EMAIL_CHANNEL_TYPES } from '@timemark/shared';
import { createSmtpTransporter } from '../utils/smtp-transporter.js';

export interface EmailAccountCreds {
  id: number;
  type: string;
  name: string;
  apiKey?: string;
  fromEmail: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpPassword?: string;
}

function mapAccountToEmailCreds(account: Record<string, unknown>): EmailAccountCreds | null {
  const type = String(account.type || '');
  if (!EMAIL_CHANNEL_TYPES.has(type)) return null;

  if (type === 'resend' || type === 'email') {
    if (!account.token) return null;
    return {
      id: Number(account.id),
      type,
      name: String(account.name || type),
      apiKey: String(account.token),
      fromEmail: String(account.webhook || 'TimeMark <onboarding@resend.dev>'),
    };
  }

  if (type === 'smtp') {
    if (!account.webhook || !account.token || !account.chat_id) return null;
    return {
      id: Number(account.id),
      type,
      name: String(account.name || 'SMTP'),
      fromEmail: String(account.chat_id),
      smtpHost: String(account.webhook),
      smtpPort: parseInt(String(account.secret || '587'), 10),
      smtpPassword: String(account.token),
    };
  }

  return null;
}

export async function getEmailAccounts(userId: number): Promise<EmailAccountCreds[]> {
  const accounts = await getNotificationAccounts(userId);
  return accounts
    .filter((a) => a.is_active !== false)
    .map((a) => mapAccountToEmailCreds(a as unknown as Record<string, unknown>))
    .filter((a): a is EmailAccountCreds => a !== null);
}

export async function resolveEmailAccount(
  userId: number,
  accountId?: number,
): Promise<EmailAccountCreds> {
  const accounts = await getEmailAccounts(userId);
  if (accounts.length === 0) {
    throw new Error('请先配置邮件通知渠道（Resend 或 SMTP）');
  }
  if (accountId) {
    const found = accounts.find((a) => a.id === accountId);
    if (!found) throw new Error('指定的通知渠道账号不存在或未激活');
    return found;
  }
  return accounts[0];
}

export interface EmailAttachment {
  filename: string;
  content: Uint8Array | Buffer;
  contentType?: string;
}

export async function sendRawEmail(
  creds: EmailAccountCreds,
  to: string | string[],
  subject: string,
  html: string,
  attachments?: EmailAttachment[],
): Promise<void> {
  const body = html;
  const text = htmlToPlainText(html);
  const recipients = (Array.isArray(to) ? to : [to])
    .map((email) => String(email).trim())
    .filter((email) => email.length > 0);
  if (recipients.length === 0) {
    throw new Error('没有可用的收件人邮箱');
  }

  // v2.26: 送达性头——此前这条裸链（greeting/broadcast/联系人单发共用）完全没有
  // Reply-To/List-Unsubscribe，是 Gmail/Yahoo 批量发件三支柱（认证/投诉率/一键退订）
  // 里唯一能从代码侧补齐的缺口。Reply-To 指回发件地址（好友回信直达机主）。
  const fromAddress = creds.fromEmail;
  const deliverabilityHeaders: Record<string, string> = {
    'Reply-To': fromAddress.includes('@') ? fromAddress : 'noreply@timemark.app',
    'List-Unsubscribe': `<mailto:${fromAddress.includes('@') ? fromAddress : 'noreply@timemark.app'}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Message-ID': `<${Date.now()}-${Math.random().toString(36).slice(2, 12)}@timemark.app>`,
  };

  if (creds.type === 'resend' || creds.type === 'email') {
    const resend = new Resend(creds.apiKey!);
    const { error } = await resend.emails.send({
      from: creds.fromEmail,
      to: recipients,
      subject,
      html: body,
      text,
      headers: deliverabilityHeaders,
      ...(attachments && attachments.length > 0
        ? { attachments: attachments.map((file) => ({ filename: file.filename, content: Buffer.from(file.content) })) }
        : {}),
    });    if (error) {
      throw new Error(String((error as { message?: string }).message || error));
    }
    return;
  }

  if (creds.type === 'smtp') {
    const port = creds.smtpPort ?? 587;
    const transporter = createSmtpTransporter(
      creds.smtpHost!,
      port,
      creds.fromEmail,
      creds.smtpPassword!,
    );
    await transporter.sendMail({
      from: creds.fromEmail,
      to: recipients.join(', '),
      subject,
      html: body,
      text,
      headers: deliverabilityHeaders,
      ...(attachments && attachments.length > 0
        ? { attachments: attachments.map((file) => ({ filename: file.filename, content: Buffer.from(file.content), contentType: file.contentType })) }
        : {}),
    });
    return;
  }

  throw new Error(`不支持的邮件渠道类型: ${creds.type}`);
}
