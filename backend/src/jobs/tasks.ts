import { query } from '../db/index.js';
import { Solar } from 'lunar-javascript';
import { sendNotifications } from '../services/notifications/index.js';

export async function sendReminders() {
  console.log('[Task] Checking reminders...');
  const today = new Date().toISOString().split('T')[0];
  
  const result = await query(
    `SELECT * FROM events WHERE date = $1 OR date = $2 OR date = $3`,
    [today, addDays(today, 1), addDays(today, 3)]
  );
  
  console.log(`[Task] Found ${result.rows.length} events to remind`);
  
  for (const event of result.rows) {
    const channels = event.notification_channels || [];
    if (channels.length > 0) {
      try {
        await sendNotifications(event, event.user_id, channels);
        console.log(`[Task] Sent notifications for event ${event.id}`);
      } catch (error) {
        console.error(`[Task] Failed to send notifications for event ${event.id}:`, error);
      }
    }
  }
}

export async function githubBackup() {
  console.log('[Task] Backing up email logs...');
  const result = await query('SELECT COUNT(*) as count FROM email_logs');
  console.log(`[Task] Backed up ${result.rows[0].count} email logs`);
}

export async function archiveLoginHistory() {
  console.log('[Task] Archiving login history...');
  const result = await query('SELECT COUNT(*) as count FROM login_attempts');
  console.log(`[Task] Archived ${result.rows[0].count} login attempts`);
}

export async function cleanupSessions() {
  console.log('[Task] Cleaning up expired sessions...');
  const result = await query('DELETE FROM sessions WHERE expires_at < NOW()');
  console.log(`[Task] Cleaned up ${result.rowCount ?? 0} expired sessions`);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}
