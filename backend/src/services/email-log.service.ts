import { query } from '../db/index.js';

export type EmailLogInput = {
  userId: number;
  eventId?: number | null;
  recipient: string;
  status: 'sent' | 'failed' | 'received';
  subject?: string;
  errorMessage?: string;
  messageId?: string;
  channelType?: string;
};

export async function logEmail(entry: EmailLogInput): Promise<void> {
  try {
    await query(
      `INSERT INTO email_logs (user_id, event_id, recipient, status, subject, error_message, message_id, channel_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.userId,
        entry.eventId ?? null,
        entry.recipient,
        entry.status,
        entry.subject ?? null,
        entry.errorMessage ?? null,
        entry.messageId ?? null,
        entry.channelType ?? 'email',
      ],
    );
  } catch (error) {
    console.error('[email-log] Failed to write log:', error);
  }
}

export async function listEmailLogs(userId: number, limit = 100): Promise<unknown[]> {
  const result = await query(
    `SELECT id, event_id, recipient, status, subject, error_message, message_id, channel_type, sent_at
     FROM email_logs
     WHERE user_id = $1
     ORDER BY sent_at DESC
     LIMIT $2`,
    [userId, Math.min(limit, 500)],
  );
  return result.rows;
}

export async function deleteEmailLogs(userId: number): Promise<number> {
  const result = await query('DELETE FROM email_logs WHERE user_id = $1', [userId]);
  return result.rowCount ?? 0;
}

/** Retain 30 days of mail history */
export async function purgeOldEmailLogs(): Promise<number> {
  const result = await query(
    `DELETE FROM email_logs WHERE sent_at < NOW() - INTERVAL '30 days'`,
  );
  return result.rowCount ?? 0;
}
