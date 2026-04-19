import { query } from '../db/index.js';
import { encrypt, decrypt } from '@timemark/shared/crypto';

const MASTER_KEY = process.env.MASTER_KEY!;

export async function saveUserConfig(userId: number, config: any): Promise<void> {
  const e = (v: string | undefined) => v ? encrypt(v, MASTER_KEY) : null;
  await query(
    `INSERT INTO user_configs (
      user_id,
      encrypted_resend_key,
      encrypted_github_token,
      encrypted_feishu_webhook,
      encrypted_wecom_webhook,
      encrypted_dingtalk_webhook,
      encrypted_dingtalk_secret,
      encrypted_telegram_bot_token,
      encrypted_discord_webhook,
      encrypted_slack_webhook,
      encrypted_wxpusher_app_token,
      encrypted_wxpusher_uid,
      encrypted_qmsg_key,
      encrypted_qmsg_qq,
      encrypted_channel_webhooks,
      telegram_chat_id,
      reminder_emails,
      alert_channels
    )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (user_id) DO UPDATE SET
       encrypted_resend_key = COALESCE(EXCLUDED.encrypted_resend_key, user_configs.encrypted_resend_key),
       encrypted_github_token = COALESCE(EXCLUDED.encrypted_github_token, user_configs.encrypted_github_token),
       encrypted_feishu_webhook = COALESCE(EXCLUDED.encrypted_feishu_webhook, user_configs.encrypted_feishu_webhook),
       encrypted_wecom_webhook = COALESCE(EXCLUDED.encrypted_wecom_webhook, user_configs.encrypted_wecom_webhook),
       encrypted_dingtalk_webhook = COALESCE(EXCLUDED.encrypted_dingtalk_webhook, user_configs.encrypted_dingtalk_webhook),
       encrypted_dingtalk_secret = COALESCE(EXCLUDED.encrypted_dingtalk_secret, user_configs.encrypted_dingtalk_secret),
       encrypted_telegram_bot_token = COALESCE(EXCLUDED.encrypted_telegram_bot_token, user_configs.encrypted_telegram_bot_token),
       encrypted_discord_webhook = COALESCE(EXCLUDED.encrypted_discord_webhook, user_configs.encrypted_discord_webhook),
       encrypted_slack_webhook = COALESCE(EXCLUDED.encrypted_slack_webhook, user_configs.encrypted_slack_webhook),
       encrypted_wxpusher_app_token = COALESCE(EXCLUDED.encrypted_wxpusher_app_token, user_configs.encrypted_wxpusher_app_token),
       encrypted_wxpusher_uid = COALESCE(EXCLUDED.encrypted_wxpusher_uid, user_configs.encrypted_wxpusher_uid),
       encrypted_qmsg_key = COALESCE(EXCLUDED.encrypted_qmsg_key, user_configs.encrypted_qmsg_key),
       encrypted_qmsg_qq = COALESCE(EXCLUDED.encrypted_qmsg_qq, user_configs.encrypted_qmsg_qq),
       encrypted_channel_webhooks = COALESCE(EXCLUDED.encrypted_channel_webhooks, user_configs.encrypted_channel_webhooks),
       telegram_chat_id = COALESCE(EXCLUDED.telegram_chat_id, user_configs.telegram_chat_id),
       reminder_emails = COALESCE(EXCLUDED.reminder_emails, user_configs.reminder_emails),
       alert_channels = COALESCE(EXCLUDED.alert_channels, user_configs.alert_channels)`,
    [
      userId,
      e(config.resend_api_key),
      e(config.github_token),
      e(config.feishu_webhook),
      e(config.wecom_webhook),
      e(config.dingtalk_webhook),
      e(config.dingtalk_secret),
      e(config.telegram_bot_token),
      e(config.discord_webhook),
      e(config.slack_webhook),
      e(config.wxpusher_app_token),
      e(config.wxpusher_uid),
      e(config.qmsg_key),
      e(config.qmsg_qq),
      e(config.channel_webhooks ? JSON.stringify(config.channel_webhooks) : undefined),
      config.telegram_chat_id || null,
      config.reminder_emails ? JSON.stringify(config.reminder_emails) : null,
      config.alert_channels ? JSON.stringify(config.alert_channels) : null,
    ]
  );
}

export async function getUserConfig(userId: number): Promise<any> {
  const result = await query(`SELECT * FROM user_configs WHERE user_id = $1`, [userId]);
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  const d = (v: string | null) => v ? decrypt(v, MASTER_KEY) : null;
  return {
    resend_api_key: d(r.encrypted_resend_key),
    github_token: d(r.encrypted_github_token),
    feishu_webhook: d(r.encrypted_feishu_webhook),
    wecom_webhook: d(r.encrypted_wecom_webhook),
    dingtalk_webhook: d(r.encrypted_dingtalk_webhook),
    dingtalk_secret: d(r.encrypted_dingtalk_secret),
    telegram_bot_token: d(r.encrypted_telegram_bot_token),
    discord_webhook: d(r.encrypted_discord_webhook),
    slack_webhook: d(r.encrypted_slack_webhook),
    wxpusher_app_token: d(r.encrypted_wxpusher_app_token),
    wxpusher_uid: d(r.encrypted_wxpusher_uid),
    qmsg_key: d(r.encrypted_qmsg_key),
    qmsg_qq: d(r.encrypted_qmsg_qq),
    channel_webhooks: (() => {
      const raw = d(r.encrypted_channel_webhooks);
      if (!raw) return {};
      try { return JSON.parse(raw); } catch { return {}; }
    })(),
    telegram_chat_id: r.telegram_chat_id,
    reminder_emails: (() => {
      const raw = r.reminder_emails;
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return []; }
    })(),
    alert_channels: (() => {
      const raw = r.alert_channels;
      if (!raw) return ['email'];
      try { return JSON.parse(raw); } catch { return ['email']; }
    })(),
  };
}

// ============ 通知账户管理（支持多账号绑定）============

export interface NotificationAccount {
  id: number;
  user_id: number;
  type: string;
  name: string;
  webhook: string | null;
  token: string | null;
  secret: string | null;
  chat_id: string | null;
  is_active: boolean;
  config_method: 'webhook' | 'token' | 'plugin';
  session_data: any | null;
  plugin_package: string | null;
  created_at: string;
  updated_at: string;
}

function decryptNotificationField(value: string | null): string | null {
  if (!value) return null;
  try {
    return decrypt(value, MASTER_KEY);
  } catch {
    // backward compatibility: plaintext historical data
    return value;
  }
}

function mapNotificationAccountRow(row: any): NotificationAccount {
  return {
    ...row,
    webhook: decryptNotificationField(row.webhook),
    token: decryptNotificationField(row.token),
    secret: decryptNotificationField(row.secret),
    session_data: (() => {
      const raw = decryptNotificationField(row.session_data);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    })(),
  };
}

export async function getNotificationAccounts(userId: number): Promise<NotificationAccount[]> {
  const result = await query(
    'SELECT * FROM notification_accounts WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows.map(mapNotificationAccountRow);
}

export async function createNotificationAccount(
  userId: number,
  data: { 
    type: string; 
    name: string; 
    webhook?: string; 
    token?: string; 
    secret?: string; 
    chat_id?: string;
    config_method?: 'webhook' | 'token' | 'plugin';
    session_data?: any;
    plugin_package?: string;
  }
): Promise<NotificationAccount> {
  const e = (v: string | undefined) => v ? encrypt(v, MASTER_KEY) : null;
  const result = await query(
    `INSERT INTO notification_accounts (user_id, type, name, webhook, token, secret, chat_id, config_method, session_data, plugin_package)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      userId, 
      data.type, 
      data.name, 
      e(data.webhook), 
      e(data.token), 
      e(data.secret), 
      data.chat_id || null,
      data.config_method || 'webhook',
      data.session_data ? encrypt(JSON.stringify(data.session_data), MASTER_KEY) : null,
      data.plugin_package || null
    ]
  );
  return mapNotificationAccountRow(result.rows[0]);
}

export async function updateNotificationAccount(
  id: number,
  userId: number,
  data: Partial<{ 
    name: string; 
    webhook: string; 
    token: string; 
    secret: string; 
    chat_id: string; 
    is_active: boolean;
    config_method: 'webhook' | 'token' | 'plugin';
    session_data: any;
    plugin_package: string;
  }>
): Promise<NotificationAccount | null> {
  const updates: string[] = ["updated_at = datetime('now')"];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.webhook !== undefined) {
    updates.push(`webhook = $${paramIndex++}`);
    values.push(data.webhook ? encrypt(data.webhook, MASTER_KEY) : null);
  }
  if (data.token !== undefined) {
    updates.push(`token = $${paramIndex++}`);
    values.push(data.token ? encrypt(data.token, MASTER_KEY) : null);
  }
  if (data.secret !== undefined) {
    updates.push(`secret = $${paramIndex++}`);
    values.push(data.secret ? encrypt(data.secret, MASTER_KEY) : null);
  }
  if (data.chat_id !== undefined) {
    updates.push(`chat_id = $${paramIndex++}`);
    values.push(data.chat_id);
  }
  if (data.is_active !== undefined) {
    updates.push(`is_active = $${paramIndex++}`);
    values.push(data.is_active);
  }
  if (data.config_method !== undefined) {
    updates.push(`config_method = $${paramIndex++}`);
    values.push(data.config_method);
  }
  if (data.session_data !== undefined) {
    updates.push(`session_data = $${paramIndex++}`);
    values.push(data.session_data ? encrypt(JSON.stringify(data.session_data), MASTER_KEY) : null);
  }
  if (data.plugin_package !== undefined) {
    updates.push(`plugin_package = $${paramIndex++}`);
    values.push(data.plugin_package);
  }

  if (updates.length === 1) return null;

  values.push(id, userId);
  const result = await query(
    `UPDATE notification_accounts SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND user_id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0] ? mapNotificationAccountRow(result.rows[0]) : null;
}

export async function deleteNotificationAccount(id: number, userId: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM notification_accounts WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

// ============ 关系映射管理 ============

export interface RelationshipMapping {
  id: number;
  user_id: number;
  event_id: number;
  from_relation: string;
  to_relation: string;
  recipient_email?: string;
  recipient_type?: string;
  created_at: string;
  updated_at: string;
}

export async function getRelationshipMappings(userId: number, eventId?: number): Promise<RelationshipMapping[]> {
  if (eventId) {
    const result = await query(
      'SELECT * FROM relationship_mappings WHERE user_id = $1 AND event_id = $2 ORDER BY created_at DESC',
      [userId, eventId]
    );
    return result.rows;
  }
  const result = await query(
    'SELECT * FROM relationship_mappings WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows;
}

export async function createRelationshipMapping(
  userId: number,
  data: {
    event_id: number;
    from_relation: string;
    to_relation: string;
    recipient_email?: string;
    recipient_type?: string;
  }
): Promise<RelationshipMapping> {
  const result = await query(
    `INSERT INTO relationship_mappings (user_id, event_id, from_relation, to_relation, recipient_email, recipient_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, data.event_id, data.from_relation, data.to_relation, data.recipient_email || null, data.recipient_type || null]
  );
  return result.rows[0];
}

export async function updateRelationshipMapping(
  id: number,
  userId: number,
  data: Partial<{ from_relation: string; to_relation: string; recipient_email: string; recipient_type: string }>
): Promise<RelationshipMapping | null> {
  const updates: string[] = ["updated_at = datetime('now')"];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.from_relation !== undefined) {
    updates.push(`from_relation = $${paramIndex++}`);
    values.push(data.from_relation);
  }
  if (data.to_relation !== undefined) {
    updates.push(`to_relation = $${paramIndex++}`);
    values.push(data.to_relation);
  }
  if (data.recipient_email !== undefined) {
    updates.push(`recipient_email = $${paramIndex++}`);
    values.push(data.recipient_email);
  }
  if (data.recipient_type !== undefined) {
    updates.push(`recipient_type = $${paramIndex++}`);
    values.push(data.recipient_type);
  }

  if (updates.length === 1) return null;

  values.push(id, userId);
  const result = await query(
    `UPDATE relationship_mappings SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND user_id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

export async function deleteRelationshipMapping(id: number, userId: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM relationship_mappings WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

// ============ 提醒设置管理 ============

export interface ReminderSettings {
  enabled: boolean;
  dailyTime: string;
  daysBeforeList: number[];
  emailAddresses: string[];
}

export async function getReminderSettings(userId: number): Promise<ReminderSettings | null> {
  const result = await query(
    `SELECT reminders_enabled, daily_check_time, days_before_list, reminder_emails 
     FROM user_configs WHERE user_id = $1`,
    [userId]
  );
  
  if (result.rows.length === 0) {
    // 返回默认值
    return {
      enabled: true,
      dailyTime: '08:00:00',
      daysBeforeList: [1, 3, 7],
      emailAddresses: [],
    };
  }
  
  const r = result.rows[0];
  return {
    enabled: r.reminders_enabled !== false,
    dailyTime: r.daily_check_time || '08:00:00',
    daysBeforeList: r.days_before_list || [1, 3, 7],
    emailAddresses: (() => {
      const raw = r.reminder_emails;
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return []; }
    })(),
  };
}

export async function saveReminderSettings(userId: number, settings: Partial<ReminderSettings>): Promise<void> {
  await query(
    `INSERT INTO user_configs (user_id, reminders_enabled, daily_check_time, days_before_list, reminder_emails)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       reminders_enabled = COALESCE(EXCLUDED.reminders_enabled, user_configs.reminders_enabled),
       daily_check_time = COALESCE(EXCLUDED.daily_check_time, user_configs.daily_check_time),
       days_before_list = COALESCE(EXCLUDED.days_before_list, user_configs.days_before_list),
       reminder_emails = COALESCE(EXCLUDED.reminder_emails, user_configs.reminder_emails)`,
    [
      userId,
      settings.enabled !== undefined ? settings.enabled : true,
      settings.dailyTime || '08:00:00',
      settings.daysBeforeList ? JSON.stringify(settings.daysBeforeList) : null,
      settings.emailAddresses ? JSON.stringify(settings.emailAddresses) : null,
    ]
  );
}

// ============ 事件模板管理 ============

export interface EventTemplate {
  id: number;
  user_id: number;
  event_type: string;
  template_content: string;
  created_at: string;
  updated_at: string;
}

export async function getEventTemplates(userId: number): Promise<EventTemplate[]> {
  const result = await query(
    'SELECT * FROM event_templates WHERE user_id = $1 ORDER BY event_type',
    [userId]
  );
  return result.rows;
}

export async function getEventTemplate(userId: number, eventType: string): Promise<EventTemplate | null> {
  const result = await query(
    'SELECT * FROM event_templates WHERE user_id = $1 AND event_type = $2',
    [userId, eventType]
  );
  return result.rows[0] || null;
}

export async function saveEventTemplate(
  userId: number,
  eventType: string,
  templateContent: string
): Promise<EventTemplate> {
  const result = await query(
    `INSERT INTO event_templates (user_id, event_type, template_content)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, event_type) DO UPDATE SET
       template_content = EXCLUDED.template_content,
       updated_at = datetime('now')
     RETURNING *`,
    [userId, eventType, templateContent]
  );
  return result.rows[0];
}

export async function deleteEventTemplate(userId: number, eventType: string): Promise<boolean> {
  const result = await query(
    'DELETE FROM event_templates WHERE user_id = $1 AND event_type = $2',
    [userId, eventType]
  );
  return (result.rowCount ?? 0) > 0;
}
