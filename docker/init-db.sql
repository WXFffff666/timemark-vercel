-- Enable pgcrypto for TDE
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- users 表
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- sessions 表
CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  device_fingerprint TEXT,
  is_trusted BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- relationship_mappings 表 - 关系映射（如"我妈"→"妻子"）
CREATE TABLE relationship_mappings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER,
  from_relation VARCHAR(100) NOT NULL,
  to_relation VARCHAR(100) NOT NULL,
  recipient_email VARCHAR(255),
  recipient_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_relationship_mappings_event ON relationship_mappings(event_id);
CREATE INDEX idx_relationship_mappings_user ON relationship_mappings(user_id);

-- events 表
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  date DATE NOT NULL,
  calendar_type VARCHAR(20) DEFAULT 'gregorian',
  lunar_date VARCHAR(50),
  reminder_config JSON,
  reminder_emails JSON,
  reminder_template TEXT,
  reminder_time TIME DEFAULT '09:00',
  reminder_days_before JSON DEFAULT '[1, 3, 7]',
  notification_channels JSON DEFAULT '[]',
  notification_account_ids JSON DEFAULT '[]',
  relationship_mapping_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_events_user_date ON events(user_id, date);

-- email_logs 表
CREATE TABLE email_logs (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  recipient VARCHAR(255) NOT NULL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) NOT NULL,
  message_id TEXT
);
CREATE INDEX idx_email_logs_sent_at ON email_logs(sent_at);

-- login_logs 表
CREATE TABLE login_logs (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  ip_address VARCHAR(45),
  user_agent TEXT,
  device_fingerprint TEXT,
  success BOOLEAN NOT NULL,
  failure_reason TEXT,
  login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_login_logs_timestamp ON login_logs(login_time);

-- login_attempts 表
CREATE TABLE login_attempts (
  id SERIAL PRIMARY KEY,
  identifier VARCHAR(255) NOT NULL,
  type VARCHAR(10) NOT NULL,
  failed_count INTEGER DEFAULT 0,
  locked_until TIMESTAMP,
  last_attempt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(identifier, type)
);
CREATE INDEX idx_login_attempts_identifier ON login_attempts(identifier, type);

-- user_configs 表
CREATE TABLE user_configs (
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
  telegram_chat_id VARCHAR(255),
  reminder_emails TEXT,
  reminders_enabled BOOLEAN DEFAULT TRUE,
  daily_check_time TIME DEFAULT '08:00:00',
  days_before_list INTEGER[] DEFAULT ARRAY[1,3,7],
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- notification_accounts 表 - 通知账户管理（支持多账号绑定）
CREATE TABLE notification_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  webhook TEXT,
  token TEXT,
  secret TEXT,
  chat_id VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  -- 渠道配置方式: webhook | token | plugin
  config_method VARCHAR(20) DEFAULT 'webhook',
  -- 插件渠道的会话数据（JSON格式）
  session_data JSON,
  -- 插件渠道需要的npm包名
  plugin_package VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_notification_accounts_user ON notification_accounts(user_id);
CREATE INDEX idx_notification_accounts_type ON notification_accounts(type);

-- event_trigger_logs 表 - 事件触发日志
CREATE TABLE event_trigger_logs (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  trigger_type VARCHAR(50) NOT NULL,
  trigger_date DATE NOT NULL,
  scheduled_date DATE,
  status VARCHAR(20) NOT NULL,
  channels JSON,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_trigger_logs_event ON event_trigger_logs(event_id);
CREATE INDEX idx_trigger_logs_user ON event_trigger_logs(user_id);
CREATE INDEX idx_trigger_logs_date ON event_trigger_logs(trigger_date);
