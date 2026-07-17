import { randomBytes, createHash } from 'crypto';
import { query } from '../db/index.js';
import { encrypt, decrypt } from '@timemark/shared/crypto';
import { normalizeNotificationChatId } from '@timemark/shared';

// The old hardcoded default key used before auto-generation was implemented.
// Existing Docker users who never set MASTER_KEY have data encrypted with this.
const LEGACY_MASTER_KEY = 'timemark-default-master-key-change-in-production-2026';

/** node-pg returns JSON/JSONB columns as parsed values; legacy rows may still be strings. */
function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function parseStringArrayColumn(raw: unknown): string[] {
  const parsed = parseJsonColumn<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
}

function parseNumberArrayColumn(raw: unknown): number[] {
  const parsed = parseJsonColumn<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(Number).filter((n) => !Number.isNaN(n) && n > 0);
}

function getMasterKey(): string {
  const key = process.env.MASTER_KEY;
  if (!key) {
    throw new Error('MASTER_KEY is not set. Ensure initSecretKeys() is called before using config service.');
  }
  return key;
}

// Lazy getter - MASTER_KEY is resolved on first use, not at module load time.
// This is critical because initSecretKeys() sets process.env.MASTER_KEY at runtime,
// AFTER all module imports have been resolved.
let _masterKeyCache: string | null = null;
function MASTER_KEY(): string {
  if (!_masterKeyCache) {
    _masterKeyCache = getMasterKey();
  }
  return _masterKeyCache;
}

/**
 * Decrypt with fallback to legacy key. Used during migration period when
 * data may be encrypted with either the new auto-generated key or the old default.
 * If legacy key works, re-encrypts with new key and calls updateFn to persist.
 */
function decryptWithFallback(
  value: string,
  updateFn?: (reEncrypted: string) => void
): string {
  // Try current key first
  try {
    return decrypt(value, MASTER_KEY());
  } catch {
    // Current key failed
  }

  // Try legacy key
  try {
    const plaintext = decrypt(value, LEGACY_MASTER_KEY);
    // Legacy key worked - re-encrypt with new key
    const reEncrypted = encrypt(plaintext, MASTER_KEY());
    if (updateFn) {
      updateFn(reEncrypted);
    }
    console.log('[Migration] Re-encrypted a field from legacy key to new key');
    return plaintext;
  } catch {
    // Both keys failed
  }

  console.error('[Migration] Failed to decrypt value with both current and legacy keys');
  return '';
}

export async function saveUserConfig(userId: number, config: any): Promise<void> {
  const e = (v: string | undefined) => v ? encrypt(v, MASTER_KEY()) : null;
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
      alert_channels,
      timezone,
      quiet_hours_start,
      quiet_hours_end
    )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (user_id) DO UPDATE SET
       encrypted_resend_key = EXCLUDED.encrypted_resend_key,
       encrypted_github_token = EXCLUDED.encrypted_github_token,
       encrypted_feishu_webhook = EXCLUDED.encrypted_feishu_webhook,
       encrypted_wecom_webhook = EXCLUDED.encrypted_wecom_webhook,
       encrypted_dingtalk_webhook = EXCLUDED.encrypted_dingtalk_webhook,
       encrypted_dingtalk_secret = EXCLUDED.encrypted_dingtalk_secret,
       encrypted_telegram_bot_token = EXCLUDED.encrypted_telegram_bot_token,
       encrypted_discord_webhook = EXCLUDED.encrypted_discord_webhook,
       encrypted_slack_webhook = EXCLUDED.encrypted_slack_webhook,
       encrypted_wxpusher_app_token = EXCLUDED.encrypted_wxpusher_app_token,
       encrypted_wxpusher_uid = EXCLUDED.encrypted_wxpusher_uid,
       encrypted_qmsg_key = EXCLUDED.encrypted_qmsg_key,
       encrypted_qmsg_qq = EXCLUDED.encrypted_qmsg_qq,
       encrypted_channel_webhooks = EXCLUDED.encrypted_channel_webhooks,
       telegram_chat_id = EXCLUDED.telegram_chat_id,
       reminder_emails = EXCLUDED.reminder_emails,
       alert_channels = EXCLUDED.alert_channels,
       timezone = EXCLUDED.timezone,
       quiet_hours_start = EXCLUDED.quiet_hours_start,
       quiet_hours_end = EXCLUDED.quiet_hours_end`,
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
      config.timezone || 'Asia/Shanghai',
      config.quiet_hours_start || null,
      config.quiet_hours_end || null,
    ]
  );
}

export async function getUserConfig(userId: number): Promise<any> {
  const result = await query(`SELECT * FROM user_configs WHERE user_id = $1`, [userId]);
  if (result.rows.length === 0) return null;
  const r = result.rows[0];

  // Decrypt with fallback: if legacy key works, re-encrypt and update the row
  const pendingUpdates: Record<string, string> = {};
  const d = (v: string | null, column: string) => {
    if (!v) return null;
    return decryptWithFallback(v, (reEncrypted) => {
      pendingUpdates[column] = reEncrypted;
    });
  };

  const config = {
    resend_api_key: d(r.encrypted_resend_key, 'encrypted_resend_key'),
    github_token: d(r.encrypted_github_token, 'encrypted_github_token'),
    feishu_webhook: d(r.encrypted_feishu_webhook, 'encrypted_feishu_webhook'),
    wecom_webhook: d(r.encrypted_wecom_webhook, 'encrypted_wecom_webhook'),
    dingtalk_webhook: d(r.encrypted_dingtalk_webhook, 'encrypted_dingtalk_webhook'),
    dingtalk_secret: d(r.encrypted_dingtalk_secret, 'encrypted_dingtalk_secret'),
    telegram_bot_token: d(r.encrypted_telegram_bot_token, 'encrypted_telegram_bot_token'),
    discord_webhook: d(r.encrypted_discord_webhook, 'encrypted_discord_webhook'),
    slack_webhook: d(r.encrypted_slack_webhook, 'encrypted_slack_webhook'),
    wxpusher_app_token: d(r.encrypted_wxpusher_app_token, 'encrypted_wxpusher_app_token'),
    wxpusher_uid: d(r.encrypted_wxpusher_uid, 'encrypted_wxpusher_uid'),
    qmsg_key: d(r.encrypted_qmsg_key, 'encrypted_qmsg_key'),
    qmsg_qq: d(r.encrypted_qmsg_qq, 'encrypted_qmsg_qq'),
    channel_webhooks: (() => {
      const raw = d(r.encrypted_channel_webhooks, 'encrypted_channel_webhooks');
      if (!raw) return {};
      try { return JSON.parse(raw); } catch { return {}; }
    })(),
    telegram_chat_id: r.telegram_chat_id,
    reminder_emails: parseStringArrayColumn(r.reminder_emails),
    alert_channels: parseStringArrayColumn(r.alert_channels),
    alert_emails: parseStringArrayColumn(r.alert_emails),
    alert_account_ids: parseNumberArrayColumn(r.alert_account_ids),
    timezone: r.timezone || 'Asia/Shanghai',
    quiet_hours_start: r.quiet_hours_start || null,
    quiet_hours_end: r.quiet_hours_end || null,
    default_test_email: r.default_test_email || null,
    markdown_email_template: r.markdown_email_template || null,
    notification_preset: r.notification_preset || null,
    api_scopes: r.api_scopes || 'read,write',
  };

  // Persist re-encrypted values if any fields were migrated
  if (Object.keys(pendingUpdates).length > 0) {
    const setClauses = Object.keys(pendingUpdates).map((col, i) => `${col} = $${i + 1}`);
    const values = Object.values(pendingUpdates);
    values.push(userId as any);
    await query(
      `UPDATE user_configs SET ${setClauses.join(', ')} WHERE user_id = $${values.length}`,
      values
    );
    console.log(`[Migration] Re-encrypted ${Object.keys(pendingUpdates).length} field(s) in user_configs for user ${userId}`);
  }

  return config;
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
  connection_status: 'connected' | 'disconnected' | 'reconnecting' | null;
  created_at: string;
  updated_at: string;
}

function decryptNotificationField(
  value: string | null,
  pendingUpdates?: Record<string, string>,
  column?: string
): string | null {
  if (!value) return null;
  // Try current key
  try {
    return decrypt(value, MASTER_KEY());
  } catch {
    // Current key failed
  }
  // Try legacy key
  try {
    const plaintext = decrypt(value, LEGACY_MASTER_KEY);
    // Re-encrypt with new key
    if (pendingUpdates && column) {
      pendingUpdates[column] = encrypt(plaintext, MASTER_KEY());
      console.log('[Migration] Re-encrypted notification_accounts.' + column + ' from legacy key');
    }
    return plaintext;
  } catch {
    // Both keys failed - backward compatibility: assume plaintext historical data
    return value;
  }
}

function mapNotificationAccountRow(row: any, pendingUpdates?: Record<string, string>): NotificationAccount {
  return {
    ...row,
    webhook: decryptNotificationField(row.webhook, pendingUpdates, 'webhook'),
    token: decryptNotificationField(row.token, pendingUpdates, 'token'),
    secret: decryptNotificationField(row.secret, pendingUpdates, 'secret'),
    chat_id: decryptNotificationField(row.chat_id, pendingUpdates, 'chat_id'),
    session_data: (() => {
      const raw = decryptNotificationField(row.session_data, pendingUpdates, 'session_data');
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    })(),
  };
}

export async function saveNotificationDefaults(
  userId: number,
  data: { default_test_email?: string | null; reminder_emails?: string[] },
): Promise<void> {
  await query(
    `INSERT INTO user_configs (user_id, default_test_email, reminder_emails)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       default_test_email = EXCLUDED.default_test_email,
       reminder_emails = EXCLUDED.reminder_emails`,
    [
      userId,
      data.default_test_email ?? null,
      data.reminder_emails !== undefined ? JSON.stringify(data.reminder_emails) : null,
    ],
  );
}

export async function getNotificationAccounts(userId: number): Promise<NotificationAccount[]> {
  const result = await query(
    'SELECT * FROM notification_accounts WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );

  const accounts: NotificationAccount[] = [];
  for (const row of result.rows) {
    const pendingUpdates: Record<string, string> = {};
    const account = mapNotificationAccountRow(row, pendingUpdates);
    accounts.push(account);

    // Persist re-encrypted values if any fields were migrated
    if (Object.keys(pendingUpdates).length > 0) {
      const setClauses = Object.keys(pendingUpdates).map((col, i) => `${col} = $${i + 1}`);
      const values = Object.values(pendingUpdates);
      values.push(row.id);
      await query(
        `UPDATE notification_accounts SET ${setClauses.join(', ')} WHERE id = $${values.length}`,
        values
      );
      console.log(`[Migration] Re-encrypted ${Object.keys(pendingUpdates).length} field(s) in notification_accounts id=${row.id}`);
    }
  }

  return accounts;
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
  const e = (v: string | undefined) => v ? encrypt(v, MASTER_KEY()) : null;
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
      (() => {
        const chatId = normalizeNotificationChatId(data.type, data.chat_id);
        return chatId ? encrypt(chatId, MASTER_KEY()) : null;
      })(),
      data.config_method || 'webhook',
      data.session_data ? encrypt(JSON.stringify(data.session_data), MASTER_KEY()) : null,
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
  const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.webhook !== undefined) {
    updates.push(`webhook = $${paramIndex++}`);
    values.push(data.webhook ? encrypt(data.webhook, MASTER_KEY()) : null);
  }
  if (data.token !== undefined) {
    updates.push(`token = $${paramIndex++}`);
    values.push(data.token ? encrypt(data.token, MASTER_KEY()) : null);
  }
  if (data.secret !== undefined) {
    updates.push(`secret = $${paramIndex++}`);
    values.push(data.secret ? encrypt(data.secret, MASTER_KEY()) : null);
  }
  if (data.chat_id !== undefined) {
    updates.push(`chat_id = $${paramIndex++}`);
    if (!data.chat_id?.trim()) {
      values.push(null);
    } else {
      const row = await query('SELECT type FROM notification_accounts WHERE id = $1 AND user_id = $2', [id, userId]);
      const chatId = normalizeNotificationChatId(String(row.rows[0]?.type ?? ''), data.chat_id);
      values.push(chatId ? encrypt(chatId, MASTER_KEY()) : null);
    }
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
    values.push(data.session_data ? encrypt(JSON.stringify(data.session_data), MASTER_KEY()) : null);
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
  const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
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
    emailAddresses: parseStringArrayColumn(r.reminder_emails),
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
       updated_at = CURRENT_TIMESTAMP
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

// ============ API Key 管理 ============

export async function saveAlertSettings(
  userId: number,
  settings: { alert_emails?: string[]; alert_account_ids?: number[]; alert_channels?: string[] },
): Promise<void> {
  await query(
    `INSERT INTO user_configs (user_id, alert_emails, alert_account_ids, alert_channels)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       alert_emails = COALESCE(EXCLUDED.alert_emails, user_configs.alert_emails),
       alert_account_ids = COALESCE(EXCLUDED.alert_account_ids, user_configs.alert_account_ids),
       alert_channels = COALESCE(EXCLUDED.alert_channels, user_configs.alert_channels)`,
    [
      userId,
      settings.alert_emails !== undefined ? JSON.stringify(settings.alert_emails) : null,
      settings.alert_account_ids !== undefined ? JSON.stringify(settings.alert_account_ids) : null,
      settings.alert_channels !== undefined ? JSON.stringify(settings.alert_channels) : null,
    ],
  );
}

/**
 * Stores SHA-256 hash in DB, returns plaintext once for user to save.
 */
export async function generateApiKey(userId: number): Promise<string> {
  const plaintext = `tm_${randomBytes(32).toString('hex')}`;
  const hash = createHash('sha256').update(plaintext).digest('hex');

  await query(
    `INSERT INTO user_configs (user_id, api_key_hash)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash`,
    [userId, hash]
  );

  return plaintext;
}

/**
 * Revoke (delete) the API key for a user.
 */
export async function revokeApiKey(userId: number): Promise<void> {
  await query(
    `UPDATE user_configs SET api_key_hash = NULL, api_key = NULL WHERE user_id = $1`,
    [userId]
  );
}
