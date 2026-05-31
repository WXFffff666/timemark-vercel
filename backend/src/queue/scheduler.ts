import { Cron } from 'croner';
import { sendReminders, githubBackup, archiveLoginHistory, cleanupSessions } from '../jobs/tasks.js';
import { query } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('scheduler');

let jobs: Cron[] = [];

// Health tracking state
interface SchedulerState {
  lastRun: Date | null;
  lastResult: 'success' | 'error' | null;
  consecutiveFailures: number;
  totalRuns: number;
  startedAt: Date | null;
}

const schedulerState: SchedulerState = {
  lastRun: null,
  lastResult: null,
  consecutiveFailures: 0,
  totalRuns: 0,
  startedAt: null,
};

export function getSchedulerStatus() {
  return {
    ...schedulerState,
    jobCount: jobs.length,
    isRunning: jobs.length > 0,
  };
}

async function runJob(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    log.info({ job: name }, 'Running job');
    await fn();
    schedulerState.lastRun = new Date();
    schedulerState.lastResult = 'success';
    schedulerState.consecutiveFailures = 0;
    schedulerState.totalRuns++;
  } catch (error) {
    schedulerState.lastRun = new Date();
    schedulerState.lastResult = 'error';
    schedulerState.consecutiveFailures++;
    schedulerState.totalRuns++;
    log.error({ job: name, err: error }, 'Job failed');
  }
}

export async function startScheduler(): Promise<void> {
  schedulerState.startedAt = new Date();

  // 每分钟运行一次提醒检查（北京时间）
  // 使用15分钟窗口匹配，确保不会错过提醒时间
  jobs.push(new Cron('* * * * *', { timezone: 'Asia/Shanghai', name: 'reminder-check' }, async () => {
    await runJob('reminder-check', sendReminders);
  }));

  // 每天凌晨2点备份邮件日志（北京时间）
  jobs.push(new Cron('0 2 * * *', { timezone: 'Asia/Shanghai', name: 'daily-email-backup' }, async () => {
    await runJob('daily-email-backup', githubBackup);
  }));

  // 每天凌晨3点归档登录历史（北京时间）
  jobs.push(new Cron('0 3 * * *', { timezone: 'Asia/Shanghai', name: 'daily-login-backup' }, async () => {
    await runJob('daily-login-backup', archiveLoginHistory);
  }));

  // 每小时清理过期会话（北京时间）
  jobs.push(new Cron('0 * * * *', { timezone: 'Asia/Shanghai', name: 'hourly-cleanup' }, async () => {
    await runJob('hourly-cleanup', cleanupSessions);
  }));

  // 每小时清理过期插件会话（北京时间）
  jobs.push(new Cron('30 * * * *', { timezone: 'Asia/Shanghai', name: 'plugin-session-cleanup' }, async () => {
    await runJob('plugin-session-cleanup', async () => {
      const result = await query("DELETE FROM plugin_sessions WHERE expires_at < datetime('now')");
      log.info({ count: result.rowCount ?? 0 }, 'Cleaned up expired plugin sessions');
    });
  }));

  log.info({ jobCount: jobs.length, timezone: 'Asia/Shanghai' }, 'Scheduler started');
}

export async function stopScheduler(): Promise<void> {
  for (const job of jobs) {
    job.stop();
  }
  jobs = [];
  schedulerState.startedAt = null;
  log.info('Scheduler stopped');
}
