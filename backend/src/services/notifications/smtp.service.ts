import nodemailer from 'nodemailer';
import { getBlessing } from '../../../../shared/src/blessings.js';
import { buildSmtpTransportOptions } from '@timemark/shared';
import { escapeHtml } from '../../utils/html.js';

export async function sendSmtpNotification(
  event: any,
  smtpHost: string,
  smtpPort: number,
  password: string,
  fromEmail: string,
  toEmail: string
): Promise<void> {
  const port = smtpPort || 587;
  const transporter = nodemailer.createTransport(
    buildSmtpTransportOptions(smtpHost, port, fromEmail, password),
  );

  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TimeMark 事件提醒</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 12px;
      padding: 30px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
    }
    .header {
      text-align: center;
      border-bottom: 2px solid #e0e7ff;
      padding-bottom: 20px;
      margin-bottom: 25px;
    }
    .icon {
      font-size: 48px;
      margin-bottom: 10px;
    }
    .title {
      font-size: 24px;
      font-weight: bold;
      color: #1e293b;
      margin: 0;
    }
    .event-name {
      font-size: 20px;
      color: #4f46e5;
      font-weight: 600;
      margin: 15px 0;
    }
    .info-row {
      display: flex;
      align-items: center;
      margin: 12px 0;
      padding: 10px 15px;
      background-color: #f8fafc;
      border-radius: 8px;
    }
    .info-label {
      font-weight: 600;
      color: #64748b;
      min-width: 60px;
      margin-right: 10px;
    }
    .info-value {
      color: #1e293b;
      font-weight: 500;
    }
    .blessing {
      margin-top: 25px;
      padding: 20px;
      background: linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%);
      border-radius: 10px;
      text-align: center;
      font-size: 18px;
      color: #4f46e5;
      font-weight: 600;
    }
    .blessing-icon {
      font-size: 24px;
      margin-right: 8px;
    }
    .footer {
      text-align: center;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      color: #94a3b8;
      font-size: 12px;
    }
    .footer a {
      color: #4f46e5;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="icon">📅</div>
      <h1 class="title">事件提醒</h1>
    </div>
    
    <div class="event-name">${escapeHtml(event.name)}</div>
    
    <div class="info-row">
      <span class="info-label">📆 日期</span>
      <span class="info-value">${escapeHtml(event.date)}</span>
    </div>
    
    <div class="info-row">
      <span class="info-label">🏷️ 类型</span>
      <span class="info-value">${escapeHtml(getEventTypeLabel(event.type))}</span>
    </div>
    
    <div class="blessing">
      <span class="blessing-icon">🎉</span>
      ${escapeHtml(blessing)}
    </div>
    
    <div class="footer">
      <p>由 TimeMark 智能事件提醒系统发送</p>
      <p>如需管理提醒，请<a href="#">登录您的账户</a></p>
    </div>
  </div>
</body>
</html>`;

  await transporter.sendMail({
    from: fromEmail,
    to: toEmail,
    subject: `📅 TimeMark 提醒: ${event.name}`,
    html,
  });
}

function getEventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    birthday: '生日',
    anniversary: '纪念日',
    exam: '考试',
    holiday: '节日',
    other: '其他',
  };
  return labels[type] || type;
}
