import { Resend } from 'resend';
import { getBlessing } from '@timemark/shared/blessings';

export async function sendEmailNotification(
  event: any,
  apiKey: string,
  fromEmail: string,
  toEmail: string
): Promise<void> {
  const resend = new Resend(apiKey);
  
  // 智能匹配祝福语：根据被提醒人(personName)和提醒人(reminderRecipientName)自动适配
  const blessing = getBlessing(
    event.type, 
    event.reminderConfig?.customMessage,
    event.personName,           // 被提醒人/事件所有者（妈妈）
    event.reminderRecipientName // 提醒人/接收通知的人（我）
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
    
    <div class="event-name">${event.name}</div>
    
    <div class="info-row">
      <span class="info-label">📆 日期</span>
      <span class="info-value">${event.date}</span>
    </div>
    
    <div class="info-row">
      <span class="info-label">🏷️ 类型</span>
      <span class="info-value">${getEventTypeLabel(event.type)}</span>
    </div>
    
    <div class="blessing">
      <span class="blessing-icon">🎉</span>
      ${blessing}
    </div>
    
    <div class="footer">
      <p>由 TimeMark 智能事件提醒系统发送</p>
      <p>如需管理提醒，请<a href="#">登录您的账户</a></p>
    </div>
  </div>
</body>
</html>`;

  const { error } = await resend.emails.send({
    from: fromEmail,
    to: toEmail,
    subject: `📅 TimeMark 提醒: ${event.name}`,
    html,
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }
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

export async function sendSecurityAlertEmail(
  params: {
    adminEmails: string[];
    username: string;
    ip: string;
    userAgent: string;
    failureCount: number;
    locked: boolean;
  },
  apiKey: string,
  fromEmail: string
): Promise<void> {
  const resend = new Resend(apiKey);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TimeMark 安全告警</title>
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
      border-top: 4px solid #dc2626;
    }
    .header {
      text-align: center;
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
      color: #dc2626;
      margin: 0;
    }
    .alert-box {
      background-color: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
    }
    .alert-title {
      font-weight: 600;
      color: #991b1b;
      margin-bottom: 10px;
      font-size: 16px;
    }
    .info-row {
      display: flex;
      align-items: flex-start;
      margin: 12px 0;
      padding: 12px 15px;
      background-color: #f8fafc;
      border-radius: 8px;
    }
    .info-label {
      font-weight: 600;
      color: #64748b;
      min-width: 100px;
      margin-right: 15px;
    }
    .info-value {
      color: #1e293b;
      flex: 1;
      word-break: break-all;
    }
    .highlight {
      color: #dc2626;
      font-weight: 600;
    }
    .status-locked {
      display: inline-block;
      background-color: #dc2626;
      color: white;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }
    .status-warning {
      display: inline-block;
      background-color: #f59e0b;
      color: white;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }
    .footer {
      text-align: center;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      color: #94a3b8;
      font-size: 12px;
    }
    .timestamp {
      text-align: center;
      color: #94a3b8;
      font-size: 14px;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="icon">🛡️</div>
      <h1 class="title">安全告警</h1>
    </div>
    
    <div class="alert-box">
      <div class="alert-title">⚠️ 检测到异常登录行为</div>
      <p>用户 <strong>${params.username}</strong> 的账户在短时间内发生了多次失败的登录尝试。</p>
    </div>
    
    <div class="info-row">
      <span class="info-label">👤 用户名</span>
      <span class="info-value">${params.username}</span>
    </div>
    
    <div class="info-row">
      <span class="info-label">🌐 IP 地址</span>
      <span class="info-value">${params.ip}</span>
    </div>
    
    <div class="info-row">
      <span class="info-label">💻 设备信息</span>
      <span class="info-value">${params.userAgent}</span>
    </div>
    
    <div class="info-row">
      <span class="info-label">❌ 失败次数</span>
      <span class="info-value highlight">${params.failureCount} 次</span>
    </div>
    
    <div class="info-row">
      <span class="info-label">🔒 账户状态</span>
      <span class="info-value">
        ${params.locked 
          ? '<span class="status-locked">已锁定</span>' 
          : '<span class="status-warning">警告中</span>'}
      </span>
    </div>
    
    <div class="timestamp">
      告警时间: ${new Date().toLocaleString('zh-CN')}
    </div>
    
    <div class="footer">
      <p>由 TimeMark 安全系统自动发送</p>
      <p>如非本人操作，请立即检查账户安全</p>
    </div>
  </div>
</body>
</html>`;

  const { error } = await resend.emails.send({
    from: fromEmail,
    to: params.adminEmails,
    subject: `🛡️ TimeMark 安全告警: ${params.username} 登录异常`,
    html,
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }
}
