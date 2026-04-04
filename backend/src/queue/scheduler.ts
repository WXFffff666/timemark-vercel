import { reminderQueue, backupQueue, cleanupQueue } from './queues.js';

export async function startScheduler() {
  // 每小时运行一次提醒检查（北京时间）
  await reminderQueue.add({}, {
    repeat: { cron: '0 * * * *', tz: 'Asia/Shanghai' },
    jobId: 'hourly-reminders',
  });

  // 每天凌晨2点备份邮件日志（北京时间）
  await backupQueue.add('email-logs', {}, {
    repeat: { cron: '0 2 * * *', tz: 'Asia/Shanghai' },
    jobId: 'daily-email-backup',
  });

  // 每天凌晨3点归档登录历史（北京时间）
  await backupQueue.add('login-logs', {}, {
    repeat: { cron: '0 3 * * *', tz: 'Asia/Shanghai' },
    jobId: 'daily-login-backup',
  });

  // 每小时清理过期会话（北京时间）
  await cleanupQueue.add({}, {
    repeat: { cron: '0 * * * *', tz: 'Asia/Shanghai' },
    jobId: 'hourly-cleanup',
  });

  console.log('[Bull] Scheduler started with 4 recurring jobs (Asia/Shanghai timezone)');
}

export async function stopScheduler() {
  await reminderQueue.close();
  await backupQueue.close();
  await cleanupQueue.close();
  console.log('[Bull] Scheduler stopped');
}
