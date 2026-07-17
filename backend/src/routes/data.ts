import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';

const data = new Hono<{ Variables: { user: User } }>();

data.use('*', authMiddleware);

const SENSITIVE_ACCOUNT_FIELDS = ['token', 'secret', 'webhook', 'chat_id', 'session_data'] as const;
const SENSITIVE_CONFIG_FIELDS = [
  'encrypted_resend_key',
  'encrypted_github_token',
  'encrypted_feishu_webhook',
  'encrypted_wecom_webhook',
  'encrypted_dingtalk_webhook',
  'encrypted_dingtalk_secret',
  'encrypted_telegram_bot_token',
  'encrypted_discord_webhook',
  'encrypted_slack_webhook',
  'encrypted_wxpusher_app_token',
  'encrypted_wxpusher_uid',
  'encrypted_qmsg_key',
  'encrypted_qmsg_qq',
  'encrypted_channel_webhooks',
  'inbox_receive_secret',
  'webhook_inbound_secret',
  'caldav_password_encrypted',
  'api_key',
  'api_key_hash',
  'resend_webhook_secret',
] as const;

function redactFields<T extends Record<string, unknown>>(
  row: T,
  fields: readonly string[],
): T {
  const copy = { ...row };
  for (const field of fields) {
    if (copy[field] != null && copy[field] !== '') {
      (copy as Record<string, unknown>)[field] = '[redacted]';
    }
  }
  return copy;
}

function sanitizeNotificationAccount(row: Record<string, unknown>) {
  return redactFields(row, SENSITIVE_ACCOUNT_FIELDS);
}

function sanitizeUserConfig(row: Record<string, unknown>) {
  return redactFields(row, SENSITIVE_CONFIG_FIELDS);
}

// 导出用户所有数据
data.get('/export', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);

  try {
    const [events, configs, accounts, mappings, templates, triggerLogs] = await Promise.all([
      query('SELECT * FROM events WHERE user_id = $1', [userId]),
      query('SELECT * FROM user_configs WHERE user_id = $1', [userId]),
      query('SELECT * FROM notification_accounts WHERE user_id = $1', [userId]),
      query('SELECT * FROM relationship_mappings WHERE user_id = $1', [userId]),
      query('SELECT * FROM event_templates WHERE user_id = $1', [userId]),
      query('SELECT * FROM event_trigger_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500', [userId]),
    ]);

    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      user: { id: user.id, username: user.username },
      events: events.rows,
      configs: configs.rows.map((row) => sanitizeUserConfig(row)),
      notificationAccounts: accounts.rows.map((row) => sanitizeNotificationAccount(row)),
      relationshipMappings: mappings.rows,
      eventTemplates: templates.rows,
      triggerLogs: triggerLogs.rows,
    };

    c.header('Content-Disposition', `attachment; filename="timemark-export-${new Date().toISOString().split('T')[0]}.json"`);
    c.header('Content-Type', 'application/json');
    return c.json(exportData);
  } catch (error: any) {
    console.error('[Data Export] Failed:', error.message || error);
    return c.json({ success: false, error: error.message || 'Export failed' }, 500);
  }
});

// 导入用户数据
data.post('/import', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);

  try {
    const body = await c.req.json();

    if (!body.version || !body.events) {
      return c.json({ success: false, error: 'Invalid import data format' }, 400);
    }

    let imported = { events: 0, mappings: 0, templates: 0 };

    // Import events
    if (Array.isArray(body.events)) {
      for (const event of body.events) {
        await query(
          `INSERT INTO events (user_id, name, type, date, calendar_type, lunar_date, reminder_config, notification_channels, person_name, birth_date, birth_date_lunar, reminder_recipient_name, reminder_recipient_email)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            userId,
            event.name,
            event.type,
            event.date,
            event.calendar_type || 'gregorian',
            event.lunar_date || null,
            typeof event.reminder_config === 'string' ? event.reminder_config : JSON.stringify(event.reminder_config || {}),
            typeof event.notification_channels === 'string' ? event.notification_channels : JSON.stringify(event.notification_channels || []),
            event.person_name || null,
            event.birth_date || null,
            event.birth_date_lunar || null,
            event.reminder_recipient_name || null,
            event.reminder_recipient_email || null,
          ]
        );
        imported.events++;
      }
    }

    // Import relationship mappings
    if (Array.isArray(body.relationshipMappings)) {
      for (const mapping of body.relationshipMappings) {
        await query(
          `INSERT INTO relationship_mappings (user_id, event_id, from_relation, to_relation, recipient_email, recipient_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, mapping.event_id || 0, mapping.from_relation, mapping.to_relation, mapping.recipient_email || null, mapping.recipient_type || null]
        );
        imported.mappings++;
      }
    }

    // Import event templates
    if (Array.isArray(body.eventTemplates)) {
      for (const template of body.eventTemplates) {
        await query(
          `INSERT INTO event_templates (user_id, event_type, template_content)
           VALUES ($1, $2, $3) ON CONFLICT (user_id, event_type) DO NOTHING`,
          [userId, template.event_type, template.template_content]
        );
        imported.templates++;
      }
    }

    return c.json({ success: true, data: imported });
  } catch (error: any) {
    console.error('[Data Import] Failed:', error.message || error);
    return c.json({ success: false, error: error.message || 'Import failed' }, 500);
  }
});

data.post('/import-lunar-holidays', async (c) => {
  const user = c.get('user');
  const { ensureLunarHolidayEvents } = await import('../services/lunar-holidays.js');
  await ensureLunarHolidayEvents(Number(user.id));
  return c.json({ success: true, message: '农历节日预设已导入' });
});

export default data;
