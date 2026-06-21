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

async function applyIncrementalMigrations(currentVersion: number): Promise<void> {
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
      version: 15,
      name: 'add_quiet_hours',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS quiet_hours_start TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS quiet_hours_end TEXT;`
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
      const value = row[field];
      if (!value) continue;

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
