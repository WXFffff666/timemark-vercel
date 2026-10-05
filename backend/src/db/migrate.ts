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

/**
 * Tables that carry the nullable `profile_id` added by v41 and are backfilled to the
 * owner's default `我` profile. `medications` (v42) is created after that backfill runs
 * and has no pre-existing rows, so it is not part of the v41 backfill list.
 */
const PROFILE_AWARE_TABLES = [
  'events',
  'fixed_contacts',
  'expiry_items',
  'inventory_items',
  'maintenance_plans',
  'documents',
  'habits',
] as const;

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
      // D5 (checkbox 97): this statement used to say `next_occurrence TEXT`, but the
      // `events` table is created by `shared/src/schema.pg.sql` (the full schema applied by
      // scripts/migrate-db.ts BEFORE runMigrations) with `next_occurrence DATE`, and the
      // incremental chain starts at v2 - no migration ever created `events`. So the TEXT
      // intent never took effect anywhere: on every real database the column already exists
      // with DATE and `ADD COLUMN IF NOT EXISTS` is a no-op. `event.service.ts` passes
      // JS date strings, `digest.service.ts` compares it as a date and `og.ts` types it
      // `Date | string | null` - all DATE-compatible. Aligned to DATE so the two sources
      // of truth agree; no live column type is altered (a real DB is already DATE).
      version: 5,
      name: 'add_next_occurrence',
      sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS next_occurrence DATE;`
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
    {
      // v41 (todo 68): household member profiles (D5). The plan text said "version: 39", but
      // 39 (CRM) and 40 (habits) were already taken when this landed, so the next free number
      // is 41. This is a PERSONAL household model (self/family/pet) - no organisations, no
      // teams, no seats, no multi-tenancy. `profile_id` is nullable everywhere on purpose
      // (future imports may omit it) and references profiles ON DELETE SET NULL, so deleting
      // a profile orphans its rows back to "unassigned" instead of deleting data.
      //
      // Additive and idempotent: every statement is IF NOT EXISTS / existence-guarded and the
      // only data writes are in postMigrate - the default `我` profile INSERT (guarded by
      // NOT EXISTS kind='self') and the NULL-only backfill of profile_id. Re-running creates
      // no second `我` and rewrites nothing.
      //
      // v34-v40 created five of these columns BARE (no FK): ADD COLUMN IF NOT EXISTS is a
      // no-op when the column already exists, so the DO block below attaches the FK for any
      // table that has the column without the constraint - first nulling values that point at
      // no profile (profiles is brand new, so every pre-existing value is dangling; postMigrate
      // re-points them at the user's default profile).
      version: 41,
      name: 'profiles_v41',
      sql: `CREATE TABLE IF NOT EXISTS profiles (
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
-- Exactly one self profile per user (the 我 default); family/pet profiles are unlimited.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_profiles_user_self ON profiles(user_id) WHERE kind = 'self';
ALTER TABLE events ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE expiry_items ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
-- medications is created by v42, which lands AFTER this migration: guard so a database where
-- the table already exists still gets the column; v42 adds it for the table it creates.
DO $$
BEGIN
  IF to_regclass('medications') IS NOT NULL THEN
    ALTER TABLE medications ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;
END $$;
-- Attach the FK to columns that already existed bare (v34 expiry, v35 inventory, v36 maintenance,
-- v38 documents, v40 habits). Also covers events/fixed_contacts on a database pre-created from
-- shared/src/schema.pg.sql. The repair only nulls dangling values and only on first run.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['events', 'fixed_contacts', 'expiry_items', 'inventory_items', 'maintenance_plans', 'documents', 'habits'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
      WHERE cl.relname = t AND c.conname = t || '_profile_id_fkey' AND c.contype = 'f'
    ) THEN
      EXECUTE format('UPDATE %I SET profile_id = NULL WHERE profile_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = %I.profile_id)', t, t);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL', t, t || '_profile_id_fkey');
    END IF;
  END LOOP;
END $$;
-- (user_id, profile_id) covering index on every table the profile filter can scope (todo 69).
CREATE INDEX IF NOT EXISTS idx_events_user_profile ON events(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_user_profile ON fixed_contacts(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_expiry_items_user_profile ON expiry_items(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_user_profile ON inventory_items(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_user_profile ON maintenance_plans(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_documents_user_profile ON documents(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_habits_user_profile ON habits(user_id, profile_id);`,
      postMigrate: async () => {
        // One default profile per user (`我`, kind='self'). The NOT EXISTS guard makes a
        // re-run a no-op - never a second 我. (The partial unique index enforces the same
        // invariant at the schema level.)
        const created = await query(
          `INSERT INTO profiles (user_id, name, kind)
           SELECT u.id, '我', 'self' FROM users u
           WHERE NOT EXISTS (
             SELECT 1 FROM profiles p WHERE p.user_id = u.id AND p.kind = 'self'
           )`,
        );
        if (created.rowCount && created.rowCount > 0) {
          console.log(`[DB] Created ${created.rowCount} default profile(s) 我`);
        }

        // Backfill every pre-existing row to the owner's default profile. NULL-only, so
        // re-running this never overwrites an explicit assignment.
        let backfilled = 0;
        for (const table of PROFILE_AWARE_TABLES) {
          const updated = await query(
            `UPDATE ${table} t SET profile_id = p.id
             FROM profiles p
             WHERE t.profile_id IS NULL AND p.user_id = t.user_id AND p.kind = 'self'`,
          );
          backfilled += updated.rowCount ?? 0;
        }
        if (backfilled > 0) {
          console.log(`[DB] Backfilled profile_id for ${backfilled} row(s)`);
        }
      },
    },
    {
      // v42 (todo 71): medication domain (D3) - medications + their dose log. The plan
      // text said "version: 41", but 41 (profiles) was taken by todo 68 when this landed,
      // so the next free number is 42. Reminder and log ONLY: no medical advice, no
      // pharmacy integration, no AI features on this data (all explicitly out of scope).
      //
      // Additive and idempotent: every statement is IF NOT EXISTS-guarded; the only ALTER
      // is ADD COLUMN IF NOT EXISTS (for a pre-existing medications table, parity with
      // v41's guarded block). `profile_id` is nullable (ON DELETE SET NULL), created
      // inline here AND guarded so both fresh and pre-created databases converge.
      //
      // `schedule_times TEXT[]` is NOT NULL DEFAULT '{}' on purpose: an empty array is a
      // valid PRN / as-needed regimen and materialises zero scheduled doses, while NULL
      // would force every reader to special-case it. `UNIQUE (medication_id,
      // scheduled_for)` is what makes dose materialisation idempotent - inserting the
      // same scheduled instant twice is rejected, never a second row.
      version: 42,
      name: 'medications_v42',
      sql: `CREATE TABLE IF NOT EXISTS medications (
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
  UNIQUE (medication_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_medication_doses_user_scheduled ON medication_doses(user_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_medication_doses_med_status ON medication_doses(medication_id, status);
ALTER TABLE medications ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;`,
    },
    {
      // v43 (todo 70): per-profile notification routing. The plan text said
      // "migration 40", but 40 (habits), 41 (profiles) and 42 (medications) were
      // already taken when this landed, so the next free number is 43.
      //
      // `profile_channel_accounts(profile_id, account_id)` is the join table that
      // decides WHICH channel accounts receive a profile's reminders. Semantics:
      //   - rows exist for a profile  -> only those accounts are eligible (explicit
      //     routing wins), an event-level `notification_account_ids` binding stays
      //     authoritative regardless;
      //   - no rows for a profile     -> fall back to ALL active accounts (the
      //     pre-routing behaviour, so nothing changes for existing users).
      //
      // Additive and idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT
      // EXISTS only, no data writes, no ALTER of existing tables. Both FKs are
      // ON DELETE CASCADE: deleting a profile or an account removes its routing
      // rows, never the other side. The PK makes the pair unique (a profile cannot
      // route to the same account twice). Same-user ownership is enforced by the
      // API (profile.service) because profiles and accounts are both user-scoped.
      version: 43,
      name: 'profile_channel_accounts_v43',
      sql: `CREATE TABLE IF NOT EXISTS profile_channel_accounts (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES notification_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_channel_accounts_account ON profile_channel_accounts(account_id);`,
    },
    {
      // v44 (todo 81): personal goals + milestones with progress tracking. The plan
      // text said "version: 42", but 42 (medications) and 43 (per-profile routing)
      // were already taken when this landed, so the next free number is 44.
      //
      // Additive and idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
      // no ALTER of existing tables and no data writes. This is a personal
      // checklist - no OKR jargon, no team features.
      //
      // - `current_value` stores the RAW value on purpose: a goal may over-achieve
      //   (150 of 100) and only the derived percentage is clamped to 100 - never
      //   the stored value.
      // - `target_value` is NULLable (a pure milestone goal) but never 0 (a zero
      //   denominator makes the percentage meaningless) - the CHECK guards it.
      // - `milestones.goal_id` is ON DELETE CASCADE: deleting a goal removes its
      //   checklist.
      // - `milestones.event_id` is an OPTIONAL link to the existing events
      //   reminder engine: a linked milestone rides that event's reminders.
      //   ON DELETE SET NULL, so deleting the event only unlinks the milestone,
      //   and deleting the goal never touches the event row.
      version: 44,
      name: 'goals_milestones_v44',
      sql: `CREATE TABLE IF NOT EXISTS goals (
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
CREATE INDEX IF NOT EXISTS idx_milestones_event ON milestones(event_id) WHERE event_id IS NOT NULL;`,
    },
    {
      // v45 (checkbox 78): holiday-aware reminders + optional 节气 reminders.
      // Two additive user_configs columns; both default to the pre-v45 behaviour
      // (`keep` + empty list), so every existing row is unchanged until the user
      // opts in from Settings. No data backfill, no constraint on existing rows.
      version: 45,
      name: 'holiday_jieqi_reminders_v45',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS holiday_reminder_mode TEXT DEFAULT 'keep';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS jieqi_reminder_list JSONB DEFAULT '[]'::jsonb;`,
    },
    {
      // v46 (checkbox 80): digest preferences - enabled / period / recipient override /
      // which sections to include / which configured email channel to deliver through.
      //
      // Purely additive user_configs columns with defaults that preserve the pre-v46
      // behaviour: the checkbox-79 cron sent a monthly digest to every account, so
      // `digest_enabled` defaults to TRUE (a user has to explicitly opt out);
      // `digest_sections` NULL means "all sections"; `digest_recipients` defaults to
      // an empty list (= fall back to resolveRecipientEmails).
      //
      // Every statement is ADD COLUMN IF NOT EXISTS-guarded: idempotent, purely
      // additive, no ALTER of existing columns, no data backfill, no constraint on
      // existing rows. `digest_channel_account_id` is intentionally an unconstrained
      // integer (ownership / email-capability are validated in the API layer).
      version: 46,
      name: 'digest_preferences_v46',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS digest_period TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS digest_recipients JSONB DEFAULT '[]'::jsonb;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS digest_sections JSONB;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS digest_channel_account_id INTEGER;`,
    },
    {
      // v47 (checkbox 86): opt-in CalDAV write-back. Adds the per-user toggle
      // (default OFF, so nothing changes until a user explicitly enables it), the
      // target collection URL (kept separate from `caldav_url`, the read-only import
      // URL, so the write target is never the calendar we import from), and the
      // remote-object bookkeeping table that stores the stable UID / last ETag /
      // content hash needed for create-with-If-None-Match, update-with-If-Match and
      // delete-with-If-Match on later cron runs.
      //
      // Purely additive and idempotent: every statement is IF NOT EXISTS-guarded, no
      // existing column is altered or dropped, nothing is backfilled, and the new
      // table starts empty (no writes happen while the toggle is off).
      version: 47,
      name: 'caldav_writeback_v47',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS caldav_writeback_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS caldav_writeback_url TEXT;
CREATE TABLE IF NOT EXISTS caldav_writeback_objects (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('event', 'expiry_item')),
  entity_id INTEGER NOT NULL,
  uid TEXT NOT NULL,
  collection_url TEXT NOT NULL,
  etag TEXT,
  content_hash TEXT,
  last_pushed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_caldav_writeback_objects_user ON caldav_writeback_objects(user_id);`,
    },
    {
      // v48 (checkbox 89): opt-in public ICS subscription feeds. Each row is a saved
      // filter (a category, a profile, or a contact) plus the SHA-256 HASH of the
      // public token. Only the hash is stored - the raw token is shown exactly once
      // at creation, so a database read can never reconstruct a subscription URL.
      // `revoked_at` is a soft delete: the public route only serves rows with
      // `revoked_at IS NULL`, and the hash is kept forever so a revoked feed can
      // never be silently resurrected by a token collision.
      //
      // Purely additive and idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS
      // only, no ALTER of existing tables, no backfill, and the table starts empty
      // (nothing is ever served until a user explicitly creates a feed).
      version: 48,
      name: 'ics_feeds_v48',
      sql: `CREATE TABLE IF NOT EXISTS ics_feeds (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "filter" JSONB NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_access_at TIMESTAMP,
  revoked_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ics_feeds_token_hash ON ics_feeds(token_hash);
CREATE INDEX IF NOT EXISTS idx_ics_feeds_user ON ics_feeds(user_id);`,
    },
    {
      // Checkbox 91 (D7 Telegram bot): `bot_updates` is the Telegram webhook dedup ledger.
      // Telegram retries an update until it is ACKed, so we claim each `update_id` with an
      // INSERT ... ON CONFLICT DO NOTHING before processing: a retry then ACKs 200 without
      // re-executing the command. Purely additive and idempotent (CREATE TABLE / CREATE INDEX
      // IF NOT EXISTS only, no ALTER of existing tables, no backfill, table starts empty).
      version: 49,
      name: 'bot_updates_v49',
      sql: `CREATE TABLE IF NOT EXISTS bot_updates (
  update_id BIGINT PRIMARY KEY,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bot_updates_received_at ON bot_updates(received_at);`,
    },
    {
      // Checkbox 94 (D7 Telegram bot): chat <-> user/profile linking and the redacted
      // command audit trail. Never auto-linked: a chat becomes linked only by consuming a
      // code that was generated from Settings (`bot_link_codes`), and `/unlink` sets
      // `revoked_at` (soft delete - an unlinked chat is refused by the dispatcher).
      //
      // `bot_link_codes` stores ONLY the SHA-256 hash of a short-lived (10 min), single-use
      // code, so a database read can never reconstruct a valid code; consumption is an
      // atomic UPDATE ... WHERE used_at IS NULL AND expires_at > CURRENT_TIMESTAMP, so a
      // code can be redeemed at most once even under concurrent deliveries.
      //
      // `bot_audit_logs` records one row per command: the command name, a WHITELIST-built
      // `args_redacted` shape (count/kind only - argument values, codes and tokens are
      // never written) and a short `result` summary. `UNIQUE (platform, chat_id)` on
      // `bot_links` makes a repeated `/link` from the same chat an UPDATE, never a
      // duplicate row. Purely additive and idempotent: CREATE TABLE / CREATE INDEX
      // IF NOT EXISTS only, no ALTER of existing tables, no backfill, tables start empty.
      version: 50,
      name: 'bot_links_v50',
      sql: `CREATE TABLE IF NOT EXISTS bot_links (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_type TEXT,
  active_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP,
  UNIQUE (platform, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_links_user ON bot_links(user_id);
CREATE TABLE IF NOT EXISTS bot_link_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_link_codes_code_hash ON bot_link_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_bot_link_codes_user ON bot_link_codes(user_id);
CREATE TABLE IF NOT EXISTS bot_audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  command TEXT NOT NULL,
  args_redacted TEXT,
  result TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bot_audit_logs_user ON bot_audit_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_audit_logs_chat ON bot_audit_logs(platform, chat_id, created_at);`,
    },
    {
      // v51 (checkbox 97, defects D2/D5): `/snooze` persistence.
      //
      // `events.next_occurrence` is a DATE column (schema.pg.sql) so a minute-granularity
      // snooze cannot live there - Postgres truncates the sub-day result back to a date and
      // the UPDATE silently stored the same day (delta 0 ms). The explicit snooze deadline
      // therefore gets its OWN timestamptz column; `date` / `next_occurrence` stay canonical
      // and untouched, which is what keeps a snooze reversible.
      //
      // `snoozed_until` semantics (reminder loop in jobs/tasks.ts): the deadline is the
      // instant the user requested (`NOW() + N minutes` FROM THE REQUEST TIME, not from the
      // original target time), and the existing ±2-minute reminder window fires the event
      // once when the deadline enters it (deduped through `reminder_send_claims` with a
      // `snooze:event#` key). Before the deadline the event is suppressed; after the window
      // has passed the normal day-based schedule resumes untouched.
      //
      // This migration ALSO aligns `event_trigger_logs.trigger_date` with the value the
      // reminder machinery actually writes there: `buildReminderSendKey()` returns a dedup
      // TOKEN (`YYYY-MM-DD#d<n>#tHH:mm`), the paired store `reminder_send_claims.trigger_date`
      // is TEXT, and `tasks.ts` compares that same token against this column before sending.
      // `shared/src/schema.pg.sql` declared it DATE, so on a real engine the pre-check raised
      // `invalid input syntax for type date: "...#d0#t..."` and `recordEventTrigger` silently
      // dropped every event-reminder log - meaning NO event reminder (snoozed or normal) could
      // be delivered on a fresh database. Proven live (PGlite, schema + migrations):
      //   SELECT ... WHERE trigger_date = '2026-09-28#d0#t09:00' -> 22007 invalid input syntax
      //   INSERT INTO event_trigger_logs (..., trigger_date, ...) VALUES (...,?,...) -> 22007
      // The `USING trigger_date::text` cast is lossless for existing DATE rows
      // ('2026-09-28' -> '2026-09-28') and re-running is a no-op for a TEXT column.
      // Consumers of the year (routes/features.ts annual report) read the first 4 chars, so
      // both legacy dates and new tokens keep working.
      //
      // Everything here is idempotent; no backfill. Fresh installs get snoozed_until here
      // because schema.pg.sql is not modified by this lane (shared/ is frozen for the D1 fix).
      version: 51,
      name: 'event_snoozed_until_v51',
      sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
ALTER TABLE event_trigger_logs ALTER COLUMN trigger_date TYPE TEXT USING trigger_date::text;`,
    },
    {
      // v52 (checkbox 105): deterministic behavioral-pattern store. One row per
      // (user, kind, key) with a JSONB value, a confidence in [0,1] and the number of
      // consistent observations behind it. Written ONLY by the nightly recompute in
      // `services/patterns.service.ts` (daily-maintenance) from rows already present in
      // the database - no LLM, no external call, nothing leaves the box.
      //
      // `key` is a plain TEXT bucket label (e.g. `08:00`, `d1`, `email`, weekday `3`,
      // contact id) so a re-run UPSERTs the same row instead of appending history;
      // `computed_at` records the last recompute. Rows with confidence < 0.5 are kept
      // (they become meaningful as evidence accumulates) but the API filters them out.
      //
      // Purely additive and idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
      // no ALTER of existing tables, no backfill, no data migration, table starts empty.
      version: 52,
      name: 'user_patterns_v52',
      sql: `CREATE TABLE IF NOT EXISTS user_patterns (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_user_patterns_user ON user_patterns(user_id);`,
    },
    {
      // v53 (checkbox 106): full-text-ish search over the user's OWN data.
      //
      // DEFAULT PATH - trigram, ZERO egress. Neon supports `pg_trgm` but neither
      // `zhparser` nor `pg_bigm`, and `to_tsvector` cannot tokenise Chinese: the default
      // parser treats a whole CJK sentence as a single word, so a Chinese query never
      // matches. Trigram GIN indexes give CJK substring matching plus fuzzy ranking with
      // `ILIKE '%q%'` / `similarity()` and no external call of any kind - the free-tier
      // default. The `events.tags` index is an EXPRESSION index on `(tags::text)` because
      // JSONB itself has no trigram operator class; the query side must use the identical
      // `tags::text` expression.
      //
      // OPT-IN ACCELERATOR - pgvector, guarded. `CREATE EXTENSION vector` is attempted
      // inside an exception block: on a database that cannot provide it (older self-hosted
      // Postgres, engines like PGlite that ship pg_trgm but not pgvector) the notice is
      // logged, the embeddings table is simply not created, and the trigram path above is
      // unaffected. When the extension IS available (Neon: every plan), `embeddings` stores
      // one row per (owner_type, owner_id, model). `embedding` is an UNCONSTRAINED `vector`
      // so 768-dim (nomic-embed-text) and 1536-dim (text-embedding-3-small) models can
      // coexist; the `<= 2048` CHECK on both `dims` and `vector_dims(embedding)` is the
      // column-level rejection of oversized model configs. No FK to the owner tables
      // (owner_id is polymorphic) - the nightly cleaner removes orphans instead, and the
      // users FK cascades on user deletion. Purely additive + idempotent.
      version: 53,
      name: 'search_trgm_embeddings_v53',
      sql: `-- Default search path: CJK-capable trigram indexes, no external calls.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_events_name_trgm ON events USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_events_person_name_trgm ON events USING GIN (person_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_events_tags_trgm ON events USING GIN ((tags::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_name_trgm ON fixed_contacts USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_nickname_trgm ON fixed_contacts USING GIN (nickname gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_notes_trgm ON fixed_contacts USING GIN (notes gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_relationship_trgm ON fixed_contacts USING GIN (relationship gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_interactions_summary_trgm ON interactions USING GIN (summary gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_issuer_trgm ON documents USING GIN (issuer gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_expiry_items_title_trgm ON expiry_items USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_expiry_items_vendor_trgm ON expiry_items USING GIN (vendor gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_expiry_items_notes_trgm ON expiry_items USING GIN (notes gin_trgm_ops);
-- Opt-in semantic accelerator. Guarded: without pgvector this block degrades to a NOTICE
-- and the trigram search path keeps working.
DO $migration53$
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[migration v53] pgvector unavailable (%): semantic embeddings stay disabled, trigram search unaffected', SQLERRM;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS embeddings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('event', 'contact', 'interaction', 'document', 'expiry')),
      owner_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL CHECK (dims > 0 AND dims <= 2048),
      embedding vector NOT NULL CHECK (vector_dims(embedding) <= 2048),
      content_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (owner_type, owner_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_user ON embeddings(user_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_content_hash ON embeddings(owner_type, owner_id, content_hash);
  ELSE
    RAISE NOTICE '[migration v53] vector extension not installed: embeddings table skipped';
  END IF;
END
$migration53$;`,
    },
    {
      // v54 (checkbox 112): durable background-job schema for the always-on AI
      // (Wave 14). These tables - NOT Vercel Workflow retention - are the source of
      // truth: the runner is at-least-once, claims with `FOR UPDATE SKIP LOCKED`,
      // holds a job under a renewable lease (`lease_token` + `lease_expires_at`) and
      // reclaims it when the lease expires (attempts left -> queued, exhausted ->
      // dead_letter). `agent_job_events` is the append-only audit trail, `agent_workers`
      // the worker registry, `agent_routines` the per-user schedules.
      //
      // `agent_jobs.kind` is CHECK-constrained to every job kind the plan defines:
      // `morning_brief` / `evening_review` / `weekly_review` / `hourly_triage` (Wave 15
      // routines 122-125, the queue's consumers) plus `watchdog` (Wave 14 todo 121's
      // self-watchdog / todo 130). An unknown kind is rejected by the database with a
      // message naming `agent_jobs_kind_check`, never silently queued; adding a kind
      // requires a new append-only migration. `status` is constrained to the seven
      // lifecycle states the queue service implements (113).
      //
      // `user_id` stays nullable like `notification_queue` (v3): user-scoped jobs
      // dominate but a future system-scope job must not need a schema change. The
      // partial unique index enforces per-user idempotency exactly when an
      // `idempotency_key` is present (NULL user_id rows never collide - Postgres
      // unique-NULL semantics).
      //
      // Purely additive + idempotent: only CREATE TABLE / CREATE INDEX IF NOT EXISTS,
      // no ALTER of existing tables, no backfill, no data migration, re-running is a
      // no-op. Supersedes `notification_queue` retries for AI work only - notification
      // retries keep their own table/service.
      version: 54,
      name: 'agent_jobs_v54',
      sql: `CREATE TABLE IF NOT EXISTS agent_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CONSTRAINT agent_jobs_kind_check CHECK (kind IN ('evening_review', 'hourly_triage', 'morning_brief', 'watchdog', 'weekly_review')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CONSTRAINT agent_jobs_status_check CHECK (status IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  idempotency_key TEXT,
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  result JSONB,
  cost_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_idempotency ON agent_jobs (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_jobs_claim ON agent_jobs (status, run_at);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_kind_status ON agent_jobs (kind, status);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_user_created ON agent_jobs (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT,
  detail JSONB
);
CREATE INDEX IF NOT EXISTS idx_agent_job_events_job ON agent_job_events (job_id, at);
CREATE TABLE IF NOT EXISTS agent_workers (
  id TEXT PRIMARY KEY,
  kind TEXT,
  last_seen_at TIMESTAMPTZ,
  meta JSONB
);
CREATE TABLE IF NOT EXISTS agent_routines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron_expr TEXT,
  kind TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  tier TEXT,
  budget_per_day INTEGER,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_agent_routines_due ON agent_routines (enabled, next_run_at);`,
    },
    {
      // Checkbox 101: scoped, revocable agent tokens + their audit log. A token is minted
      // once (raw value shown once), stored ONLY as a SHA-256 hex hash; the plaintext is
      // never persisted. `scopes` is a coarse grant array ('read' | 'write' | 'admin') that
      // the dispatcher maps onto each tool's fine-grained `requiredScope` from
      // shared/src/agent-tools.ts. `agent_audit_logs` records every authorisation decision
      // (allowed / denied / confirm_required) with the redacted args, the outcome and timing.
      //
      // Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no
      // ALTER of existing tables, no backfill, no data migration, re-running is a no-op.
      // Revocation is soft (`revoked_at`) so the audit trail keeps referring to the token.
      version: 55,
      name: 'agent_tokens_v55',
      sql: `CREATE TABLE IF NOT EXISTS agent_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read']::text[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token_id UUID REFERENCES agent_tokens(id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  args_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision TEXT NOT NULL CONSTRAINT agent_audit_logs_decision_check CHECK (decision IN ('allowed', 'denied', 'confirm_required')),
  result TEXT CONSTRAINT agent_audit_logs_result_check CHECK (result IN ('ok', 'error')),
  error_code TEXT,
  duration_ms INTEGER,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_user ON agent_audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_token ON agent_audit_logs (token_id, created_at DESC);`,
    },
    {
      // Checkbox 102: durable two-phase confirmation store for the agent action API.
      //
      // A `requiresConfirmation` tool (delete_event, send_digest) is NOT executed by
      // POST /api/agent/actions/:tool. Phase 1 validates + authorises the call, then records
      // ONE pending row here and returns its id; phase 2 (POST /api/agent/confirm/:id)
      // atomically claims the row and only then runs the handler:
      //
      //   UPDATE ... SET status='consumed', consumed_at=now()
      //   WHERE id=$1 AND user_id=$2 AND status='pending' AND expires_at > now()
      //
      // The single-use guarantee AND the 2-minute TTL live in that one conditional UPDATE
      // (the data layer), so a concurrent double-confirm matches at most one row and an
      // expired confirmation can never be claimed - no JS-side check can race it.
      //
      // Persisted, not module state: Hono runs per-invocation on Vercel, so an in-memory
      // store would silently lose every pending confirmation between the two HTTP calls.
      // `args` holds the phase-1-validated arguments the handler needs (audit redaction is
      // a separate concern); `expires_at` is compared in SQL, never by slicing an ISO string.
      //
      // Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no
      // ALTER of existing tables, no backfill, re-running is a no-op.
      version: 56,
      name: 'agent_confirmations_v56',
      sql: `CREATE TABLE IF NOT EXISTS agent_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id UUID REFERENCES agent_tokens(id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT agent_confirmations_status_check CHECK (status IN ('pending', 'consumed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_confirmations_user ON agent_confirmations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_confirmations_pending ON agent_confirmations (status, expires_at);`,
    },
    {
      // v57 (checkbox 132): complete the default trigram search path for the five entity
      // types the earlier trigram landings did NOT cover.
      //
      // Existing coverage before this migration (verified by reading migrate.ts + schema.pg.sql
      // immediately before appending): v33 created pg_trgm + events(name, person_name, tags) +
      // fixed_contacts(name, nickname, notes) + expiry_items(title, vendor); v34 added
      // expiry_items(title, vendor) again (the v33 block was forward-looking); v35 added
      // inventory_items(name); v38/v53 added documents(title, issuer); v53 completed the set
      // with fixed_contacts(relationship), interactions(summary), expiry_items(notes).
      // So `inventory_items.name` ALREADY had a trigram index and is deliberately NOT re-issued
      // here. Genuinely missing until v57: inventory location/notes, maintenance asset_name/notes,
      // habits name, goals title/description, inbox title/body/sender_label.
      //
      // Additive + idempotent + re-runnable: CREATE EXTENSION/INDEX IF NOT EXISTS only, no ALTER
      // of existing tables, no backfill, no data migration. `CREATE EXTENSION IF NOT EXISTS
      // pg_trgm` is re-stated so v57 is self-contained even on a database whose v33 failed on the
      // extension (the runner records a failed version as un-applied and continues walking).
      version: 57,
      name: 'search_trgm_remaining_v57',
      sql: `-- CJK substring search for the remaining entity types; no external calls.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_inventory_items_location_trgm ON inventory_items USING GIN (location gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inventory_items_notes_trgm ON inventory_items USING GIN (notes gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_asset_name_trgm ON maintenance_plans USING GIN (asset_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_notes_trgm ON maintenance_plans USING GIN (notes gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_habits_name_trgm ON habits USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_goals_title_trgm ON goals USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_goals_description_trgm ON goals USING GIN (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_title_trgm ON inbox_messages USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_body_trgm ON inbox_messages USING GIN (body gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_sender_label_trgm ON inbox_messages USING GIN (sender_label gin_trgm_ops);`,
    },
    {
      // v58 (checkbox 134): cross-entity tag system.
      //
      // `tags` is the per-user tag vocabulary; `tag_links` is the many-to-many join against
      // the eight supported entity kinds (events, contacts, documents, expiry, inventory,
      // maintenance, habits, goals). Tags are ORTHOGONAL to the pre-existing `events.tags`
      // JSONB / `events.type` columns - this table is a separate, shared vocabulary.
      //
      // `tag_links.user_id` is denormalised on purpose: the list-filter predicate runs a
      // per-row EXISTS against `(user_id, entity_type, entity_id)`, so the index below keeps
      // the filter index-usable without joining `tags` first; the link row's owner is also
      // checked directly, so one user can never observe another user's links.
      //
      // `ON DELETE CASCADE` on `tag_links.tag_id` is what makes "delete a tag" remove its
      // links (but never the linked entities): the entities live in their own tables and are
      // never touched by this migration or by tag deletion. The `entity_id` INTEGER is a
      // deliberate plain column (not a polymorphic FK) because it spans eight tables; the
      // service layer validates that `(entity_type, entity_id)` belongs to the caller BEFORE
      // every insert, so an orphan link cannot be created through the API.
      //
      // Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no ALTER
      // of existing tables, no backfill, no data migration; re-running is a no-op.
      version: 58,
      name: 'tags_tag_links_v58',
      sql: `CREATE TABLE IF NOT EXISTS tags (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_tags_user ON tags (user_id, name);
CREATE TABLE IF NOT EXISTS tag_links (
  id SERIAL PRIMARY KEY,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CONSTRAINT tag_links_entity_type_check CHECK (entity_type IN ('event', 'contact', 'document', 'expiry', 'inventory', 'maintenance', 'habit', 'goal')),
  entity_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tag_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_links_entity ON tag_links (user_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_tag_links_tag ON tag_links (tag_id, entity_type);`,
    },
    {
      // v59 (checkbox 115-116): scheduler egress ledger for the self-perpetuating chain -
      // scheduler_runs (one live run per chain via the partial unique index) + scheduler_ticks.
      // Folded from backend/src/db/pending/59-scheduler-egress.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 59,
      name: 'scheduler_egress_v59',
      sql: `-- ============================================================================
-- Pending migration 59 — scheduler_runs / scheduler_ticks (checkbox 115-116)
-- ============================================================================
-- MERGED AS VERSION 59 into backend/src/db/migrate.ts at release. This is the
-- scheduler egress ledger for the self-perpetuating chain: Vercel Workflow DevKit
-- is NOT used, Postgres is the source of truth (see
-- backend/src/services/agent/scheduler.workflow.ts). The orchestrator merges
-- pending files in numeric order; this file follows the landed max (58).
--
-- scheduler_runs  — one row per chain run (status: running -> handed_off when the
--   event threshold is reached, or running -> stalled when the watchdog sees no
--   tick for 3 x tick_interval_ms). The UNIQUE PARTIAL index over
--   (chain_id) WHERE status = 'running' is the concurrency arbiter: both
--   bootstrap and handoff use
--     INSERT ... ON CONFLICT (chain_id) WHERE status = 'running' DO NOTHING
--   + re-select, so concurrent callbacks converge on exactly ONE live run, while
--   history (parents, successors) stays queryable via parent_run_id.
-- scheduler_ticks — one ledger row per executed tick (at most 50 routines per
--   tick), with due/ran/skipped/error counters and a detail jsonb payload.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill, re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id TEXT NOT NULL DEFAULT 'default',
  parent_run_id UUID REFERENCES scheduler_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'handed_off', 'stalled', 'stopped')),
  tick_interval_ms INTEGER NOT NULL DEFAULT 600000,
  step_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tick_at TIMESTAMPTZ,
  handed_off_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Exactly one live run per chain: the arbiter for concurrent bootstrap / handoff
-- (\`ON CONFLICT (chain_id) WHERE status = 'running'\` infers this partial index).
CREATE UNIQUE INDEX IF NOT EXISTS scheduler_runs_one_live_per_chain
  ON scheduler_runs (chain_id) WHERE status = 'running';

-- Chain history / status reads.
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_chain
  ON scheduler_runs (chain_id, started_at DESC);

CREATE TABLE IF NOT EXISTS scheduler_ticks (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_count INTEGER NOT NULL DEFAULT 0,
  ran_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Last-tick lookup for GET /api/agent/scheduler/status and the heartbeat trail.
CREATE INDEX IF NOT EXISTS idx_scheduler_ticks_run_at
  ON scheduler_ticks (run_id, at DESC);`,
    },
    {
      // v60 (checkbox 118 + 121): proactive notification budget / suppression / folded content +
      // the Neon CU-hour guard alert ledger.
      // Folded from backend/src/db/pending/60-notification-budget.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 60,
      name: 'notification_budget_v60',
      sql: `-- 60-notification-budget.sql (checkbox 118 + 121 supporting DDL)
--
-- PENDING DDL: this directory is merged into backend/src/db/migrate.ts by the
-- integrator (append-only, next free version = 60 at the time of writing; the
-- integrator re-checks the tail immediately before appending, per repo convention).
-- Do NOT edit migrate.ts from a lane; this file is the lane's DDL handoff.
--
-- Idempotent + additive: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no ALTER,
-- no backfill, no data migration; re-running is a no-op.

-- (118) Per-user per-LOCAL-day proactive notification budget and suppression ledger.
-- \`day\` is the user's local calendar day (YYYY-MM-DD), resolved timezone-aware via
-- Intl.DateTimeFormat in notification-budget.service.ts, so the counters reset at the
-- user's local midnight. \`sent_count\` counts proactive sends only; user-initiated
-- replies and the critical class (e.g. medication critical reminders) are excluded
-- from BOTH counters by the service, never written here as sends.
CREATE TABLE IF NOT EXISTS agent_budget_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_agent_budget_usage_day ON agent_budget_usage (day);

-- (118) Send-claim ledger, the agent-queue analogue of \`reminder_send_claims\`:
-- a claim is won with \`INSERT ... ON CONFLICT DO NOTHING RETURNING id\`, so a
-- duplicate claim matches zero rows and the caller skips. \`window_bucket\` is
-- floor(epochMs / windowMs); a new bucket = a fresh window. Two scopes:
--   dedupe            - identical content within AGENT_NOTIFICATION_DEDUPE_WINDOW_MS
--   routine_cooldown  - per-routine cooldown (AGENT_ROUTINE_COOLDOWN_MS)
CREATE TABLE IF NOT EXISTS agent_notification_claims (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CONSTRAINT agent_notification_claims_scope_check CHECK (scope IN ('dedupe', 'routine_cooldown')),
  claim_key TEXT NOT NULL,
  window_bucket BIGINT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, claim_key, window_bucket)
);
CREATE INDEX IF NOT EXISTS idx_agent_notification_claims_user ON agent_notification_claims (user_id, claimed_at DESC);

-- (118) Folded proactive content: when the daily budget is exhausted (or the user is
-- inside quiet hours) a non-urgent routine's content is stored here instead of being
-- sent; the next Inbox digest consumes pending rows (consumed_at IS NULL) and marks
-- them consumed. Nothing in this table is ever delivered on its own.
CREATE TABLE IF NOT EXISTS agent_digest_folds (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  routine_id TEXT,
  notification_class TEXT NOT NULL DEFAULT 'routine',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_digest_folds_pending ON agent_digest_folds (user_id, created_at ASC) WHERE consumed_at IS NULL;

-- (121g) Neon Free CU-hour guard alert ledger: one row per (month, threshold) so the
-- 70% and 90% alerts fire once per month across cold-started serverless instances.
CREATE TABLE IF NOT EXISTS agent_neon_budget_alerts (
  month TEXT NOT NULL,
  threshold_percent INTEGER NOT NULL,
  cu_hours DOUBLE PRECISION,
  alerted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (month, threshold_percent)
);`,
    },
    {
      // v61 (tasks 122-123): routine delivery idempotency + audit store (agent_routine_artifacts).
      // Folded from backend/src/db/pending/61-routine-artifacts.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 61,
      name: 'routine_artifacts_v61',
      sql: `-- 61-routine-artifacts.sql (tasks 122-123)
-- Idempotency + audit store for agent routine deliveries (morning_brief,
-- evening_review, and the later weekly_review / hourly_triage lanes).
--
-- NOT yet registered in backend/src/db/migrate.ts (coordinator-owned this wave).
-- Register as: { version: 61, name: 'routine_artifacts_v61', sql: <this file> }
-- (the migrate.ts chain ended at v58 when this file was written; 59/60 belong
-- to sibling lanes). Additive and idempotent: every statement is
-- IF NOT EXISTS-guarded; nothing existing is altered, dropped or rewritten.

CREATE TABLE IF NOT EXISTS agent_routine_artifacts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Routine kind ('morning_brief', 'evening_review', ...); no FK - kinds are code.
  routine TEXT NOT NULL,
  -- The user-local calendar day the artifact covers (YYYY-MM-DD).
  local_date DATE NOT NULL,
  -- '<routine>:<YYYY-MM-DD>' - unique per user, the once-per-day delivery guard.
  idempotency_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Structured facts behind the body + narration flag (fed back into later digests).
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivered BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_at TIMESTAMPTZ,
  channel TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_routine_artifacts_user_date
  ON agent_routine_artifacts (user_id, local_date DESC);

-- Partial index for the stale-reclaim sweep (claimed but never delivered).
CREATE INDEX IF NOT EXISTS idx_agent_routine_artifacts_pending
  ON agent_routine_artifacts (created_at) WHERE delivered = FALSE;`,
    },
    {
      // v62 (routines 122-125): hourly-triage / weekly-review dedupe memory (agent_triage_state).
      // Folded from backend/src/db/pending/62-triage-state.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 62,
      name: 'triage_state_v62',
      sql: `-- ============================================================================
-- Pending migration 62 — agent_triage_state (Wave 15 routines 122-125)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts: that file is a shared file the
-- routine lane must not edit. The orchestrator merges pending files in numeric
-- order at release (62 follows the currently landed max, 58 at the time of
-- writing). Until then the routines in
--   backend/src/services/agent/routines/hourly-triage.ts
--   backend/src/services/agent/routines/weekly-review.ts
-- will fail their reads/writes with "relation agent_triage_state does not exist".
--
-- Why one table and not per-routine state: the hourly triage OBSERVES and the
-- weekly review DIGESTS, and both must agree on what has already been shown to
-- the user. One durable row per (user, item fingerprint) is the dedupe memory
-- that survives serverless cold starts:
--
--   fingerprint          stable key, e.g. 'event:42'  (UNIQUE per user)
--   last_seen_at         freshness: when the item last appeared in a scan
--   last_surfaced_at     suppression anchor: hourly triage skips a fingerprint
--                        surfaced within its dedupe window unless importance
--                        escalated (see TRIAGE_DEDUPE_WINDOW_HOURS / _DELTA)
--   surfaced_count       how many times it was actually shown
--   last_surface_kind    'hourly_triage' | 'weekly_review'
--   digest_week          ISO week ('2026-W40') the item was last included in a
--                        weekly digest; NULL = never digested. Same-week re-runs
--                        reproduce the same digest; earlier-week items repeat only
--                        while importance stays at/above the urgent bar.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill, re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_triage_state (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  title TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 0,
  band TEXT NOT NULL DEFAULT 'fyi',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_surfaced_at TIMESTAMPTZ,
  surfaced_count INTEGER NOT NULL DEFAULT 0,
  last_surface_kind TEXT,
  digest_week TEXT,
  UNIQUE (user_id, fingerprint)
);

-- Scan/lookup support for the two routines (bounded, index-friendly reads).
CREATE INDEX IF NOT EXISTS idx_agent_triage_state_recent
  ON agent_triage_state (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_triage_state_surfaced
  ON agent_triage_state (user_id, last_surfaced_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_triage_state_week
  ON agent_triage_state (user_id, digest_week);`,
    },
    {
      // v63 (tasks 126/127): agent decision cards + durable feedback policy memory.
      // Folded from backend/src/db/pending/63-agent-feedback.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 63,
      name: 'agent_feedback_v63',
      sql: `-- ============================================================================
-- Pending migration 63 — agent decision cards + durable feedback memory
-- (Wave 16 tasks 126 + 127)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts: that file is owned by the
-- integrator lane. The orchestrator merges pending files in numeric order at
-- release (63 follows the currently landed max, 62 at the time of writing).
-- Until then:
--   backend/src/services/agent/decision-card.service.ts
--   backend/src/services/agent/feedback.service.ts
--   backend/src/routes/decisions.ts
-- will fail their reads/writes with "relation agent_decision_cards/agent_feedback
-- does not exist".
--
-- WHY TWO TABLES:
--
--   agent_decision_cards  The human-in-the-loop proposal (task 126). NOTHING
--                         mutates user data until the card is approved. The
--                         exactly-once guarantee is a single atomic claim:
--                         \`UPDATE ... SET status='approved' WHERE status='pending'\`
--                         - the loser of a race updates zero rows and the API
--                         returns 409 already_decided. The card stores the full
--                         typed payload so the resolver registry (subject kind ->
--                         apply function) can re-validate it at approval time.
--                         \`is_question\` marks question cards, whose daily cap is
--                         enforced separately from the notification budget.
--
--   agent_feedback        The durable memory (task 127): every approve/edit/
--                         reject (with its optional free-text "Why?") and every
--                         correction lands here, plus a derived row in
--                         user_patterns (kind='decision_feedback') so the miner's
--                         confidence rises from REAL feedback. The most recent
--                         row for a subject is the effective policy; a polarity
--                         flip (approve then reject) is logged as a conflict
--                         rather than oscillating.
--
-- The feedback memory NEVER overrides a hard setting (quiet hours, notification
-- budget): those live in configuration and the feedback service refuses to turn
-- feedback rows into config overrides (see HARD_SETTING_SUBJECTS in
-- feedback.service.ts). Hard settings are excluded from the policy digest too.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill, re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_decision_cards (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Typed subject kind; only kinds present in DECISION_SUBJECT_KINDS have a
  -- resolver, so an unknown kind can never be applied (injection guard).
  subject_kind TEXT NOT NULL,
  -- Stable human/machine subject, e.g. 'contact:12+34'. It is the key the
  -- feedback memory and the policy digest use for suppression checks.
  subject_ref TEXT,
  -- 'propose' at creation time; kept as a column so future action kinds
  -- (e.g. 'question') do not need an ALTER.
  action TEXT NOT NULL DEFAULT 'propose',
  summary TEXT NOT NULL DEFAULT '',
  -- Full proposed change; validated against the resolver's allowlist at
  -- approval time - never executed blindly.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Caller-provided idempotency key: re-proposing the same change returns the
  -- EXISTING card instead of creating (and re-notifying) a second one.
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'target_missing', 'expired')),
  -- Question cards (the agent asking the user something) have their own daily
  -- cap, enforced separately from the notification budget.
  is_question BOOLEAN NOT NULL DEFAULT FALSE,
  -- The optional free-text "Why?" note captured at decide time.
  rationale TEXT,
  -- For an edit decision: the user-adjusted payload merged over \`payload\`.
  edit_payload JSONB,
  -- Outcome of the resolver run: { status, detail, applied_at }.
  resolution JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);

-- Pending-card lists (API + bot) and the question-card day counter.
CREATE INDEX IF NOT EXISTS idx_agent_decision_cards_user_status
  ON agent_decision_cards (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_decision_cards_user_question
  ON agent_decision_cards (user_id, is_question, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'decision' (approve/edit/reject of a card) | 'correction' (free correction).
  kind TEXT NOT NULL,
  -- Feedback subject; matches agent_decision_cards.subject_ref (or the subject
  -- kind when no ref was supplied). This is the suppression key.
  subject TEXT NOT NULL,
  -- 'approve' | 'edit' | 'reject' | 'correct'.
  action TEXT NOT NULL,
  -- Optional free-text "Why?" note, persisted verbatim (bounded upstream).
  rationale TEXT,
  -- Card that produced this feedback, when applicable; audit only.
  decision_card_id BIGINT REFERENCES agent_decision_cards(id) ON DELETE SET NULL,
  -- Machine details (edited payload, target_missing flag, conflict_with, ...).
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest-per-subject lookup (policy check, digest, conflict resolution).
CREATE INDEX IF NOT EXISTS idx_agent_feedback_user_subject
  ON agent_feedback (user_id, subject, created_at DESC);
-- Recency window scan for the bounded policy digest.
CREATE INDEX IF NOT EXISTS idx_agent_feedback_user_created
  ON agent_feedback (user_id, created_at DESC);`,
    },
    {
      // v64 (tasks 135/142): dedupe candidates + destructive-change audit trail with the
      // TTL'd exactly-once undo (audit_events / audit_undo_snapshots).
      // Folded from backend/src/db/pending/64-dedupe-audit.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 64,
      name: 'dedupe_audit_v64',
      sql: `-- ============================================================================
-- Pending migration 64 — dedupe candidates + audit trail with TTL'd undo
-- (Wave 17 tasks 135 + 142)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts: that file is owned by the
-- integrator lane. The orchestrator merges pending files in numeric order at
-- release (64 follows the currently landed max, 63 at the time of writing).
-- Until then:
--   backend/src/services/agent/audit.service.ts
--   backend/src/services/agent/dedupe.service.ts
--   backend/src/routes/audit.ts
--   backend/src/routes/dedupe.ts
-- will fail their reads/writes with "relation audit_events/audit_undo_snapshots
-- does not exist".
--
-- WHY TWO TABLES:
--
--   audit_events         One row per destructive change (delete / merge /
--                        bulk_edit / archive) with the actor, the REDACTED
--                        before/after payloads and the undo deadline. Written
--                        only through audit.service.recordAudit(); payloads are
--                        redacted by job-hardening's redactForAudit before they
--                        reach this table (tokens/secrets never persist here).
--
--   audit_undo_snapshots The exactly-once undo. \`snapshot\` holds the restorable
--                        row groups ({version, truncated, groups:[{table, mode,
--                        rows}]}); \`undo_token\` is the TTL'd token exposed to
--                        the user/bot; \`consumed_at\` is the atomic claim
--                        (\`UPDATE ... SET consumed_at=now() WHERE consumed_at
--                        IS NULL AND expires_at > now()\`) so a second undo
--                        updates zero rows and the API returns 409. The undo
--                        deadline is \`expires_at\` (AUDIT_UNDO_TTL_HOURS,
--                        default 72h); once it passes the undo is refused.
--
-- Safety model: the task-135 dedupe scanner only PROPOSES merges (decision
-- card, task 126); nothing in these tables triggers a delete. Undo only writes
-- to an allowlisted set of tables (events, fixed_contacts, todo_completions,
-- interactions), filtered against information_schema columns at restore time.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill, re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'delete' | 'merge' | 'bulk_edit' | 'archive' (AUDIT_ACTIONS).
  action TEXT NOT NULL,
  -- Domain of the affected rows, e.g. 'event' | 'contact' | 'todo'.
  entity_kind TEXT NOT NULL,
  -- Stable ids of the affected entities (array of numbers/strings).
  entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT NOT NULL DEFAULT '',
  -- Human user the change is attributed to (agent/bot runs act on their behalf).
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 'api' | 'bot' | 'agent' | 'decision_card' | ...
  actor_via TEXT NOT NULL DEFAULT 'api',
  -- REDACTED payload snapshots; never raw secrets (see redactForAudit).
  before_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Deadline copied from the snapshot row so the list view is a single scan.
  undo_expires_at TIMESTAMPTZ,
  undone_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_created
  ON audit_events (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_user_action
  ON audit_events (user_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_user_expiry
  ON audit_events (user_id, undo_expires_at);

CREATE TABLE IF NOT EXISTS audit_undo_snapshots (
  id BIGSERIAL PRIMARY KEY,
  audit_event_id BIGINT NOT NULL REFERENCES audit_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- {version, truncated, groups:[{table, mode:'reinsert'|'revert', rows:[...]}]}
  snapshot JSONB NOT NULL DEFAULT '{"version":1,"truncated":false,"groups":[]}'::jsonb,
  -- Opaque TTL'd token (32 random bytes, base64url). Unique per snapshot.
  undo_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  -- Atomic exactly-once claim; NULL = undo still available.
  consumed_at TIMESTAMPTZ,
  -- Outcome detail of a successful restore: {restored, groups:[...]}.
  restored JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_event_id),
  UNIQUE (undo_token)
);

CREATE INDEX IF NOT EXISTS idx_audit_undo_snapshots_user_expiry
  ON audit_undo_snapshots (user_id, expires_at);`,
    },
    {
      // v65 (task 137): data-health one-click repair ledger (data_health_repairs).
      // Folded from backend/src/db/pending/65-data-health.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 65,
      name: 'data_health_v65',
      sql: `-- Task 137: audit ledger for data-health one-click repairs.
--
-- Every successful repair writes one row here (best-effort) in addition to the shipped
-- \`audit_logs\` entry written via services/audit.service.ts. \`repaired_count\` is the number
-- of rows the repair touched; \`confirmed\` records whether a destructive repair was
-- explicitly confirmed by the caller. Repairs are idempotent, so re-running one over an
-- already-clean dataset appends a row with repaired_count = 0.
CREATE TABLE IF NOT EXISTS data_health_repairs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  repaired_count INTEGER NOT NULL DEFAULT 0,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_health_repairs_user ON data_health_repairs (user_id, created_at DESC);`,
    },
    {
      // v67 (tasks 140-141): recurring routine templates + steps + instantiation claims.
      // Folded from backend/src/db/pending/67-templates.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 67,
      name: 'routine_templates_v67',
      sql: `-- 67-templates.sql (tasks 140-141)
-- Recurring routine templates: a named set of steps (event + reminders + checklist
-- todos + optional habit / maintenance linkage) that can be instantiated as a whole.
--
-- Storage:
--   routine_templates        - the named routine (per user)
--   routine_template_steps   - ordered steps; \`payload\` holds the per-kind options
--   routine_template_instances - idempotency + audit: one row per (user, template, slot).
--     UNIQUE (user_id, template_id, slot_key) is what makes a double-click a no-op:
--     instantiate inserts this row first with ON CONFLICT DO NOTHING and only creates
--     the items when the claim succeeds. The whole unit runs in one transaction.
--
-- NOT yet registered in backend/src/db/migrate.ts (integrator-owned this wave).
-- Register as: { version: 67, name: 'routine_templates_v67', sql: <this file> }
-- (sibling pending files 59-63 belong to other lanes). Additive and idempotent: every
-- statement is IF NOT EXISTS-guarded; nothing existing is altered, dropped or rewritten.

CREATE TABLE IF NOT EXISTS routine_templates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  -- Built-in presets (每周大扫除 / 旅行准备 / 月度报表) are seeded with TRUE.
  is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_routine_templates_user
  ON routine_templates (user_id, name);

CREATE TABLE IF NOT EXISTS routine_template_steps (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES routine_templates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  -- event | todo | habit | maintenance (todo steps are events under the hood:
  -- this app's completable todo IS an event in its reminder window).
  kind TEXT NOT NULL CONSTRAINT routine_template_steps_kind_check
    CHECK (kind IN ('event', 'todo', 'habit', 'maintenance')),
  title TEXT NOT NULL,
  -- Per-kind options: dateOffsetDays, eventType, reminder, recurring, habitId/habit,
  -- maintenancePlanId/maintenance, profileId.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routine_template_steps_template
  ON routine_template_steps (template_id, position, id);

CREATE TABLE IF NOT EXISTS routine_template_instances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES routine_templates(id) ON DELETE CASCADE,
  -- Slot identity: caller-supplied slot, else the anchor date (user-local today).
  slot_key TEXT NOT NULL,
  anchor_date DATE NOT NULL,
  -- Per-item creation report (stepId -> created/linked entity), JSONB array.
  report JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, template_id, slot_key)
);

CREATE INDEX IF NOT EXISTS idx_routine_template_instances_user_template
  ON routine_template_instances (user_id, template_id, created_at DESC);`,
    },
    {
      // v69 (tasks 144/147): inbound feed ingest sources / proposals / seen. The export lane needs no table.
      // Folded from backend/src/db/pending/69-feeds-export.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 69,
      name: 'feeds_export_v69',
      sql: `-- ============================================================================
-- Pending migration 69 — inbound feed ingest + print/export support
-- (Tasks 144 + 147)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts (integrator-owned). The
-- orchestrator merges pending files in numeric order at release; the next free
-- version at the time of writing is 64, but this lane was assigned the reserved
-- slot 69. Register as:
--   { version: 69, name: 'feeds_export_v69', sql: <this file> }
--
-- Until then:
--   backend/src/services/agent/feed-ingest.service.ts
--   backend/src/routes/feeds.ts
-- will fail their reads/writes with "relation feed_sources ... does not exist".
-- The export lane (147) needs NO table — it renders from existing events /
-- fixed_contacts / event_trigger_logs.
--
-- WHY THREE TABLES (and why NOT the existing \`ics_feeds\`):
--
--   feed_sources        Task 144 inbound SOURCE registry. NOTE: the shipped
--                       \`ics_feeds\` table (migration v48, ics-feed.service.ts) is
--                       the OPPOSITE direction — it stores OUTBOUND public
--                       subscription feeds keyed by token_hash + "filter".
--                       Reusing it would require ALTERing a NOT-NULL token/filter
--                       shape that has no meaning for an inbound url+poll source,
--                       so a separate additive table is used instead. One row is
--                       either kind='ics' (url + poll_interval_minutes) or
--                       kind='mail' (mail_address). \`trusted\` is the per-source
--                       switch: trusted sources may be applied immediately;
--                       untrusted sources only ever produce proposals.
--
--   feed_ingest_proposals  Human-in-the-loop queue. Nothing creates an event or
--                       contact until the row flips to 'accepted'; the accept
--                       path is a single atomic claim
--                       (\`UPDATE ... WHERE status='pending'\`, loser updates 0
--                       rows -> 409). kind ('event_new' | 'event_changed' |
--                       'contact_new') tells the resolver what to do. The unique
--                       (user_id, source_kind, dedupe_key) is the idempotency
--                       guard: re-syncing the same feed is a no-op.
--
--   feed_ingest_seen    The dedupe memory that survives serverless cold starts.
--                       For ICS the contract is UID + DTSTART: a brand-new
--                       (uid, dtstart_key) proposes 'event_new'; a known uid with
--                       a DIFFERENT dtstart_key proposes 'event_changed'; every
--                       other combination is a duplicate and is skipped. For
--                       mail the key is Message-ID + candidate index. The unique
--                       (source_id, dedupe_key) makes re-ingest idempotent.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill, re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS feed_sources (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'ics' = polled external calendar URL; 'mail' = inbound RFC822 mailbox.
  kind TEXT NOT NULL CHECK (kind IN ('ics', 'mail')),
  name TEXT NOT NULL DEFAULT '',
  -- ICS only: the external feed URL (operator must add the host to
  -- EGRESS_ALLOWED_HOSTS so services/agent/egress-guard.service.ts lets the fetch out).
  url TEXT,
  -- ICS only: how often the scheduler should re-poll (minutes).
  poll_interval_minutes INTEGER NOT NULL DEFAULT 360,
  -- Mail only: the address this mailbox expects mail for (informational).
  mail_address TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- trusted = apply directly (still recorded as an accepted proposal);
  -- untrusted (default) = propose only, never silently write user data.
  trusted BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at TIMESTAMPTZ,
  last_status TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_sources_user
  ON feed_sources (user_id, enabled, kind);

CREATE TABLE IF NOT EXISTS feed_ingest_proposals (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id BIGINT REFERENCES feed_sources(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event_new', 'event_changed', 'contact_new')),
  -- UID|<DTSTART> for ICS, Message-ID#<index> for mail.
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  -- Typed payload re-validated at accept time (never executed blindly).
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE (user_id, source_kind, dedupe_key)
);

-- Pending queue listing (newest first) + status filters.
CREATE INDEX IF NOT EXISTS idx_feed_ingest_proposals_user_status
  ON feed_ingest_proposals (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_ingest_seen (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id BIGINT REFERENCES feed_sources(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  -- ICS: the VEVENT UID (stable identity across re-syncs).
  uid TEXT,
  -- ICS: the DTSTART token (all-day 'YYYYMMDD' or 'YYYYMMDDTHHMMSSZ').
  dtstart_key TEXT,
  title TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, dedupe_key)
);

-- Change detection: find every DTSTART already known for a UID.
CREATE INDEX IF NOT EXISTS idx_feed_ingest_seen_source_uid
  ON feed_ingest_seen (source_id, uid);`,
    },
    {
      // v70 (tasks 146/148/149): OCR results + family share tokens + remote backup config / records.
      // Folded from backend/src/db/pending/70-ocr-share-backup.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 70,
      name: 'ocr_share_remote_backup_v70',
      sql: `-- ============================================================================
-- Pending migration 70 - OCR results + family share tokens + remote backups
-- (Wave tasks 146 + 148 + 149)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts (integrator-owned). The
-- orchestrator merges pending files in numeric order at release (70 follows the
-- currently-landed max, 63 at the time of writing). Register as:
--   { version: 70, name: 'ocr_share_remote_backup_v70', sql: <this file> }
-- Until then the new services/routes fail their reads/writes with
-- "relation ocr_results / share_tokens / remote_backup_configs /
-- remote_backup_records does not exist".
--
-- WHY EACH TABLE:
--
--   ocr_results            Optional OCR (task 146). One row per extraction
--                          attempt, linked to the owning document and/or the
--                          source attachment. The raw text is stored bounded
--                          (excerpt) plus a structured-fields JSON object
--                          (issuer/date/total/currency). OCR is OFF by default:
--                          rows only appear once an engine is configured.
--
--   share_tokens           Read-only family sharing (task 148). The raw token
--                          is shown once and NEVER stored - only its SHA-256
--                          hash (\`token_hash\`) is persisted. Scope is exactly
--                          one of profile | tag; an optional passcode is stored
--                          as its SHA-256 hash. \`expires_at\` / \`revoked_at\`
--                          gate access; \`access_count\` / \`last_accessed_at\`
--                          are usage counters (no IP, no user agent).
--
--   remote_backup_configs  WebDAV / S3-compatible target (task 149). One row
--                          per user. Credentials are encrypted at rest with the
--                          shared crypto util (MASTER_KEY); the plaintext is
--                          never stored and never logged.
--
--   remote_backup_records  Append-only attempt log for every backup / restore /
--                          list / prune action (task 149), so the UI can show
--                          history without touching the remote target.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill; re-running is a no-op.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 146: optional OCR results
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ocr_results (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Owning document (preferred) - null for a standalone extraction.
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  -- Source attachment when the bytes came from the vault.
  attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  -- Engine that produced the row (e.g. 'tesseract'); 'none' when disabled.
  engine TEXT NOT NULL,
  -- 'extracted' | 'disabled' | 'failed'
  status TEXT NOT NULL,
  content_type TEXT,
  byte_size INTEGER,
  -- Bounded text excerpt; never the full document body.
  text_excerpt TEXT,
  -- Structured fields: { issuer, date, total, currency } (any may be null).
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocr_results_user_document
  ON ocr_results (user_id, document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ocr_results_user_created
  ON ocr_results (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 148: read-only family share tokens (profile / tag scoped)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the high-entropy raw token - the ONLY persisted form.
  token_hash TEXT NOT NULL UNIQUE,
  -- 'profile' | 'tag'
  scope_type TEXT NOT NULL CHECK (scope_type IN ('profile', 'tag')),
  -- Present when scope_type = 'profile' (ownership checked in the service).
  scope_profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  -- Present when scope_type = 'tag' (a value in events.tags / contacts tags).
  scope_tag TEXT,
  label TEXT,
  -- SHA-256 hex of the optional passcode; null = no passcode required.
  passcode_hash TEXT,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_user_created
  ON share_tokens (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 149: remote backup target config + attempt log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS remote_backup_configs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- 'webdav' | 's3'
  target_type TEXT NOT NULL CHECK (target_type IN ('webdav', 's3')),
  -- WebDAV base URL / S3-compatible endpoint. Its host MUST be on the egress
  -- allowlist before any call is attempted (see remote-backup.service.ts).
  endpoint TEXT NOT NULL,
  path_prefix TEXT NOT NULL DEFAULT '',
  -- S3 only.
  bucket TEXT,
  region TEXT,
  access_key_id TEXT,
  -- WebDAV only.
  username TEXT,
  -- Encrypted (shared crypto util) WebDAV password / S3 secret access key.
  -- Never serialized into a response, never logged.
  secret_encrypted TEXT,
  retention_count INTEGER NOT NULL DEFAULT 5,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS remote_backup_records (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'backup' | 'restore' | 'list' | 'prune'
  kind TEXT NOT NULL,
  -- 'success' | 'dry_run' | 'failure'
  status TEXT NOT NULL,
  target_type TEXT,
  object_key TEXT,
  byte_size BIGINT,
  retention_deleted INTEGER NOT NULL DEFAULT 0,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  error_code TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_remote_backup_records_user_created
  ON remote_backup_records (user_id, created_at DESC);`,
    },
    {
      // v71 (tasks 151/152): weather settings / cross-instance cache + tracked parcels.
      // Folded from backend/src/db/pending/71-weather-parcels.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 71,
      name: 'weather_parcels_v71',
      sql: `-- 71-weather-parcels.sql (tasks 151 + 152 supporting DDL)
--
-- PENDING DDL: this directory is merged into backend/src/db/migrate.ts by the
-- integrator (append-only, next free version = 71 at the time of writing; the
-- integrator re-checks the tail immediately before appending, per repo convention).
-- Do NOT edit migrate.ts from a lane; this file is the lane's DDL handoff.
--
-- Idempotent + additive: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no ALTER,
-- no backfill, no data migration; re-running is a no-op.

-- (151) The user's stored weather location (opt-in). One row per user; an absent row
-- means "unconfigured" and the service degrades to 天气不可用. \`latitude\`/\`longitude\`
-- are WGS-84 decimal degrees keyed by the Open-Meteo forecast endpoints.
CREATE TABLE IF NOT EXISTS user_weather_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  location_label TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (151) Shared, cross-instance upstream cache for Open-Meteo (free, no API key).
-- \`fetched_at\` is the payload freshness clock; \`attempted_at\` is the 5-minute
-- Postgres/egress floor: an instance never re-calls upstream while a previous
-- attempt (success OR failure) is younger than WEATHER_MIN_REFRESH_MS, and a
-- failed attempt serves the previous payload as \`stale\` instead of failing.
CREATE TABLE IF NOT EXISTS weather_cache (
  cache_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (152) Tracked parcels (carrier, tracking number, label, status, last event, ETA).
-- Manual status updates overwrite \`status\` + \`last_event\`; adapter polling (the
-- injected CarrierAdapter seam) writes the same fields. The tracking number is a
-- user secret: it is only ever logged through maskTrackingNumber().
CREATE TABLE IF NOT EXISTS parcels (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  carrier TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registered'
    CONSTRAINT parcels_status_check CHECK (status IN ('registered', 'in_transit', 'out_for_delivery', 'delivered', 'exception')),
  last_event TEXT,
  last_event_at TIMESTAMPTZ,
  eta DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, carrier, tracking_number)
);
CREATE INDEX IF NOT EXISTS idx_parcels_user_status ON parcels (user_id, status);`,
    },
    {
      // v72 (tasks 153/154/155): attendance/timesheet + child/elder care + pet care.
      // Folded from backend/src/db/pending/72-timesheet-care-pets.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 72,
      name: 'timesheet_care_pets_v72',
      sql: `-- 72-timesheet-care-pets.sql (tasks 153 + 154 + 155 supporting DDL)
--
-- PENDING DDL: this directory is merged into backend/src/db/migrate.ts by the
-- integrator (append-only, next free version after 71 at the time of writing; the
-- integrator re-checks the tail immediately before appending, per repo convention).
-- Do NOT edit migrate.ts from a lane; this file is the lane's DDL handoff.
--
-- Idempotent + additive: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no ALTER,
-- no backfill, no data migration; re-running is a no-op.

-- ---------------------------------------------------------------------------
-- (153) Attendance / timesheet
-- ---------------------------------------------------------------------------

-- One row per work session. \`clock_out IS NULL\` marks the single open session.
-- The partial unique index below is the hard guarantee against duplicate open
-- sessions (a second clock-in hits 23505 and the route answers 409); the service
-- also checks for a friendly error before inserting.
CREATE TABLE IF NOT EXISTS timesheet_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in TIMESTAMPTZ NOT NULL DEFAULT now(),
  clock_out TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT timesheet_sessions_range_check CHECK (clock_out IS NULL OR clock_out > clock_in)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_timesheet_open_session
  ON timesheet_sessions (user_id) WHERE clock_out IS NULL;
CREATE INDEX IF NOT EXISTS idx_timesheet_sessions_user_clock_in
  ON timesheet_sessions (user_id, clock_in);

-- Absence / leave records. \`kind\` is a coarse bucket; the note carries detail.
CREATE TABLE IF NOT EXISTS timesheet_leaves (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'leave'
    CONSTRAINT timesheet_leaves_kind_check CHECK (kind IN ('absence', 'leave', 'sick', 'holiday', 'other')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT timesheet_leaves_range_check CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_timesheet_leaves_user_start
  ON timesheet_leaves (user_id, start_date);

-- ---------------------------------------------------------------------------
-- (154) Child / elder care
-- ---------------------------------------------------------------------------

-- A care recipient (child, elder, ...). One user may keep several profiles.
CREATE TABLE IF NOT EXISTS care_profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT '',
  date_of_birth DATE,
  allergies TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_care_profiles_user ON care_profiles (user_id);

-- Care events: feeding / dose / vitals / mood / incident. Deliberately named
-- \`care_logs\` so it cannot collide with the existing medications/doses domain.
-- \`value\` + \`unit\` carry measurement history (e.g. temperature 36.8 C, weight
-- 12.5 kg); \`label\` names the item (formula, drug, metric).
CREATE TABLE IF NOT EXISTS care_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id BIGINT NOT NULL REFERENCES care_profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CONSTRAINT care_logs_kind_check CHECK (kind IN ('feeding', 'dose', 'vitals', 'mood', 'incident')),
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  label TEXT NOT NULL DEFAULT '',
  value NUMERIC,
  unit TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_care_logs_profile_logged_at
  ON care_logs (profile_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_logs_user_kind_logged_at
  ON care_logs (user_id, kind, logged_at DESC);

-- ---------------------------------------------------------------------------
-- (155) Pet care
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pets (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  species TEXT NOT NULL DEFAULT '',
  breed TEXT NOT NULL DEFAULT '',
  birth_date DATE,
  weight_kg NUMERIC(6, 2),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pets_user ON pets (user_id);

-- Pet history: weight / feeding / vet. \`weight_kg\` is used by kind='weight'
-- (and optionally by vet visits); \`detail\` carries feeding / vet notes.
CREATE TABLE IF NOT EXISTS pet_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id BIGINT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CONSTRAINT pet_logs_kind_check CHECK (kind IN ('weight', 'feeding', 'vet')),
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  weight_kg NUMERIC(6, 2),
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pet_logs_pet_kind_logged_at
  ON pet_logs (pet_id, kind, logged_at DESC);

-- Vaccination / deworming schedule with per-row lead time. A one-shot schedule
-- is retired by setting \`completed_at\`; a recurring schedule (interval_days IS
-- NOT NULL) rolls \`due_date\` forward on completion so the reminder scan keeps
-- working off a single due date (see pet.service.ts completePetSchedule).
CREATE TABLE IF NOT EXISTS pet_schedules (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id BIGINT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CONSTRAINT pet_schedules_kind_check CHECK (kind IN ('vaccination', 'deworming')),
  name TEXT NOT NULL,
  due_date DATE NOT NULL,
  interval_days INTEGER,
  reminder_days_before INTEGER NOT NULL DEFAULT 14,
  completed_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  completion_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pet_schedules_interval_check CHECK (interval_days IS NULL OR interval_days > 0),
  CONSTRAINT pet_schedules_reminder_check CHECK (reminder_days_before >= 0)
);
CREATE INDEX IF NOT EXISTS idx_pet_schedules_user_due
  ON pet_schedules (user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_pet_schedules_pet_due
  ON pet_schedules (pet_id, due_date);`,
    },
    {
      // v73 (tasks 156/157/158): vehicle fuel/maintenance ledger + watch/read list + household collaborative lists.
      // Folded from backend/src/db/pending/73-vehicle-watchlist-household.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 73,
      name: 'vehicle_watchlist_household_v73',
      sql: `-- Task 156/157/158: vehicle fuel & maintenance ledger, watch/read list, household lists.
--
-- Idempotent + additive. Folds into backend/src/db/migrate.ts by the integrator in
-- numeric order after the landed max. No data migration: brand-new tables plus two
-- additive share_tokens changes (new 'household_list' scope value + scope_list_id)
-- guarded so re-runs are no-ops.

-- ---------------------------------------------------------------------------
-- 156: vehicles + fuel / maintenance ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vehicles (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  year INTEGER CHECK (year IS NULL OR (year >= 1886 AND year <= 2100)),
  plate TEXT NOT NULL DEFAULT '',
  odometer INTEGER NOT NULL DEFAULT 0 CHECK (odometer >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS vehicle_fuel_records (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  recorded_on DATE NOT NULL,
  energy_type TEXT NOT NULL DEFAULT 'fuel' CHECK (energy_type IN ('fuel', 'electric')),
  quantity NUMERIC(10, 2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10, 3) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  total_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  odometer INTEGER NOT NULL CHECK (odometer >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_fuel_vehicle ON vehicle_fuel_records (vehicle_id, odometer DESC);

CREATE TABLE IF NOT EXISTS vehicle_maintenance_records (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  serviced_on DATE NOT NULL,
  odometer INTEGER CHECK (odometer IS NULL OR odometer >= 0),
  cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  next_due_date DATE,
  next_due_odometer INTEGER CHECK (next_due_odometer IS NULL OR next_due_odometer >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_vehicle
  ON vehicle_maintenance_records (vehicle_id, serviced_on DESC);

-- ---------------------------------------------------------------------------
-- 157: watch / read list. Rows with a future release_date + status
-- wanted/in_progress feed the shared minute-cron reminder iterator
-- (jobs/tasks.ts WATCHLIST_SOURCE); no second scheduler.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS watchlist_items (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('film', 'series', 'book', 'game', 'other')),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'wanted' CHECK (status IN ('wanted', 'in_progress', 'done', 'dropped')),
  release_date DATE,
  source TEXT,
  link TEXT,
  rating INTEGER CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
  note TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_watchlist_user_status ON watchlist_items (user_id, status);
CREATE INDEX IF NOT EXISTS idx_watchlist_user_release ON watchlist_items (user_id, release_date);

-- ---------------------------------------------------------------------------
-- 158: household collaborative list. Deliberately separate from the existing
-- inventory_items stock domain (different table names, different lifecycle).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS household_lists (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_household_lists_user ON household_lists (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS household_list_items (
  id BIGSERIAL PRIMARY KEY,
  list_id BIGINT NOT NULL REFERENCES household_lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  checked BOOLEAN NOT NULL DEFAULT FALSE,
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_household_list_items_list
  ON household_list_items (list_id, checked, created_at);

-- Per-list share links reuse share_tokens: widen the scope CHECK to accept
-- 'household_list' and add the list reference column. Dropping the old CHECK is
-- required (an ADD would otherwise be rejected); the loop handles any constraint
-- name, and re-runs drop + re-add the same widened constraint.
ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS scope_list_id BIGINT;

DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'share_tokens'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%scope_type%'
  LOOP
    EXECUTE format('ALTER TABLE share_tokens DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
  ALTER TABLE share_tokens
    ADD CONSTRAINT share_tokens_scope_type_check
    CHECK (scope_type IN ('profile', 'tag', 'household_list'));
END $$;`,
    },
    {
      // v74 (tasks 159/160): two-way calendar sync accounts + single-owner collaboration invites.
      // Folded from backend/src/db/pending/74-calendar-sync-collab.sql; SQL embedded verbatim.
      // Idempotent: every statement is IF NOT EXISTS-guarded; no existing migration was touched.
      version: 74,
      name: 'calendar_sync_collaboration_v74',
      sql: `-- ============================================================================
-- Pending migration 74 - two-way calendar sync accounts + single-owner
-- family collaboration invites (Wave tasks 159 + 160)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts (integrator-owned). The
-- orchestrator merges pending files in numeric order at release (74 follows the
-- currently-landed max, 73 at the time of writing). Register as:
--   { version: 74, name: 'calendar_sync_collaboration_v74', sql: <this file> }
-- Until then the new services/routes fail their reads/writes with
-- "relation calendar_sync_accounts / calendar_sync_events /
--  collaboration_invites / collaboration_activity does not exist".
--
-- WHY EACH TABLE:
--
--   calendar_sync_accounts  A per-user external calendar target (task 159).
--                           \`kind\` is 'caldav' | 'exchange'; the Exchange path
--                           is an adapter seam that may report \`unsupported\`
--                           instead of faking success. Credentials are encrypted
--                           at rest with the shared crypto util (MASTER_KEY);
--                           the ciphertext is never returned and never logged.
--                           \`direction\` gates pull / push / both and \`enabled\`
--                           lets the owner pause an account without deleting it.
--
--   calendar_sync_events    The idempotency + conflict ledger. UNIQUE
--                           (account_id, calendar_id, external_uid) makes a
--                           re-pull a no-op (dedupe on external UID + calendar
--                           id). \`external_version\` (ETag / changeKey) and
--                           \`local_version\` (content hash) are the per-side
--                           versions recorded at the last sync; \`losing_version\`
--                           records the version discarded by the conflict policy
--                           (last-write-wins by default).
--
--   collaboration_invites   SINGLE-OWNER, invite-only guests (task 160). There
--                           is exactly one owner (owner_user_id) and NO tenant
--                           table, org table or membership table: a guest is an
--                           email/link holding a token, not an account. The raw
--                           token is shown once and never stored - only its
--                           SHA-256 hash (\`token_hash\`) is persisted. \`role\` is
--                           viewer | commenter | editor and \`scope_*\` bounds the
--                           surface (profile and/or tag and/or entity types).
--
--   collaboration_activity  Append-only feed of collaborator changes (task 160)
--                           so the owner sees what a guest did, scoped to the
--                           invite. Never stores credentials or raw tokens.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill; re-running is a no-op.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 159: external calendar sync accounts (CalDAV / Exchange seam)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_sync_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'caldav' | 'exchange'
  kind TEXT NOT NULL CHECK (kind IN ('caldav', 'exchange')),
  -- External calendar collection / endpoint root. Its host MUST clear the
  -- shipped egress guard before any outbound call (see calendar-sync.service.ts).
  base_url TEXT NOT NULL,
  -- Login name for HTTP basic / CalDAV. Not secret, but never echoed with creds.
  username TEXT,
  -- Encrypted (shared crypto util / MASTER_KEY) password, app-password or
  -- bearer token. NULL when the target needs no credential.
  credentials_encrypted TEXT,
  -- Remote calendar / collection id (CalDAV collection path or Exchange folder).
  calendar_id TEXT NOT NULL DEFAULT 'default',
  -- 'pull' | 'push' | 'both'
  direction TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('pull', 'push', 'both')),
  -- 'last_write_wins' (default) | 'local_wins' | 'remote_wins'
  conflict_policy TEXT NOT NULL DEFAULT 'last_write_wins'
    CHECK (conflict_policy IN ('last_write_wins', 'local_wins', 'remote_wins')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_accounts_user
  ON calendar_sync_accounts (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 159: per-event idempotency + conflict ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_sync_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES calendar_sync_accounts(id) ON DELETE CASCADE,
  -- Stable external identity. Re-pull dedupes on (account_id, calendar_id, external_uid).
  external_uid TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'default',
  -- Local event this external object maps to (NULL until imported).
  local_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  -- Remote version at last sync: ETag / Exchange changeKey.
  external_version TEXT,
  -- Local content hash at last sync (name + date + type).
  local_version TEXT,
  -- The version the conflict policy discarded (audit trail); NULL when no conflict.
  losing_version TEXT,
  last_direction TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, calendar_id, external_uid)
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_events_account
  ON calendar_sync_events (account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_events_local
  ON calendar_sync_events (user_id, local_event_id);

-- ---------------------------------------------------------------------------
-- 160: single-owner collaboration invites (invite-only guests, roles + scope)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collaboration_invites (
  id BIGSERIAL PRIMARY KEY,
  -- The ONE owner of all data. Guests are never rows in \`users\`.
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guest_email TEXT,
  -- 'viewer' | 'commenter' | 'editor'
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
  -- Scope: any combination of profile, tag and entity types. An empty
  -- \`scope_entity_types\` means "all supported entity types" for the chosen
  -- profile/tag; with no profile AND no tag it is bounded by entity types only.
  scope_profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  scope_tag TEXT,
  scope_entity_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- SHA-256 hex of the high-entropy raw invite token - the ONLY persisted form.
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collaboration_invites_owner
  ON collaboration_invites (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_activity (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'owner' | 'guest'
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'guest')),
  actor_label TEXT,
  invite_id BIGINT REFERENCES collaboration_invites(id) ON DELETE SET NULL,
  -- 'invite_created' | 'invite_revoked' | 'guest_viewed' | 'guest_commented'
  -- | 'guest_event_created' | 'guest_write_denied'
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collaboration_activity_owner
  ON collaboration_activity (owner_user_id, created_at DESC, id DESC);`,
    },
    {
      // v75 (task 168): birthday greeting link - events.contact_id + fixed_contacts.greeting_opt_out.
      // Re-runnable: both ALTERs use ADD COLUMN IF NOT EXISTS (no existing migration was touched).
      version: 75,
      name: 'birthday_link_v75',
      sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES fixed_contacts(id) ON DELETE SET NULL;
ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS greeting_opt_out BOOLEAN NOT NULL DEFAULT FALSE;`,
    },
    {
      // v76: TOTP recovery codes. With 2FA on, login hard-requires a TOTP code and this is a
      // single-user app - a lost authenticator would mean a permanently lost account.
      // Codes are stored as SHA-256 hashes in this JSONB array. Re-runnable: ADD COLUMN IF NOT EXISTS.
      version: 76,
      name: 'totp_recovery_codes_v76',
      sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_codes JSONB NOT NULL DEFAULT '[]';`,
    },
    {
      // v77: fold the legacy 'email' channel into 'resend'. Delivery has always treated the two
      // identically (same send branch, same account fields), but 'email' has no UI template, so
      // accounts and event selections typed 'email' stayed active-yet-invisible. Retyping them
      // makes them visible and manageable under the 'resend' template with zero behaviour change.
      // Historical trigger logs are left as-is (they are an audit record, and their
      // channel_results keys are keyed by the original channel id). The 'email' alias stays in
      // the dispatch chain as a safety net for rows written between the code deploy and this
      // migration. Idempotent: every UPDATE is guarded by a containment check.
      version: 77,
      name: 'fold_email_channel_v77',
      sql: `UPDATE notification_accounts SET type = 'resend' WHERE type = 'email';
UPDATE events SET notification_channels = REPLACE(notification_channels::text, '"email"', '"resend"')::jsonb
  WHERE notification_channels @> '["email"]'::jsonb;`,
    },
    {
      // v78: notification reachability. Accounts no longer get hard-disabled after 3
      // consecutive failures (that silently removed them from every resolver); instead they
      // are suspended for 24h and auto-recover. Also: per-user reminder catch-up window
      // (minutes; NULL = env/10) and the email template style selector.
      version: 78,
      name: 'notification_reachability_v78',
      sql: `ALTER TABLE notification_accounts ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS reminder_catchup_minutes INTEGER;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS email_template_style TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS fallback_enabled BOOLEAN NOT NULL DEFAULT TRUE;`,
    },
    {
      // v79: AI birthday greetings. Per-user greeting mode (auto = send on the day,
      // draft = stage for one-click send) and AI toggle; contacts gain a birth_date so
      // greetings work without a linked birthday event; greeting_history stores the
      // final composed text per contact/year/channel (rotation basis + audit).
      version: 79,
      name: 'ai_birthday_greetings_v79',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS greeting_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS greeting_ai_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE fixed_contacts ADD COLUMN IF NOT EXISTS birth_date DATE;
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_greeting_history_user_year ON greeting_history(user_id, year DESC);`,
    },
    {
      // v80: log retention & bounded cron status.
      // - greeting_history gains source (ai|composer) and tone for the greeting AI budget
      //   gate and per-draft regeneration;
      // - digest_archive stores the AI monthly digest narrative so raw trigger logs can
      //   expire at 90 days without losing history ("AI keeps what matters");
      // - cron_job_status is a one-row-per-job upsert (last outcome) replacing the
      //   every-minute success rows; failed details stay in cron_execution_logs (30d);
      // - indexes for the two hot paths: /api/health's cron status lookup and the
      //   trigger-logs list ordering.
      version: 80,
      name: 'log_retention_and_ai_greetings_v80',
      sql: `ALTER TABLE greeting_history ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'composer';
ALTER TABLE greeting_history ADD COLUMN IF NOT EXISTS tone TEXT;
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
CREATE TABLE IF NOT EXISTS cron_job_status (
  job_name TEXT PRIMARY KEY,
  last_status TEXT NOT NULL,
  last_ok_at TIMESTAMPTZ,
  last_error TEXT,
  last_summary TEXT,
  last_duration_ms INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cron_executed_at ON cron_execution_logs(executed_at);
CREATE INDEX IF NOT EXISTS idx_trigger_user_created ON event_trigger_logs(user_id, created_at);`,
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
