import { reminderQueue, backupQueue, cleanupQueue } from './queues.js';
import { sendReminders, githubBackup, archiveLoginHistory, cleanupSessions } from '../jobs/tasks.js';

reminderQueue.process(async (job) => {
  console.log(`[Bull] Processing reminder job ${job.id}`);
  await sendReminders();
  return { success: true };
});

backupQueue.process('email-logs', async (job) => {
  console.log(`[Bull] Processing email backup ${job.id}`);
  await githubBackup();
  return { success: true };
});

backupQueue.process('login-logs', async (job) => {
  console.log(`[Bull] Processing login backup ${job.id}`);
  await archiveLoginHistory();
  return { success: true };
});

cleanupQueue.process(async (job) => {
  console.log(`[Bull] Processing cleanup ${job.id}`);
  await cleanupSessions();
  return { success: true };
});

reminderQueue.on('failed', (job, err) => {
  console.error(`[Bull] Reminder job ${job.id} failed:`, err);
});

backupQueue.on('failed', (job, err) => {
  console.error(`[Bull] Backup job ${job.id} failed:`, err);
});
