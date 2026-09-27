import { createHash } from 'crypto';
import { query } from './index.js';
import { encrypt, decrypt } from '@timemark/shared/crypto';

/**
 * Auto-migration: applies incremental schema migrations at startup.
 * Full schema application (CREATE TABLE / initial data) is handled by
 * scripts/migrate-db.ts using shared/src/schema.pg.sql.
 *
 * This function only handles version-to-version migrations for existing
 * deployments that need new columns / tables added over time.
 */
export async function runMigrations(): Promise<void> {
  console.log('[DB] Running migrations...');

  // Check current schema version
  try {
    const result = await query('SELECT MAX(version) as version FROM schema_version');
    const currentVersion = (result.rows[0]?.version as number) || 0;
    console.log(`[DB] Current schema version: ${currentVersion}`);

    // Apply incremental migrations
    await applyIncrementalMigrations(currentVersion);
  } catch (error) {
    console.error('[DB] Failed to check schema version:', error);
  }
}

export async function applyIncrementalMigrations(currentVersion: number): Promise<void> {
  const migrations: Array<{
    version: number;
    name: string;
    sql: string;
    postMigrate?: () => Promise<void>;
  }> = [
    {
      version: 2,
      name: 'add_api_key_column',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS api_key TEXT;`
    },
    {
      version: 3,
      name: 'add_notification_queue',
      sql: `CREATE TABLE IF NOT EXISTS notification_queue (
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
      CREATE INDEX IF NOT EXISTS idx_notification_queue_user ON notification_queue(user_id);`
    },
    {
      version: 4,
      name: 'add_recurring_events',
      sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS recurring_config TEXT;`
    },
    {
      version: 5,
      name: 'add_next_occurrence',
      sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS next_occurrence TEXT;`
    },
    {
      version: 6,
      name: 'add_recurring_index',
      sql: `CREATE INDEX IF NOT EXISTS idx_events_next_occurrence ON events(next_occurrence);`
    },
    {
      version: 7,
      name: 'add_push_subscriptions',
      sql: `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        keys_p256dh TEXT,
        keys_auth TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, endpoint)
      );
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);`
    },
    {
      version: 8,
      name: 'add_timezone_column',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Asia/Shanghai';`
    },
    {
      version: 9,
      name: 'hash_existing_api_keys',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        // Hash existing plaintext API keys in-place (SHA-256)
        const result = await query('SELECT user_id, api_key FROM user_configs WHERE api_key IS NOT NULL');
        const rows = result.rows as Array<{ user_id: number; api_key: string }>;
        for (const row of rows) {
          // Skip if already hashed (64 hex chars = SHA-256 hash)
          if (row.api_key.length === 64 && /^[0-9a-f]+$/.test(row.api_key)) continue;
          const hash = createHash('sha256').update(row.api_key).digest('hex');
          await query('UPDATE user_configs SET api_key = $1 WHERE user_id = $2', [hash, row.user_id]);
        }
        if (rows.length > 0) {
          console.log(`[DB] Hashed ${rows.length} existing API key(s)`);
        }
      },
    },
    {
      version: 10,
      name: 'add_channel_results_column',
      sql: `ALTER TABLE event_trigger_logs ADD COLUMN IF NOT EXISTS channel_results TEXT;`
    },
    {
      version: 11,
      name: 'add_plugin_sessions',
      sql: `CREATE TABLE IF NOT EXISTS plugin_sessions (
        id SERIAL PRIMARY KEY,
        channel_type TEXT NOT NULL,
        session_id TEXT UNIQUE NOT NULL,
        session_data TEXT,
        status TEXT DEFAULT 'pending',
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_sessions_id ON plugin_sessions(session_id);
      CREATE INDEX IF NOT EXISTS idx_plugin_sessions_expires ON plugin_sessions(expires_at);`
    },
    {
      version: 12,
      name: 'add_trigger_log_failure_details',
      sql: `ALTER TABLE event_trigger_logs ADD COLUMN IF NOT EXISTS error_details TEXT;
ALTER TABLE event_trigger_logs ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE event_trigger_logs ADD COLUMN IF NOT EXISTS channel_type TEXT;
ALTER TABLE event_trigger_logs ADD COLUMN IF NOT EXISTS account_id INTEGER;`
    },
    {
      version: 13,
      name: 'add_connection_status',
      sql: `ALTER TABLE notification_accounts ADD COLUMN IF NOT EXISTS connection_status TEXT;`
    },
    {
      version: 14,
      name: 'add_test_result_columns',
      sql: `ALTER TABLE notification_accounts ADD COLUMN IF NOT EXISTS last_test_result TEXT;
ALTER TABLE notification_accounts ADD COLUMN IF NOT EXISTS last_test_at TEXT;`
    },
    {
      version: 16,
      name: 'vercel_free_tier_features',
      sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]';
ALTER TABLE events ADD COLUMN IF NOT EXISTS share_token TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_photo_url TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP;
ALTER TABLE event_trigger_logs ADD COLUMN IF NOT EXISTS read_at TIMESTAMP;
CREATE TABLE IF NOT EXISTS cron_execution_logs (
  id SERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  result_summary TEXT,
  error_message TEXT,
  executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cron_logs_job ON cron_execution_logs(job_name, executed_at);`
    },
    {
      version: 17,
      name: 'security_features_v17',
      sql: `CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  window_start TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_login_logs_ip_time ON login_logs(ip_address, login_time);
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS ip_whitelist JSONB DEFAULT '[]';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS ip_whitelist_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refresh_family TEXT;
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  device_name TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`
    },
    {
      version: 18,
      name: 'contacts_broadcast_v18',
      sql: `CREATE TABLE IF NOT EXISTS fixed_contacts (
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
  notes TEXT,
  validation_status TEXT DEFAULT 'pending',
  last_validated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_user ON fixed_contacts(user_id);
CREATE TABLE IF NOT EXISTS broadcast_campaigns (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  recipient_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  recipient_source TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_broadcast_campaigns_user ON broadcast_campaigns(user_id);
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS broadcast_id INTEGER REFERENCES broadcast_campaigns(id) ON DELETE SET NULL;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS email_opt_out BOOLEAN DEFAULT FALSE;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE;`
    },
    {
      version: 19,
      name: 'webauthn_challenges_v19',
      sql: `CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
ALTER TABLE webauthn_credentials ADD COLUMN IF NOT EXISTS transports TEXT;
ALTER TABLE webauthn_credentials ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP;`
    },
    {
      version: 20,
      name: 'totp_enabled_flag_v20',
      sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE;`,
      postMigrate: async () => {
        // Users who completed enable flow (logged in security_events)
        await query(
          `UPDATE users u SET totp_enabled = TRUE
           WHERE u.totp_secret IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM security_events se
               WHERE se.user_id = u.id AND se.event_type = 'totp_enabled'
             )`,
        );
        // Incomplete setup: secret written at /totp/setup but never confirmed at /totp/enable
        const cleared = await query(
          `UPDATE users SET totp_secret = NULL, totp_enabled = FALSE
           WHERE totp_secret IS NOT NULL AND COALESCE(totp_enabled, FALSE) = FALSE
           RETURNING id, username`,
        );
        if (cleared.rows.length > 0) {
          console.log(
            `[DB] Cleared incomplete TOTP setup for: ${cleared.rows.map((r: { username: string }) => r.username).join(', ')}`,
          );
        }
      },
    },
    {
      version: 21,
      name: 'notification_defaults_email_logs_v21',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS default_test_email TEXT;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS channel_type TEXT DEFAULT 'email';
CREATE INDEX IF NOT EXISTS idx_email_logs_user_sent ON email_logs(user_id, sent_at);
ALTER TABLE notification_queue ADD COLUMN IF NOT EXISTS account_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_notification_queue_retry ON notification_queue(status, next_retry_at);`,
    },
    {
      version: 22,
      name: 'integrations_v22',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS webhook_inbound_token TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS webhook_inbound_secret TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS calendar_feed_token TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS external_calendar_urls JSONB DEFAULT '[]';
ALTER TABLE events ADD COLUMN IF NOT EXISTS timezone TEXT;
CREATE TABLE IF NOT EXISTS event_reminder_cache (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '[]',
  expires_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_event_reminder_cache_expires ON event_reminder_cache(expires_at);`,
      postMigrate: async () => {
        const { randomBytes } = await import('crypto');
        const users = await query(
          `SELECT user_id FROM user_configs
           WHERE webhook_inbound_token IS NULL OR calendar_feed_token IS NULL`,
        );
        for (const row of users.rows as Array<{ user_id: number }>) {
          const webhookToken = randomBytes(24).toString('hex');
          const feedToken = randomBytes(24).toString('hex');
          const webhookSecret = randomBytes(32).toString('hex');
          await query(
            `UPDATE user_configs SET
               webhook_inbound_token = COALESCE(webhook_inbound_token, $1),
               calendar_feed_token = COALESCE(calendar_feed_token, $2),
               webhook_inbound_secret = COALESCE(webhook_inbound_secret, $3)
             WHERE user_id = $4`,
            [webhookToken, feedToken, webhookSecret, row.user_id],
          );
        }
      },
    },
    {
      version: 23,
      name: 'inbox_messages_v23',
      sql: `CREATE TABLE IF NOT EXISTS inbox_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  channel TEXT,
  event_id INTEGER,
  sender_label TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_user_created ON inbox_messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_user_unread ON inbox_messages(user_id, is_read);
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS inbox_receive_token TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS inbox_receive_secret TEXT;`,
      postMigrate: async () => {
        const { randomBytes } = await import('crypto');
        const users = await query(
          `SELECT user_id FROM user_configs WHERE inbox_receive_token IS NULL`,
        );
        for (const row of users.rows as Array<{ user_id: number }>) {
          const token = randomBytes(24).toString('hex');
          const secret = randomBytes(32).toString('hex');
          await query(
            `UPDATE user_configs SET
               inbox_receive_token = COALESCE(inbox_receive_token, $1),
               inbox_receive_secret = COALESCE(inbox_receive_secret, $2)
             WHERE user_id = $3`,
            [token, secret, row.user_id],
          );
        }
      },
    },
    {
      version: 24,
      name: 'optimizations_v24',
      sql: `CREATE TABLE IF NOT EXISTS webhook_idempotency_keys (
  id SERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  response_body TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_created ON webhook_idempotency_keys(created_at);
CREATE TABLE IF NOT EXISTS stats_daily (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  stat_date DATE NOT NULL,
  events_count INTEGER DEFAULT 0,
  triggers_total INTEGER DEFAULT 0,
  triggers_success INTEGER DEFAULT 0,
  triggers_failed INTEGER DEFAULT 0,
  UNIQUE(user_id, stat_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_dedup_success
  ON event_trigger_logs(event_id, trigger_date) WHERE status = 'success';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS calendar_feed_tokens JSONB DEFAULT '[]';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS external_calendar_sync_strategy TEXT DEFAULT 'add_only';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS api_scopes TEXT DEFAULT 'read,write';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS lunar_reminders_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS caldav_url TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS caldav_username TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS caldav_password_encrypted TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS outbound_webhook_url TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS resend_webhook_secret TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS markdown_email_template TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS notification_preset TEXT;`,
    },
    {
      version: 25,
      name: 'features_v25',
      sql: `CREATE TABLE IF NOT EXISTS contact_groups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS contact_group_members (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  UNIQUE(group_id, email)
);
CREATE TABLE IF NOT EXISTS conditional_reminder_rules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  days_before INTEGER NOT NULL,
  channels JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at DESC);`,
    },
    {
      version: 26,
      name: 'reminder_claims_v26',
      sql: `CREATE TABLE IF NOT EXISTS reminder_send_claims (
  event_id INTEGER NOT NULL,
  trigger_date TEXT NOT NULL,
  claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, trigger_date)
);
CREATE INDEX IF NOT EXISTS idx_reminder_claims_claimed ON reminder_send_claims(claimed_at);`,
    },
    {
      version: 27,
      name: 'google_oauth_calendar_v27',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS google_oauth_refresh_token_encrypted TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS google_oauth_email TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS google_calendar_id TEXT DEFAULT 'primary';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS google_oauth_connected_at TIMESTAMP;`,
    },
    {
      version: 28,
      name: 'alert_settings_v28',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS alert_emails JSONB DEFAULT '[]';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS alert_account_ids JSONB DEFAULT '[]';`,
    },
    {
      version: 29,
      name: 'todo_completions_v29',
      sql: `CREATE TABLE IF NOT EXISTS todo_completions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occurrence_date DATE NOT NULL,
  completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, event_id, occurrence_date)
);
CREATE INDEX IF NOT EXISTS idx_todo_completions_user ON todo_completions(user_id);`,
    },
    {
      version: 30,
      name: 'contact_methods_v30',
      sql: `ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS contact_methods JSONB DEFAULT '{}';
UPDATE fixed_contacts SET contact_methods = jsonb_build_object(
  'emails', CASE WHEN email IS NOT NULL AND email <> '' THEN jsonb_build_array(jsonb_build_object('label', '默认', 'value', email)) ELSE '[]'::jsonb END,
  'phones', CASE WHEN phone IS NOT NULL AND phone <> '' THEN jsonb_build_array(jsonb_build_object('label', '默认', 'value', phone)) ELSE '[]'::jsonb END,
  'telegrams', CASE WHEN telegram_chat_id IS NOT NULL AND telegram_chat_id <> '' THEN jsonb_build_array(jsonb_build_object('label', '默认', 'value', telegram_chat_id)) ELSE '[]'::jsonb END,
  'qqs', CASE WHEN qq IS NOT NULL AND qq <> '' THEN jsonb_build_array(jsonb_build_object('label', '默认', 'value', qq)) ELSE '[]'::jsonb END,
  'wxpusherUids', CASE WHEN wxpusher_uid IS NOT NULL AND wxpusher_uid <> '' THEN jsonb_build_array(jsonb_build_object('label', '默认', 'value', wxpusher_uid)) ELSE '[]'::jsonb END
) WHERE contact_methods IS NULL OR contact_methods = '{}'::jsonb;`,
    },
    {
      version: 31,
      name: 'contact_relationship_gender_v31',
      sql: `ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS relationship TEXT;
ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS gender TEXT DEFAULT 'unknown';`,
    },
    {
      version: 32,
      name: 'session_data_text_v32',
      sql: `ALTER TABLE notification_accounts ADD COLUMN IF NOT EXISTS session_data_text TEXT;`,
      postMigrate: async () => {
        const result = await query(
          `SELECT id, session_data, session_data_text FROM notification_accounts
           WHERE session_data IS NOT NULL AND session_data_text IS NULL`
        );
        for (const row of result.rows as Array<{ id: number; session_data: unknown }>) {
          const raw = row.session_data;
          let textValue: string | null = null;
          if (raw == null) {
            textValue = null;
          } else if (typeof raw === 'string') {
            textValue = raw;
          } else if (typeof raw === 'object') {
            // JSONB string primitive or legacy plain object — both become TEXT for AES storage
            const asAny = raw as { smtpProvider?: string };
            if (typeof asAny.smtpProvider === 'string' || Object.keys(raw as object).length > 0) {
              textValue = JSON.stringify(raw);
            }
          }
          if (textValue != null) {
            await query(
              'UPDATE notification_accounts SET session_data_text = $1 WHERE id = $2',
              [textValue, row.id]
            );
          }
        }
        await query('ALTER TABLE notification_accounts DROP COLUMN IF EXISTS session_data;');
        await query(
          'ALTER TABLE notification_accounts RENAME COLUMN session_data_text TO session_data;'
        );
      },
    },
    {
      // v33 (todo 41): bound the growth of logging tables + add the missing indexes.
      // Additive and idempotent: every statement is IF NOT EXISTS-guarded and
      // nothing is dropped or rewritten. The DO block only fires for tables that
      // a later migration may have created (expiry_items); it is a no-op today.
      version: 33,
      name: 'logging_indexes_retention_v33',
      sql: `-- pg_trgm powers CJK substring search through GIN trigram indexes, no external calls
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Trigram indexes on the existing searchable text columns
CREATE INDEX IF NOT EXISTS idx_events_name_trgm ON events USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_events_person_name_trgm ON events USING gin (person_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_events_tags_trgm ON events USING gin ((tags::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_name_trgm ON fixed_contacts USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_nickname_trgm ON fixed_contacts USING gin (nickname gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_notes_trgm ON fixed_contacts USING gin (notes gin_trgm_ops);
-- Missing access-path indexes for the logging tables
CREATE INDEX IF NOT EXISTS idx_trigger_logs_user_created ON event_trigger_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trigger_logs_consecutive ON event_trigger_logs(account_id, channel_type, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_user_sent_desc ON email_logs(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_queue_retry ON notification_queue(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_last_attempt ON login_attempts(last_attempt);
-- Forward-looking trigram indexes for tables created by a later migration
DO $$
BEGIN
  IF to_regclass('expiry_items') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_expiry_items_title_trgm ON expiry_items USING gin (title gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_expiry_items_vendor_trgm ON expiry_items USING gin (vendor gin_trgm_ops);
  END IF;
END $$;`,
    },
    {
      // v34 (todo 44): expiry-item domain - subscriptions, bills, insurance, domains,
      // warranties, custom - plus its renew audit history (todo 45 writes it).
      // The plan text said "version 32", but 32 (session_data_text_v32) and 33
      // (logging_indexes_retention_v33) were already taken when this landed, so the
      // next free number is 34. Additive and idempotent: every statement is
      // IF NOT EXISTS-guarded and nothing existing is altered, dropped or rewritten.
      version: 34,
      name: 'expiry_items_v34',
      sql: `-- Expiry items are a distinct entity from events: they carry cost/cycle metadata
-- and emit reminders through the shared engine (jobs/tasks.ts sendExpiryReminders).
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
-- Fulfils the forward-looking trigram block v33 documented: it ran before this table
-- existed, so on a fresh DB the title/vendor trgm indexes were never created. Guarded
-- so a DB without pg_trgm (v33 failed on CREATE EXTENSION) still gets the tables.
DO $$
BEGIN
  IF to_regclass('expiry_items') IS NOT NULL THEN
    BEGIN
      CREATE INDEX IF NOT EXISTS idx_expiry_items_title_trgm ON expiry_items USING gin (title gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_expiry_items_vendor_trgm ON expiry_items USING gin (vendor gin_trgm_ops);
    EXCEPTION WHEN undefined_object THEN
      -- pg_trgm is unavailable; the q filter falls back to ILIKE
      NULL;
    END;
  END IF;
END $$;`,
    },
    {
      // v35 (todo 49): inventory domain - quantity, expiry date and low-stock threshold.
      // The plan text said "version: 33", but 33 (logging_indexes_retention_v33) and 34
      // (expiry_items_v34) were already taken when this landed, so the next free number
      // is 35 (the expiry lane owns 34). Additive and idempotent: every statement is
      // IF NOT EXISTS-guarded and nothing existing is altered, dropped or rewritten.
      // expires_at is NULLABLE on purpose: a non-perishable never enters the expiring
      // query (which guards `expires_at IS NOT NULL`).
      version: 35,
      name: 'inventory_items_v35',
      sql: `-- Inventory items are consumables: quantity + low_stock_threshold + optional expiry.
-- Reminders for rows with expires_at reuse the shared engine (jobs/tasks.ts) with
-- an inventory:-prefixed claim key, so no second scheduler exists.
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
-- Forward-looking trigram for the q filter; guarded because pg_trgm may be absent
-- (v33 failed on CREATE EXTENSION in that case). Mirrors the v34 block.
DO $$
BEGIN
  IF to_regclass('inventory_items') IS NOT NULL THEN
    BEGIN
      CREATE INDEX IF NOT EXISTS idx_inventory_items_name_trgm ON inventory_items USING gin (name gin_trgm_ops);
    EXCEPTION WHEN undefined_object THEN
      -- pg_trgm is unavailable; the q filter falls back to ILIKE
      NULL;
    END;
  END IF;
END $$;`,
    },
    {
      // v36 (todo 50): maintenance plans with a date interval (reminders through the
      // shared engine) and/or a usage interval (inbox nudge at 10% remaining), plus
      // the maintenance_logs audit table. The plan text said "version: 34", but the
      // expiry lane owns 34, so this is 36. Additive and idempotent: every statement
      // is IF NOT EXISTS-guarded and nothing existing is altered, dropped or rewritten.
      // The table-level CHECK enforces the API-level rule that at least one interval
      // must be set; it only applies on fresh table creation (idempotent no-op elsewhere).
      version: 36,
      name: 'maintenance_plans_v36',
      sql: `-- Date interval -> next_due_at/date reminders; usage interval -> next_due_usage +
-- inbox nudge within 10%. Neither is a hard requirement alone, at least one is.
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
CREATE INDEX IF NOT EXISTS idx_maintenance_logs_plan ON maintenance_logs(plan_id, done_at DESC);`,
    },
    {
      // v37 (todo 52): attachment metadata for the D2 document vault. The plan text said
      // "version: 35", but 35 (inventory) and 36 (maintenance) were already taken when this
      // landed, so the next free number is 37. Bytes live in object storage (Vercel Blob, or
      // the dev-only .data/ fallback) - NEVER in Postgres (Neon Free is 0.5 GB/project total).
      // Additive and idempotent: every statement is IF NOT EXISTS-guarded; no columns are
      // altered and no data is dropped or rewritten.
      //
      // Polymorphic owner: (owner_type, owner_id) points at a user-owned row in
      // documents / expiry_items / inventory_items / maintenance_plans / events.
      // Both columns are nullable as a PAIR (CHECK below): an attachment can be uploaded
      // scoped to an owner and later unlinked without deleting the object.
      version: 37,
      name: 'attachments_v37',
      sql: `CREATE TABLE IF NOT EXISTS attachments (
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
CREATE INDEX IF NOT EXISTS idx_attachments_user_owner ON attachments(user_id, owner_type, owner_id);`,
    },
    {
      // v38 (todo 54): the document vault (passport / id_card / driver_license / visa /
      // certificate / policy / contract / other). The plan text said "version: 36", but 36
      // (maintenance) was already taken when this landed, so the next free number is 38.
      // `document_number_encrypted` holds an AES-256-GCM ciphertext (same MASTER_KEY
      // convention as notification credentials) and is NEVER returned by list responses -
      // only a `numberConfigured` flag is. Document images live in the attachment store;
      // this table stores no bytes. Additive and idempotent: every statement is
      // IF NOT EXISTS-guarded; no columns are altered and no data is dropped or rewritten.
      version: 38,
      name: 'documents_v38',
      sql: `CREATE TABLE IF NOT EXISTS documents (
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
-- Forward-looking trigram for the q filter; guarded because pg_trgm may be absent
-- (v33 failed on CREATE EXTENSION in that case). Mirrors the v34/v35 blocks.
DO $$
BEGIN
  IF to_regclass('documents') IS NOT NULL THEN
    BEGIN
      CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING gin (title gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_documents_issuer_trgm ON documents USING gin (issuer gin_trgm_ops);
    EXCEPTION WHEN undefined_object THEN
      -- pg_trgm is unavailable; the q filter falls back to ILIKE
      NULL;
    END;
  END IF;
END $$;`,
    },
    {
      // v39 (todo 60): personal-CRM interaction log + cadence (D4). The plan text said
      // "version: 37", but 37 (attachments) and 38 (documents) were already taken when
      // this landed, so the next free number is 39. Additive and idempotent: every
      // statement is IF NOT EXISTS-guarded; the only UPDATE is the guarded one-time
      // `last_contact_at` backfill in postMigrate (rows with the column already set are
      // untouched). `fixed_contacts.contact_methods` (v30 JSONB) stays the single source
      // of truth for addresses - no contact-method columns are duplicated here.
      //
      // `interactions.user_id` is denormalized from `fixed_contacts.user_id` on purpose:
      // it makes the (user_id, contact_id, occurred_at DESC) timeline index a covering
      // access path and keeps every read user-scoped even if the join is forgotten.
      version: 39,
      name: 'crm_interactions_cadence_v39',
      sql: `ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS cadence_days INT NULL;
ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ NULL;
ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS cadence_enabled BOOLEAN DEFAULT FALSE;
-- Interaction log: one row per real touchpoint (call/message/meeting/...).
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
-- Promises made to (or by) a contact; due_at NULL = "someday".
CREATE TABLE IF NOT EXISTS contact_promises (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES fixed_contacts(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  due_at DATE,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_promises_contact ON contact_promises(contact_id, created_at DESC);
-- Gift ledger: what was given to / received from a contact.
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
CREATE INDEX IF NOT EXISTS idx_gift_records_contact ON gift_records(contact_id, occurred_at DESC);`,
      postMigrate: async () => {
        // One-time backfill: when the stored anchor is missing, take the newest
        // interaction. Contacts that already have a value (or no interactions) are
        // left untouched, so re-running this is a no-op.
        const backfilled = await query(
          `UPDATE fixed_contacts fc
           SET last_contact_at = latest.max_occurred
           FROM (
             SELECT contact_id, MAX(occurred_at) AS max_occurred
             FROM interactions
             GROUP BY contact_id
           ) latest
           WHERE fc.id = latest.contact_id
             AND fc.last_contact_at IS NULL`,
        );
        if (backfilled.rowCount > 0) {
          console.log(`[DB] Backfilled last_contact_at for ${backfilled.rowCount} contact(s)`);
        }
      },
    },
    {
      // v40 (todo 64): habit tracking (D6) - habits + habit_logs with per-period targets,
      // schedule days and reminder times, plus the per-user hour for the nightly
      // "streak at risk" nudge. The plan text said "version: 38", but 38 (documents) and
      // 39 (CRM interactions/cadence) were already taken when this landed, so the next
      // free number is 40. Additive and idempotent: every statement is IF NOT EXISTS-
      // guarded; the only ALTER is an additive ADD COLUMN IF NOT EXISTS on user_configs.
      // `UNIQUE (habit_id, logged_on)` makes same-day logging an UPSERT (count += n),
      // never a second row. This is NOT todo_completions (v29) - habits are their own
      // concept (day/week periods, targets, schedule/reminder configuration).
      version: 40,
      name: 'habits_v40',
      sql: `CREATE TABLE IF NOT EXISTS habits (
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
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS habit_streak_nudge_hour TEXT DEFAULT '20:00';`,
    },
  ];

  for (const migration of migrations) {
    if (currentVersion < migration.version) {
      try {
        console.log(`[DB] Applying migration v${migration.version}: ${migration.name}`);
        await query(migration.sql);
        if (migration.postMigrate) {
          await migration.postMigrate();
        }
        await query(
          'INSERT INTO schema_version (version, applied_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (version) DO UPDATE SET applied_at = CURRENT_TIMESTAMP',
          [migration.version]
        );
        console.log(`[DB] Migration v${migration.version} applied successfully`);
      } catch (error) {
        console.error(`[DB] Migration v${migration.version} failed:`, error);
      }
    }
  }
}

// The old hardcoded default key used before auto-generation was implemented.
const LEGACY_MASTER_KEY = 'timemark-default-master-key-change-in-production-2026';

/**
 * One-time migration: re-encrypt notification_accounts from legacy key to new key.
 * Runs on startup after schema migrations. Safe to run multiple times (idempotent).
 */
export async function migrateEncryptionKey(): Promise<void> {
  const currentKey = process.env.MASTER_KEY;
  if (!currentKey) {
    console.warn('[Migration] MASTER_KEY not set, skipping encryption migration');
    return;
  }

  // If the current key IS the legacy key, no migration needed
  if (currentKey === LEGACY_MASTER_KEY) {
    return;
  }

  // Migrate notification_accounts
  const encryptedFields = ['webhook', 'token', 'secret', 'chat_id', 'session_data'];
  const accountsResult = await query(
    'SELECT id, webhook, token, secret, chat_id, session_data FROM notification_accounts'
  );
  const rows = accountsResult.rows as Array<{ id: number; [key: string]: any }>;

  let migratedCount = 0;
  for (const row of rows) {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIdx = 0;

    for (const field of encryptedFields) {
      let value = row[field];
      if (!value) continue;

      if (field === 'session_data' && typeof value === 'object' && value !== null) {
        value = JSON.stringify(value);
      }
      if (typeof value !== 'string') continue;

      // Try decrypting with current key - if it works, already migrated
      try {
        decrypt(value, currentKey);
        continue; // Already encrypted with current key
      } catch {
        // Current key failed
      }

      // Try legacy key
      try {
        const plaintext = decrypt(value, LEGACY_MASTER_KEY);
        const reEncrypted = encrypt(plaintext, currentKey);
        paramIdx++;
        updates.push(`${field} = $${paramIdx}`);
        values.push(reEncrypted);
      } catch {
        // Both keys failed - might be plaintext or corrupted, skip
        continue;
      }
    }

    if (updates.length > 0) {
      paramIdx++;
      values.push(row.id);
      await query(
        `UPDATE notification_accounts SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
        values
      );
      migratedCount++;
    }
  }

  if (migratedCount > 0) {
    console.log(`[Migration] Migrated ${migratedCount} notification account(s) from legacy key`);
  }

  // Migrate user_configs
  const configFields = [
    'encrypted_resend_key', 'encrypted_github_token', 'encrypted_feishu_webhook',
    'encrypted_wecom_webhook', 'encrypted_dingtalk_webhook', 'encrypted_dingtalk_secret',
    'encrypted_telegram_bot_token', 'encrypted_discord_webhook', 'encrypted_slack_webhook',
    'encrypted_wxpusher_app_token', 'encrypted_wxpusher_uid', 'encrypted_qmsg_key',
    'encrypted_qmsg_qq', 'encrypted_channel_webhooks'
  ];

  const configResult = await query(
    `SELECT user_id, ${configFields.join(', ')} FROM user_configs`
  );
  const configRows = configResult.rows as Array<{ user_id: number; [key: string]: any }>;

  let configMigratedCount = 0;
  for (const row of configRows) {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIdx = 0;

    for (const field of configFields) {
      const value = row[field];
      if (!value) continue;

      // Try decrypting with current key
      try {
        decrypt(value, currentKey);
        continue; // Already encrypted with current key
      } catch {
        // Current key failed
      }

      // Try legacy key
      try {
        const plaintext = decrypt(value, LEGACY_MASTER_KEY);
        const reEncrypted = encrypt(plaintext, currentKey);
        paramIdx++;
        updates.push(`${field} = $${paramIdx}`);
        values.push(reEncrypted);
      } catch {
        // Both keys failed, skip
        continue;
      }
    }

    if (updates.length > 0) {
      paramIdx++;
      values.push(row.user_id);
      await query(
        `UPDATE user_configs SET ${updates.join(', ')} WHERE user_id = $${paramIdx}`,
        values
      );
      configMigratedCount++;
    }
  }

  if (configMigratedCount > 0) {
    console.log(`[Migration] Migrated ${configMigratedCount} user config(s) from legacy key`);
  }

  if (migratedCount === 0 && configMigratedCount === 0) {
    console.log('[Migration] No legacy-encrypted data found, encryption migration complete');
  }
}
