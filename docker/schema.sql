CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);

-- users 表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- sessions 表
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  device_fingerprint TEXT,
  is_trusted INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- relationship_mappings 表 - 关系映射（如"我爸"→"妻子"）
CREATE TABLE IF NOT EXISTS relationship_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER,
  from_relation TEXT NOT NULL,
  to_relation TEXT NOT NULL,
  recipient_email TEXT,
  recipient_type TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_relationship_mappings_event ON relationship_mappings(event_id);
CREATE INDEX IF NOT EXISTS idx_relationship_mappings_user ON relationship_mappings(user_id);

-- events 表
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  calendar_type TEXT DEFAULT 'gregorian',
  lunar_date TEXT,
  reminder_config TEXT,
  reminder_emails TEXT,
  reminder_template TEXT,
  reminder_time TEXT DEFAULT '09:00',
  reminder_days_before TEXT DEFAULT '[1, 3, 7]',
  notification_channels TEXT DEFAULT '[]',
  notification_account_ids TEXT DEFAULT '[]',
  relationship_mapping_id INTEGER,
  person_name TEXT,
  birth_date TEXT,
  birth_date_lunar TEXT,
  reminder_recipient_name TEXT,
  reminder_recipient_email TEXT,
  recurring_config TEXT,
  next_occurrence TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, date);

-- email_logs 表
CREATE TABLE IF NOT EXISTS email_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  status TEXT NOT NULL,
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_logs_sent_at ON email_logs(sent_at);

-- login_logs 表
CREATE TABLE IF NOT EXISTS login_logs (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  ip_address TEXT,
  user_agent TEXT,
  device_fingerprint TEXT,
  success INTEGER NOT NULL,
  failure_reason TEXT,
  login_time TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_logs_timestamp ON login_logs(login_time);

-- login_attempts 表 - 登录失败锁定
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL,
  type TEXT NOT NULL,
  failed_count INTEGER DEFAULT 0,
  locked_until TEXT,
  last_attempt TEXT DEFAULT (datetime('now')),
  UNIQUE(identifier, type)
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier, type);

-- user_configs 表
CREATE TABLE IF NOT EXISTS user_configs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_resend_key TEXT,
  encrypted_github_token TEXT,
  encrypted_feishu_webhook TEXT,
  encrypted_wecom_webhook TEXT,
  encrypted_dingtalk_webhook TEXT,
  encrypted_dingtalk_secret TEXT,
  encrypted_telegram_bot_token TEXT,
  encrypted_discord_webhook TEXT,
  encrypted_slack_webhook TEXT,
  encrypted_wxpusher_app_token TEXT,
  encrypted_wxpusher_uid TEXT,
  encrypted_qmsg_key TEXT,
  encrypted_qmsg_qq TEXT,
  encrypted_channel_webhooks TEXT,
  telegram_chat_id TEXT,
  reminder_emails TEXT,
  reminders_enabled INTEGER DEFAULT 1,
  daily_check_time TEXT DEFAULT '08:00:00',
  days_before_list TEXT DEFAULT '[1,3,7]',
  alert_channels TEXT DEFAULT '["email"]',
  created_at TEXT DEFAULT (datetime('now'))
);

-- notification_accounts 表 - 通知账户管理（支持多账号绑定）
CREATE TABLE IF NOT EXISTS notification_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  webhook TEXT,
  token TEXT,
  secret TEXT,
  chat_id TEXT,
  is_active INTEGER DEFAULT 1,
  config_method TEXT DEFAULT 'webhook',
  session_data TEXT,
  plugin_package TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notification_accounts_user ON notification_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_accounts_type ON notification_accounts(type);

-- event_trigger_logs 表 - 事件触发日志
CREATE TABLE IF NOT EXISTS event_trigger_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  trigger_date TEXT NOT NULL,
  scheduled_date TEXT,
  status TEXT NOT NULL,
  channels TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trigger_logs_event ON event_trigger_logs(event_id);
CREATE INDEX IF NOT EXISTS idx_trigger_logs_user ON event_trigger_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_trigger_logs_date ON event_trigger_logs(trigger_date);

-- event_templates 表 - 用户自定义事件模板
CREATE TABLE IF NOT EXISTS event_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  template_content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_event_templates_user ON event_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_event_templates_type ON event_templates(event_type);
