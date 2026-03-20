import { reminderQueue, backupQueue, cleanupQueue } from './queues.js';

export async function startScheduler() {
  await reminderQueue.add({}, {
    repeat: { cron: '0 * * * *', tz: 'UTC' },
    jobId: 'hourly-reminders',
  });

  await backupQueue.add('email-logs', {}, {
    repeat: { cron: '0 2 * * *', tz: 'UTC' },
    jobId: 'daily-email-backup',
  });

  await backupQueue.add('login-logs', {}, {
    repeat: { cron: '0 3 * * *', tz: 'UTC' },
    jobId: 'daily-login-backup',
  });

  await cleanupQueue.add({}, {
    repeat: { cron: '0 * * * *', tz: 'UTC' },
    jobId: 'hourly-cleanup',
  });

  console.log('[Bull] Scheduler started with 4 recurring jobs');
}

export async function stopScheduler() {
  await reminderQueue.close();
  await backupQueue.close();
  await cleanupQueue.close();
  console.log('[Bull] Scheduler stopped');
}
