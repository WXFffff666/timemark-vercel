import { query } from '../db/index.js';
import { Resend } from 'resend';
import { Solar, Lunar } from 'lunar-javascript';

export async function sendReminders() {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  
  console.log('[Cron] === START sendReminders ===');
  console.log('[Cron] Current UTC time:', `${currentHour}:${currentMinute}`);
  
  try {
    const users = await query('SELECT id, username FROM users');
    if (!users.rows || users.rows.length === 0) {
      console.log('[Cron] No users found');
      return;
    }
    
    console.log('[Cron] Found users:', users.rows.length);
    
    for (const user of users.rows as any[]) {
      const configStr = process.env[`REMINDER_CONFIG_${user.id}`];
      if (!configStr) {
        console.log(`[Cron] No config for user ${user.username}`);
        continue;
      }
      
      const config = JSON.parse(configStr);
      if (!config.enabled) {
        console.log(`[Cron] Reminders disabled for user ${user.username}`);
        continue;
      }
      
      const [configHour, configMinute] = config.dailyTime.split(':').map(Number);
      
      if (currentHour !== configHour) {
        continue;
      }
      
      console.log(`[Cron] Sending reminders for user ${user.username} at ${config.dailyTime}`);
      await sendUserReminders(user.id, user.username);
    }
  } catch (error) {
    console.error('[Cron] Send reminders failed:', error);
  }
}

async function sendUserReminders(userId: string, username: string) {
  try {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      console.log('[Cron] RESEND_API_KEY missing');
      return;
    }
    
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    console.log('[Cron] Today:', todayStr);
    
    const events = await query(
      `SELECT * FROM events WHERE user_id = $1 AND date >= $2`,
      [userId, todayStr]
    );
    
    console.log('[Cron] Found events count:', events.rows?.length || 0);
    
    if (!events.rows || events.rows.length === 0) {
      console.log('[Cron] No events - EARLY RETURN');
      return;
    }
    
    const resend = new Resend(resendApiKey);
    console.log('[Cron] Resend initialized');
    
    for (const event of events.rows as any[]) {
      let targetDate = event.date;
      let age: number | null = null;
      let lunarInfo = '';
      
      if (event.type === 'birthday' && event.birth_date) {
        const birthYear = parseInt(event.birth_date.split('-')[0]);
        const currentYear = today.getFullYear();
        age = currentYear - birthYear;
        
        if (event.calendar_type === 'gregorian') {
          const [_, month, day] = event.birth_date.split('-');
          targetDate = `${currentYear}-${month}-${day}`;
          
          const solar = Solar.fromYmd(currentYear, parseInt(month), parseInt(day));
          const lunar = solar.getLunar();
          const isLeap = lunar.getMonth() < 0;
          const lunarMonth = Math.abs(lunar.getMonth());
          lunarInfo = isLeap ? `农历闰${lunarMonth}月${lunar.getDay()}日` : `农历${lunarMonth}月${lunar.getDay()}日`;
        } else {
          const [_, month, day] = event.birth_date.split('-');
          const birthMonth = parseInt(month);
          const isLeapMonth = birthMonth < 0;
          const absMonth = Math.abs(birthMonth);
          
          try {
            const lunar = Lunar.fromYmd(currentYear, birthMonth, parseInt(day));
            const solar = lunar.getSolar();
            targetDate = solar.toYmd();
            lunarInfo = isLeapMonth ? `农历闰${absMonth}月${day}日` : `农历${absMonth}月${day}日`;
          } catch {
            const lunar = Lunar.fromYmd(currentYear, absMonth, parseInt(day));
            const solar = lunar.getSolar();
            targetDate = solar.toYmd();
            lunarInfo = `农历闰${absMonth}月（今年无）→ 农历${absMonth}月${day}日`;
          }
        }
      }
      
      const eventDate = new Date(targetDate);
      const daysUntil = Math.ceil((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      
      const reminderConfig = JSON.parse(event.reminder_config || '{"enabled":false,"daysBeforeList":[]}');
      if (!reminderConfig.enabled || !reminderConfig.daysBeforeList.includes(daysUntil)) {
        console.log(`[Cron] Skipping event ${event.name}: daysUntil=${daysUntil}`);
        continue;
      }
      
      const recipients = reminderConfig.emailRecipients || [];
      const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const validRecipients = recipients
        .filter((email: string) => EMAIL_REGEX.test(email))
        .slice(0, 10);

      if (validRecipients.length === 0) {
        console.log(`[Cron] No valid recipients for event: ${event.name}`);
        continue;
      }

      console.log(`[Cron] Sending email to ${validRecipients.length} recipients`);
       
      try {
        let subject, html;
        if (event.type === 'birthday') {
          subject = `🎂 ${event.person_name || event.name} 的生日提醒`;
          html = `<h2>生日提醒</h2><p><strong>${event.person_name || event.name}</strong> 的生日还有 <strong>${daysUntil}</strong> 天</p><p><strong>年龄</strong>: ${age} 岁</p><p><strong>公历日期</strong>: ${targetDate}</p><p><strong>农历日期</strong>: ${lunarInfo}</p>${reminderConfig.customMessage ? `<p>${reminderConfig.customMessage}</p>` : ''}`;
        } else {
          subject = `提醒: ${event.name} 还有 ${daysUntil} 天`;
          html = `<h2>事件提醒</h2><p><strong>事件:</strong> ${event.name}</p><p><strong>日期:</strong> ${event.date}</p><p><strong>剩余:</strong> ${daysUntil} 天</p><p>${reminderConfig.customMessage || ''}</p>`;
        }
        
        const emailPromises = validRecipients.map(email => 
          resend.emails.send({
            from: 'TimeMark <noreply@email.the37777777.top>',
            to: [email],
            subject,
            html
          }).catch(err => ({ error: err.message, email }))
        );

        const results = await Promise.allSettled(emailPromises);
        const successful = results.filter(r => r.status === 'fulfilled').length;
        console.log(`[Cron] Sent ${successful}/${validRecipients.length} emails`);
      } catch (emailError: any) {
        console.error(`[Cron] Failed to send email:`, emailError.message);
      }
    }
  } catch (error) {
    console.error('[Cron] Send reminders failed:', error);
  }
}

export async function githubBackup() {
  console.log('[Cron] Running GitHub backup...');
  try {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      console.log('[Cron] GitHub token not configured, skipping backup');
      return;
    }
    
    const result = await query(
      'SELECT * FROM email_logs ORDER BY sent_at DESC LIMIT 100'
    );
    
    if (!result.rows || result.rows.length === 0) {
      console.log('[Cron] No email logs to backup');
      return;
    }
    
    const today = new Date().toISOString().split('T')[0];
    const filename = `timemark-email-logs-${today}.json`;
    const content = JSON.stringify(result.rows, null, 2);
    
    const response = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'TimeMark',
      },
      body: JSON.stringify({
        description: `TimeMark Email Logs - ${today}`,
        public: false,
        files: { [filename]: { content } },
      }),
    });
    
    if (response.ok) {
      console.log(`[Cron] Backed up ${result.rows.length} email logs to GitHub`);
      
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const deleteResult = await query(
        'DELETE FROM email_logs WHERE sent_at < $1',
        [thirtyDaysAgo]
      );
      
      console.log(`[Cron] Cleaned up ${deleteResult.rowCount} old email logs (>30 days)`);
    } else {
      console.error(`[Cron] GitHub backup failed: ${response.status}`);
    }
  } catch (error) {
    console.error('[Cron] GitHub backup failed:', error);
  }
}

export async function archiveLoginHistory() {
  console.log('[Cron] Running login history archive...');
  try {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      console.log('[Cron] GitHub token not configured, skipping archive');
      return;
    }
    
    const result = await query(
      'SELECT * FROM login_logs ORDER BY login_time DESC LIMIT 200'
    );
    
    if (!result.rows || result.rows.length === 0) {
      console.log('[Cron] No login logs to archive');
      return;
    }
    
    const today = new Date().toISOString().split('T')[0];
    const filename = `timemark-login-logs-${today}.json`;
    const content = JSON.stringify(result.rows, null, 2);
    
    const response = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'TimeMark',
      },
      body: JSON.stringify({
        description: `TimeMark Login History - ${today}`,
        public: false,
        files: { [filename]: { content } },
      }),
    });
    
    if (response.ok) {
      console.log(`[Cron] Archived ${result.rows.length} login logs to GitHub`);
      
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const deleteResult = await query(
        'DELETE FROM login_logs WHERE login_time < $1',
        [thirtyDaysAgo]
      );
      
      console.log(`[Cron] Cleaned up ${deleteResult.rowCount} old login logs (>30 days)`);
    } else {
      console.error(`[Cron] Login history archive failed: ${response.status}`);
    }
  } catch (error) {
    console.error('[Cron] Login history archive failed:', error);
  }
}

export async function cleanupSessions() {
  console.log('[Cron] Cleaning up expired sessions...');
  try {
    const result = await query(
      'DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP'
    );
    console.log(`[Cron] Cleaned up ${result.rowCount} expired sessions`);
  } catch (error) {
    console.error('[Cron] Session cleanup failed:', error);
  }
}
