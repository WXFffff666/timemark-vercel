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
  totp_recovery_codes JSONB DEFAULT '[]',
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
  -- v41 (todo 68): household profile assignment (nullable, ON DELETE SET NULL).
  -- The FK constraint + backfill are applied by the v41 migration.
  profile_id INTEGER,
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
  habit_streak_nudge_hour TEXT DEFAULT '20:00',
  password_changed_at TIMESTAMP,
  reminder_catchup_minutes INTEGER,
  email_template_style TEXT DEFAULT 'classic',
  fallback_enabled BOOLEAN DEFAULT TRUE,
  greeting_mode TEXT DEFAULT 'auto',
  greeting_ai_enabled BOOLEAN DEFAULT TRUE,
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
  suspended_until TIMESTAMPTZ,
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
  -- TEXT, NOT DATE (migration v51): scheduled reminders store the dedup key here, which is a
  -- compound token (`YYYY-MM-DD#d<n>#tHH:mm`, or `snooze:event#<id>#<ISO>`), unrepresentable
  -- as DATE. The column was declared DATE here while v51 casts it to TEXT, so a fresh install
  -- only became the migrated shape after runMigrations(); declaring TEXT directly makes a fresh
  -- database end in exactly the same shape as a migrated one.
  trigger_date TEXT NOT NULL,
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

-- v79: AI birthday greetings — final composed text per contact/year/channel.
-- Rotation basis (composeBirthdayGreeting) + audit trail + draft staging.
CREATE TABLE IF NOT EXISTS greeting_history (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  contact_id INTEGER,
  event_id INTEGER,
  year TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL,
  subject TEXT,
  body_html TEXT,
  recipients TEXT,
  -- v80: AI budget gate + per-draft regeneration
  source TEXT NOT NULL DEFAULT 'composer',
  tone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_greeting_history_user_year ON greeting_history(user_id, year DESC);

-- v80: AI monthly digest archive ("AI keeps what matters") — raw trigger logs expire
-- at 90 days; the AI narrative + deterministic stats JSON stay forever.
CREATE TABLE IF NOT EXISTS digest_archive (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  period_start DATE,
  period_end DATE,
  narrative_md TEXT,
  stats_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_digest_archive_user_period ON digest_archive(user_id, period_start DESC);

-- v80: bounded cron status — one row per job (upsert), replacing every-minute
-- success rows; failed details stay in cron_execution_logs with 30d retention.
CREATE TABLE IF NOT EXISTS cron_job_status (
  job_name TEXT PRIMARY KEY,
  last_status TEXT NOT NULL,
  last_ok_at TIMESTAMPTZ,
  last_error TEXT,
  last_summary TEXT,
  last_duration_ms INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trigger_logs_date ON event_trigger_logs(trigger_date);
-- A plain btree index is still the right shape for the TEXT token: the lookup is exact
-- equality (`WHERE trigger_date = $2`) on the full key, never a prefix/LIKE pattern.

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
-- expiry_items / expiry_history — 到期中心 (subscriptions, bills, insurance,
-- domains, warranties, custom). Mirrors backend/src/db/migrate.ts v34.
-- ============================================================
CREATE TABLE IF NOT EXISTS expiry_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('subscription', 'bill', 'insurance', 'domain', 'warranty', 'custom')),
  title TEXT NOT NULL,
  vendor TEXT,
  amount_cents BIGINT,
  currency TEXT NOT NULL DEFAULT 'CNY',
  cycle TEXT NOT NULL DEFAULT 'once' CHECK (cycle IN ('once', 'monthly', 'quarterly', 'yearly', 'custom')),
  cycle_days INTEGER,
  start_date DATE,
  next_due_date DATE NOT NULL,
  auto_renew BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  tags TEXT[] DEFAULT '{}',
  reminder_config JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_expiry_items_user_due ON expiry_items(user_id, next_due_date);
CREATE INDEX IF NOT EXISTS idx_expiry_items_user_kind ON expiry_items(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_expiry_items_active_due ON expiry_items(user_id, next_due_date) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS expiry_history (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES expiry_items(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_date DATE,
  to_date DATE,
  amount_cents BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_expiry_history_item ON expiry_history(item_id, created_at DESC);

-- ============================================================
-- inventory_items — 库存 (food / medicine / supply / other) with quantity,
-- low-stock threshold and optional expires_at. Mirrors backend/src/db/migrate.ts v35.
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('food', 'medicine', 'supply', 'other')),
  quantity NUMERIC NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit TEXT,
  low_stock_threshold NUMERIC CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  purchased_at DATE,
  expires_at DATE,
  location TEXT,
  notes TEXT,
  reminder_config JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_items_user_expires ON inventory_items(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_inventory_items_user_category ON inventory_items(user_id, category);
CREATE INDEX IF NOT EXISTS idx_inventory_items_active_expires ON inventory_items(user_id, expires_at) WHERE is_active = TRUE;

-- ============================================================
-- maintenance_plans / maintenance_logs — 保养计划 (date and/or usage interval)
-- with its service history. Mirrors backend/src/db/migrate.ts v36.
-- ============================================================
CREATE TABLE IF NOT EXISTS maintenance_plans (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  asset_name TEXT NOT NULL,
  asset_kind TEXT NOT NULL DEFAULT 'other' CHECK (asset_kind IN ('vehicle', 'appliance', 'device', 'other')),
  interval_days INTEGER CHECK (interval_days IS NULL OR interval_days > 0),
  interval_usage INTEGER CHECK (interval_usage IS NULL OR interval_usage > 0),
  usage_unit TEXT CHECK (usage_unit IS NULL OR usage_unit IN ('km', 'hours', 'cycles')),
  current_usage NUMERIC CHECK (current_usage IS NULL OR current_usage >= 0),
  last_done_at DATE,
  next_due_at DATE,
  next_due_usage NUMERIC CHECK (next_due_usage IS NULL OR next_due_usage >= 0),
  notes TEXT,
  reminder_config JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT maintenance_plans_interval_present CHECK (interval_days IS NOT NULL OR interval_usage IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_user_due ON maintenance_plans(user_id, next_due_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_user_kind ON maintenance_plans(user_id, asset_kind);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_active_due ON maintenance_plans(user_id, next_due_at) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES maintenance_plans(id) ON DELETE CASCADE,
  done_at DATE NOT NULL,
  usage_at NUMERIC,
  cost_cents BIGINT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_maintenance_logs_plan ON maintenance_logs(plan_id, done_at DESC);

-- ============================================================
-- attachments — D2 document-vault attachment METADATA only. Bytes live in object
-- storage (Vercel Blob, or the dev-only .data/ fallback), never in Postgres.
-- Mirrors backend/src/db/migrate.ts v37. (owner_type, owner_id) is a polymorphic
-- nullable pair: set on upload/link, cleared on unlink.
-- ============================================================
CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_type TEXT CHECK (owner_type IS NULL OR owner_type IN ('document', 'expiry', 'inventory', 'maintenance', 'event')),
  owner_id INTEGER,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT attachments_owner_pair CHECK ((owner_type IS NULL) = (owner_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_attachments_user_owner ON attachments(user_id, owner_type, owner_id);

-- ============================================================
-- documents — 证件保险箱 (passport / id_card / driver_license / visa / certificate /
-- policy / contract / other). `document_number_encrypted` is AES-256-GCM ciphertext
-- (MASTER_KEY, same convention as notification credentials) and is never returned in
-- list responses. Document images live in the attachment store; no bytes here.
-- Mirrors backend/src/db/migrate.ts v38.
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('passport', 'id_card', 'driver_license', 'visa', 'certificate', 'policy', 'contract', 'other')),
  title TEXT NOT NULL,
  issuer TEXT,
  document_number_encrypted TEXT,
  issued_at DATE,
  expires_at DATE,
  country TEXT,
  notes TEXT,
  reminder_config JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_documents_user_expires ON documents(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_documents_user_kind ON documents(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_documents_active_expires ON documents(user_id, expires_at) WHERE is_active = TRUE;

-- ============================================================
-- fixed_contacts — base definition. On existing deployments this table is created by
-- migration v18 and extended by v30 (contact_methods), v31 (relationship/gender) and
-- v39 (cadence anchor/shape). It is defined here because this file runs BEFORE the
-- incremental migrations: the D4 CRM tables below carry FKs to fixed_contacts, and a
-- fresh `scripts/migrate-db.ts` run must resolve them. The column set is exactly
-- v18 + v30 + v31 + v39; every one of those migrations is IF NOT EXISTS/guarded, so
-- they become no-ops once this definition exists.
-- ============================================================
CREATE TABLE IF NOT EXISTS fixed_contacts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  nickname TEXT,
  email TEXT,
  phone TEXT,
  telegram_chat_id TEXT,
  qq TEXT,
  wxpusher_uid TEXT,
  preferred_channels JSONB DEFAULT '[]',
  contact_methods JSONB DEFAULT '{}',
  relationship TEXT,
  gender TEXT DEFAULT 'unknown',
  notes TEXT,
  validation_status TEXT DEFAULT 'pending',
  last_validated_at TIMESTAMP,
  cadence_days INT,
  last_contact_at TIMESTAMPTZ,
  cadence_enabled BOOLEAN DEFAULT FALSE,
  -- v41 (todo 68): household profile assignment (nullable, ON DELETE SET NULL).
  -- The FK constraint + backfill are applied by the v41 migration.
  profile_id INTEGER,
  -- v79: direct birthday on the contact (greetings without a linked birthday event).
  birth_date DATE,
  greeting_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_user ON fixed_contacts(user_id);

-- ============================================================
-- interactions / contact_promises / gift_records — D4 personal-CRM interaction
-- log, promises and gift ledger. Mirrors backend/src/db/migrate.ts v39.
-- ============================================================
CREATE TABLE IF NOT EXISTS interactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES fixed_contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call', 'message', 'meeting', 'meal', 'visit', 'gift', 'other')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  summary TEXT,
  mood TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_interactions_user_contact_occurred ON interactions(user_id, contact_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS contact_promises (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES fixed_contacts(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  due_at DATE,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_promises_contact ON contact_promises(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gift_records (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES fixed_contacts(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('given', 'received')),
  occasion TEXT,
  amount_cents BIGINT CHECK (amount_cents IS NULL OR amount_cents >= 0),
  occurred_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_gift_records_contact ON gift_records(contact_id, occurred_at DESC);

-- ============================================================
-- habits / habit_logs — D6 habit tracking with per-period targets and streaks.
-- Mirrors backend/src/db/migrate.ts v40. Distinct from todo_completions (v29):
-- habits are their own concept (day/week periods, targets, schedule days).
-- `UNIQUE (habit_id, logged_on)` makes same-day logging an UPSERT (count += n),
-- never a second row. `user_configs.habit_streak_nudge_hour` (v40 ALTER) stores
-- the per-user hour for the nightly "streak at risk" nudge (default 20:00).
-- ============================================================
CREATE TABLE IF NOT EXISTS habits (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  name TEXT NOT NULL,
  icon TEXT,
  target_per_period INTEGER NOT NULL DEFAULT 1 CHECK (target_per_period >= 1),
  period TEXT NOT NULL DEFAULT 'day' CHECK (period IN ('day', 'week')),
  schedule_days INTEGER[],
  reminder_times TEXT[],
  color TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);
CREATE INDEX IF NOT EXISTS idx_habits_user_active ON habits(user_id) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS habit_logs (
  id SERIAL PRIMARY KEY,
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_on DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (habit_id, logged_on)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_habit_date ON habit_logs(habit_id, logged_on DESC);
CREATE INDEX IF NOT EXISTS idx_habit_logs_user_date ON habit_logs(user_id, logged_on DESC);

-- ============================================================
-- profiles — D5 household member profiles (self/family/pet). Mirrors
-- backend/src/db/migrate.ts v41. Personal household model only: no
-- organisations / teams / seats. The nullable profile_id columns on
-- events/fixed_contacts/expiry_items/inventory_items/maintenance_plans/
-- documents/habits are declared inline above; the FK constraints, the
-- per-user default `我` profile and the backfill are applied by the v41
-- migration (profiles + this table's indexes are mirrored here so the base
-- file is self-describing).
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relation TEXT,
  kind TEXT NOT NULL DEFAULT 'family' CHECK (kind IN ('self', 'family', 'pet')),
  birth_date DATE,
  lunar_birthday JSONB,
  avatar_emoji TEXT,
  timezone TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id);
-- Exactly one self profile per user (the 我 default); family/pet are unlimited.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_profiles_user_self ON profiles(user_id) WHERE kind = 'self';
-- (user_id, profile_id) covering index on every table the profile filter scopes (todo 69).
CREATE INDEX IF NOT EXISTS idx_events_user_profile ON events(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_user_profile ON fixed_contacts(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_expiry_items_user_profile ON expiry_items(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_user_profile ON inventory_items(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_user_profile ON maintenance_plans(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_documents_user_profile ON documents(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_habits_user_profile ON habits(user_id, profile_id);

-- ============================================================
-- medications / medication_doses — D3 medication reminders + dose log.
-- Mirrors backend/src/db/migrate.ts v42. Reminder and log only: no medical
-- advice and no pharmacy integration (both explicitly out of scope).
-- `is_critical` is part of v42 from the start (may bypass quiet hours in the
-- reminder job; the choice is explicit in the UI). `schedule_times TEXT[]` may
-- be empty (PRN / as-needed) and then materialises no scheduled doses; the
-- UNIQUE (medication_id, scheduled_for) makes dose materialisation idempotent.
-- ============================================================
CREATE TABLE IF NOT EXISTS medications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  dosage TEXT,
  form TEXT NOT NULL DEFAULT 'tablet' CHECK (form IN ('tablet', 'capsule', 'liquid', 'injection', 'patch', 'drops', 'other')),
  schedule_times TEXT[] NOT NULL DEFAULT '{}',
  schedule_days INTEGER[],
  start_date DATE NOT NULL,
  end_date DATE CHECK (end_date IS NULL OR end_date >= start_date),
  stock_quantity NUMERIC CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
  stock_unit TEXT,
  units_per_dose NUMERIC NOT NULL DEFAULT 1 CHECK (units_per_dose > 0),
  refill_threshold NUMERIC CHECK (refill_threshold IS NULL OR refill_threshold >= 0),
  prescriber TEXT,
  pharmacy TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_critical BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_medications_user_profile ON medications(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_medications_user_active ON medications(user_id) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS medication_doses (
  id SERIAL PRIMARY KEY,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  logged_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('taken', 'skipped', 'missed', 'pending')),
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- One dose row per medication per scheduled instant: materialisation is idempotent.
  UNIQUE (medication_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_medication_doses_user_scheduled ON medication_doses(user_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_medication_doses_med_status ON medication_doses(medication_id, status);

-- ============================================================
-- profile_channel_accounts — per-profile notification routing (D5, checkbox 70).
-- Mirrors backend/src/db/migrate.ts v43. Rows exist -> only those accounts receive
-- that profile's reminders; no rows -> all active accounts (pre-routing default).
-- Both FKs CASCADE: deleting a profile or an account drops its routing rows only.
-- ============================================================
CREATE TABLE IF NOT EXISTS profile_channel_accounts (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES notification_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_channel_accounts_account ON profile_channel_accounts(account_id);

-- ============================================================
-- goals / milestones — personal goals with progress tracking (checkbox 81).
-- Mirrors backend/src/db/migrate.ts v44. `current_value` is the RAW value
-- (a goal may over-achieve; only the derived percentage is clamped to 100).
-- `target_value` may be NULL (pure milestone goal) but never 0. Deleting a goal
-- cascades its milestones; `milestones.event_id` is an optional link to an
-- existing event (ride the reminder engine) with ON DELETE SET NULL, so deleting
-- the event only unlinks and deleting the goal never touches the event.
-- ============================================================
CREATE TABLE IF NOT EXISTS goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  target_value NUMERIC CHECK (target_value IS NULL OR target_value > 0),
  current_value NUMERIC NOT NULL DEFAULT 0 CHECK (current_value >= 0),
  unit TEXT,
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  target_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done', 'abandoned')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT goals_target_after_start CHECK (target_date IS NULL OR target_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_goals_user_profile ON goals(user_id, profile_id);

CREATE TABLE IF NOT EXISTS milestones (
  id SERIAL PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_at DATE,
  done_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_milestones_goal ON milestones(goal_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_milestones_event ON milestones(event_id) WHERE event_id IS NOT NULL;

-- ============================================================
-- Initial schema version (v15 = all incremental migrations merged)
-- ============================================================
INSERT INTO schema_version (version) VALUES (16) ON CONFLICT DO NOTHING;
