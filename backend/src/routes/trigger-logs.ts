import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { sendNotifications } from '../services/notifications/index.js';
import type { User } from '@timemark/shared';

const triggerLogs = new Hono<{ Variables: { user: User } }>();

triggerLogs.use('*', authMiddleware);

// 获取事件触发日志
triggerLogs.get('/', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  try {
    const result = await query(
      `SELECT tl.*, e.name as event_name, e.type as event_type
       FROM event_trigger_logs tl
       LEFT JOIN events e ON tl.event_id = e.id
       WHERE tl.user_id = $1
       ORDER BY tl.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const countResult = await query(
      'SELECT COUNT(*) as total FROM event_trigger_logs WHERE user_id = $1',
      [userId]
    );

    return c.json({
      success: true,
      data: result.rows,
      pagination: {
        total: countResult.rows[0]?.total || 0,
        limit,
        offset,
      },
    });
  } catch (error: any) {
    console.error('[TriggerLogs] Failed to fetch:', error);
    return c.json({ success: false, error: error.message || 'Failed to fetch logs' }, 500);
  }
});

// 重试失败的通知
triggerLogs.post('/:id/retry', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const logId = parseInt(c.req.param('id'));

  if (isNaN(logId)) {
    return c.json({ success: false, error: 'Invalid log ID' }, 400);
  }

  try {
    // Read the trigger log entry
    const logResult = await query(
      `SELECT tl.*, e.name as event_name, e.type as event_type, e.date as event_date,
              e.reminder_config, e.notification_channels, e.notification_account_ids,
              e.person_name, e.reminder_recipient_name, e.reminder_recipient_email
       FROM event_trigger_logs tl
       LEFT JOIN events e ON tl.event_id = e.id
       WHERE tl.id = $1 AND tl.user_id = $2`,
      [logId, userId]
    );

    if (logResult.rows.length === 0) {
      return c.json({ success: false, error: 'Trigger log not found' }, 404);
    }

    const logEntry = logResult.rows[0];

    if (logEntry.status === 'success') {
      return c.json({ success: false, error: 'Cannot retry a successful notification' }, 400);
    }

    // Determine which channels to retry from error_details or channel_results
    let channelsToRetry: string[] = [];
    
    if (logEntry.channel_type) {
      channelsToRetry = logEntry.channel_type.split(',').map((s: string) => s.trim());
    } else if (logEntry.channel_results) {
      try {
        const results = JSON.parse(logEntry.channel_results);
        channelsToRetry = Object.entries(results)
          .filter(([, r]: [string, any]) => !r.success)
          .map(([ch]) => ch);
      } catch { /* ignore parse error */ }
    }

    if (channelsToRetry.length === 0) {
      return c.json({ success: false, error: 'No failed channels to retry' }, 400);
    }

    // Re-activate the account if it was disabled
    if (logEntry.account_id) {
      await query(
        `UPDATE notification_accounts SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2`,
        [logEntry.account_id, userId]
      );
    }

    // Build event object for sendNotifications
    const event = {
      id: logEntry.event_id,
      name: logEntry.event_name,
      type: logEntry.event_type,
      date: logEntry.event_date,
      reminder_config: logEntry.reminder_config,
      notification_channels: logEntry.notification_channels,
      notification_account_ids: logEntry.notification_account_ids,
      person_name: logEntry.person_name,
      reminder_recipient_name: logEntry.reminder_recipient_name,
      reminder_recipient_email: logEntry.reminder_recipient_email,
    };

    // Re-send the notification
    const channelResults = await sendNotifications(event, userId, channelsToRetry);

    // Update the trigger log with new result
    const hasFailure = Object.values(channelResults).some(r => !r.success);
    const allSuccess = Object.values(channelResults).every(r => r.success);
    const newStatus = allSuccess ? 'success' : 'failed';
    const newRetryCount = (logEntry.retry_count || 0) + 1;

    const newErrorMessage = hasFailure
      ? Object.entries(channelResults).filter(([, r]) => !r.success).map(([ch, r]) => `${ch}: ${r.error}`).join('; ')
      : null;

    await query(
      `UPDATE event_trigger_logs 
       SET status = $1, error_message = $2, channel_results = $3, retry_count = $4, error_details = $5
       WHERE id = $6 AND user_id = $7`,
      [
        newStatus,
        newErrorMessage,
        JSON.stringify(channelResults),
        newRetryCount,
        hasFailure ? JSON.stringify(Object.entries(channelResults).filter(([, r]) => !r.success).map(([ch, r]) => ({ channel: ch, error: r.error, accountId: r.accountId }))) : null,
        logId,
        userId
      ]
    );

    return c.json({
      success: true,
      data: {
        status: newStatus,
        retry_count: newRetryCount,
        channel_results: channelResults,
      },
    });
  } catch (error: any) {
    console.error('[TriggerLogs] Failed to retry:', error);
    return c.json({ success: false, error: error.message || 'Failed to retry notification' }, 500);
  }
});

// 清除触发日志
triggerLogs.delete('/', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);

  try {
    const result = await query('DELETE FROM event_trigger_logs WHERE user_id = $1', [userId]);
    return c.json({ success: true, data: { deleted: result.rowCount } });
  } catch (error: any) {
    console.error('[TriggerLogs] Failed to clear:', error);
    return c.json({ success: false, error: error.message || 'Failed to clear logs' }, 500);
  }
});

export default triggerLogs;
