import { Cron } from 'croner';
import { sendReminders, githubBackup, archiveLoginHistory, cleanupSessions } from '../jobs/tasks.js';

let jobs: Cron[] = [];

export async function startScheduler(): Promise<void> {
  // 每分钟运行一次提醒检查（北京时间）
  // 使用15分钟窗口匹配，确保不会错过提醒时间
  jobs.push(new Cron('* * * * *', { timezone: 'Asia/Shanghai', name: 'reminder-check' }, async () => {
    try {
      console.log('[Scheduler] Running reminder check...');
      await sendReminders();
    } catch (error) {
      console.error('[Scheduler] Reminder job failed:', error);
    }
  }));

  // 每天凌晨2点备份邮件日志（北京时间）
  jobs.push(new Cron('0 2 * * *', { timezone: 'Asia/Shanghai', name: 'daily-email-backup' }, async () => {
    try {
      console.log('[Scheduler] Running email backup...');
      await githubBackup();
    } catch (error) {
      console.error('[Scheduler] Email backup failed:', error);
    }
  }));

  // 每天凌晨3点归档登录历史（北京时间）
  jobs.push(new Cron('0 3 * * *', { timezone: 'Asia/Shanghai', name: 'daily-login-backup' }, async () => {
    try {
      console.log('[Scheduler] Running login archive...');
      await archiveLoginHistory();
    } catch (error) {
      console.error('[Scheduler] Login archive failed:', error);
    }
  }));

  // 每小时清理过期会话（北京时间）
  jobs.push(new Cron('0 * * * *', { timezone: 'Asia/Shanghai', name: 'hourly-cleanup' }, async () => {
    try {
      console.log('[Scheduler] Running session cleanup...');
      await cleanupSessions();
    } catch (error) {
      console.error('[Scheduler] Session cleanup failed:', error);
    }
  }));

  console.log(`[Scheduler] Started with ${jobs.length} recurring jobs (Asia/Shanghai timezone)`);
}

export async function stopScheduler(): Promise<void> {
  for (const job of jobs) {
    job.stop();
  }
  jobs = [];
  console.log('[Scheduler] Stopped');
}
