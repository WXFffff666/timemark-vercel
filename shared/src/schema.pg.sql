-- TimeMark PostgreSQL Schema (v2.x)
-- Converted from SQLite schema for Vercel Postgres (Neon)
-- Authoritative source: docker/schema.sql
-- Reference: docker/init-db.sql (v1.x PG)

-- Enable pgcrypto for password hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- schema_version — schema migration tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- users — user accounts
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled BOOLEAN DEFAULT FALSE,
  avatar_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- sessions — JWT session management
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  device_fingerprint TEXT,
  is_trusted BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ============================================================
-- relationship_mappings — relation mapping (e.g. "我爸"→"父亲")
-- ============================================================
CREATE TABLE IF NOT EXISTS relationship_mappings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER,
  from_relation TEXT NOT NULL,
  to_relation TEXT NOT NULL,
  recipient_email TEXT,
  recipient_type TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_relationship_mappings_event ON relationship_mappings(event_id);
CREATE INDEX IF NOT EXISTS idx_relationship_mappings_user ON relationship_mappings(user_id);

-- ============================================================
-- events — event reminders (birthdays, anniversaries, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  date DATE NOT NULL,
  calendar_type TEXT DEFAULT 'gregorian',
  lunar_date TEXT,
  reminder_config JSONB,
  reminder_emails JSONB,
  reminder_template TEXT,
  reminder_time TIME DEFAULT '09:00',
  reminder_days_before JSONB DEFAULT '[1, 3, 7]',
  notification_channels JSONB DEFAULT '[]',
  notification_account_ids JSONB DEFAULT '[]',
  relationship_mapping_id INTEGER,
  person_name TEXT,
  birth_date DATE,
  birth_date_lunar TEXT,
  reminder_recipient_name TEXT,
  reminder_recipient_email TEXT,
  recurring_config JSONB,
  next_occurrence DATE,
  tags JSONB DEFAULT '[]',
  share_token TEXT,
  event_photo_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, date);
CREATE INDEX IF NOT EXISTS idx_events_next_occurrence ON events(next_occurrence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_share_token ON events(share_token) WHERE share_token IS NOT NULL;

-- ============================================================
-- email_logs — email sending history
-- ============================================================
CREATE TABLE IF NOT EXISTS email_logs (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL,
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_logs_sent_at ON email_logs(sent_at);

-- ============================================================
-- login_logs — login attempt history
-- ============================================================
CREATE TABLE IF NOT EXISTS login_logs (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  ip_address TEXT,
  user_agent TEXT,
  device_fingerprint TEXT,
  success BOOLEAN NOT NULL,
  failure_reason TEXT,
  login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_login_logs_timestamp ON login_logs(login_time);

-- ============================================================
-- login_attempts — login failure lockout tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS login_attempts (
  id SERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,
  type TEXT NOT NULL,
  failed_count INTEGER DEFAULT 0,
  locked_until TIMESTAMP,
  last_attempt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(identifier, type)
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier, type);

-- ============================================================
-- user_configs — per-user notification and encryption config
-- ============================================================
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
  reminder_emails JSONB,
  reminders_enabled BOOLEAN DEFAULT TRUE,
  daily_check_time TIME DEFAULT '08:00:00',
  days_before_list JSONB DEFAULT '[1,3,7]',
  alert_channels JSONB DEFAULT '["email"]',
  api_key TEXT,
  api_key_hash TEXT,
  timezone TEXT DEFAULT 'Asia/Shanghai',
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  password_changed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- notification_accounts — multi-account notification channel config
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  webhook TEXT,
  token TEXT,
  secret TEXT,
  chat_id TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  config_method TEXT DEFAULT 'webhook',
  session_data TEXT,
  plugin_package TEXT,
  connection_status TEXT,
  last_test_result TEXT,
  last_test_at TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notification_accounts_user ON notification_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_accounts_type ON notification_accounts(type);

-- ============================================================
-- event_trigger_logs — event trigger execution history
-- ============================================================
CREATE TABLE IF NOT EXISTS event_trigger_logs (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  trigger_date DATE NOT NULL,
  scheduled_date DATE,
  status TEXT NOT NULL,
  channels JSONB,
  error_message TEXT,
  channel_results JSONB,
  error_details TEXT,
  retry_count INTEGER DEFAULT 0,
  channel_type TEXT,
  account_id INTEGER,
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trigger_logs_event ON event_trigger_logs(event_id);
CREATE INDEX IF NOT EXISTS idx_trigger_logs_user ON event_trigger_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_trigger_logs_date ON event_trigger_logs(trigger_date);

-- ============================================================
-- push_subscriptions — browser push notification subscriptions
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  keys_p256dh TEXT,
  keys_auth TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- ============================================================
-- event_templates — user-customized notification templates
-- ============================================================
CREATE TABLE IF NOT EXISTS event_templates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  template_content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_event_templates_user ON event_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_event_templates_type ON event_templates(event_type);

-- ============================================================
-- notification_queue — async notification retry queue
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_queue (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  next_retry_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notification_queue_status ON notification_queue(status);
CREATE INDEX IF NOT EXISTS idx_notification_queue_user ON notification_queue(user_id);

-- ============================================================
-- plugin_sessions — plugin channel auth sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS plugin_sessions (
  id SERIAL PRIMARY KEY,
  channel_type TEXT NOT NULL,
  session_id TEXT UNIQUE NOT NULL,
  session_data TEXT,
  status TEXT DEFAULT 'pending',
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plugin_sessions_id ON plugin_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_plugin_sessions_expires ON plugin_sessions(expires_at);

-- ============================================================
-- cron_execution_logs — external/Vercel cron run history
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_execution_logs (
  id SERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  result_summary TEXT,
  error_message TEXT,
  executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cron_logs_job ON cron_execution_logs(job_name, executed_at);

-- ============================================================
-- Initial schema version (v15 = all incremental migrations merged)
-- ============================================================
INSERT INTO schema_version (version) VALUES (16) ON CONFLICT DO NOTHING;
