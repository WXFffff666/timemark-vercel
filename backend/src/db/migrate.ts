import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { getDb, waitForDb } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Auto-migration: ensures database schema is up to date on startup.
 * Reads schema.sql and executes it (all statements are idempotent with IF NOT EXISTS).
 * Tracks schema version for future incremental migrations.
 */
export async function runMigrations(): Promise<void> {
  console.log('[DB] Running migrations...');

  // Ensure database is ready
  await waitForDb();
  const db = getDb();

  // Find schema.sql - check multiple possible locations
  const possiblePaths = [
    path.resolve('./docker/schema.sql'),
    path.resolve('../docker/schema.sql'),
    path.resolve(__dirname, '../../../docker/schema.sql'),
    path.resolve(__dirname, '../../../../docker/schema.sql'),
  ];

  let schemaPath: string | null = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      schemaPath = p;
      break;
    }
  }

  if (!schemaPath) {
    console.warn('[DB] schema.sql not found, skipping migrations. Searched:', possiblePaths);
    return;
  }

  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  // Execute schema (all CREATE TABLE IF NOT EXISTS, so idempotent)
  try {
    db.exec(schemaSql);
    console.log('[DB] Schema applied successfully');
  } catch (error) {
    console.error('[DB] Failed to apply schema:', error);
    throw error;
  }

  // Check current schema version
  try {
    const stmt = db.prepare('SELECT MAX(version) as version FROM schema_version');
    const rows: any[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    const currentVersion = rows[0]?.version || 0;
    console.log(`[DB] Current schema version: ${currentVersion}`);

    // Apply incremental migrations
    await applyIncrementalMigrations(db, currentVersion);
  } catch (error) {
    console.error('[DB] Failed to check schema version:', error);
  }
}

async function applyIncrementalMigrations(db: any, currentVersion: number): Promise<void> {
  const migrations: Array<{ version: number; name: string; sql: string; postMigrate?: (db: any) => void }> = [
    {
      version: 2,
      name: 'add_api_key_column',
      sql: `ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS api_key TEXT;`
    },
    {
      version: 3,
      name: 'add_notification_queue',
      sql: `CREATE TABLE IF NOT EXISTS notification_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        next_retry_at TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_notification_queue_status ON notification_queue(status);
      CREATE INDEX IF NOT EXISTS idx_notification_queue_user ON notification_queue(user_id);`
    },
    {
      version: 4,
      name: 'add_recurring_events',
      sql: `ALTER TABLE events ADD COLUMN recurring_config TEXT;`
    },
    {
      version: 5,
      name: 'add_next_occurrence',
      sql: `ALTER TABLE events ADD COLUMN next_occurrence TEXT;`
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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        keys_p256dh TEXT,
        keys_auth TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, endpoint)
      );
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);`
    },
    {
      version: 8,
      name: 'add_timezone_column',
      sql: `ALTER TABLE user_configs ADD COLUMN timezone TEXT DEFAULT 'Asia/Shanghai';`
    },
    {
      version: 9,
      name: 'hash_existing_api_keys',
      sql: `SELECT 1;`,
      postMigrate: (db: any) => {
        // Hash existing plaintext API keys in-place (SHA-256)
        const stmt = db.prepare('SELECT user_id, api_key FROM user_configs WHERE api_key IS NOT NULL');
        const rows: Array<{ user_id: number; api_key: string }> = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject() as any);
        }
        stmt.free();
        for (const row of rows) {
          // Skip if already hashed (64 hex chars = SHA-256 hash)
          if (row.api_key.length === 64 && /^[0-9a-f]+$/.test(row.api_key)) continue;
          const hash = createHash('sha256').update(row.api_key).digest('hex');
          db.run('UPDATE user_configs SET api_key = ? WHERE user_id = ?', [hash, row.user_id]);
        }
        if (rows.length > 0) {
          console.log(`[DB] Hashed ${rows.length} existing API key(s)`);
        }
      },
    },
    {
      version: 10,
      name: 'add_channel_results_column',
      sql: `ALTER TABLE event_trigger_logs ADD COLUMN channel_results TEXT;`
    },
  ];

  for (const migration of migrations) {
    if (currentVersion < migration.version) {
      try {
        console.log(`[DB] Applying migration v${migration.version}: ${migration.name}`);
        db.exec(migration.sql);
        if (migration.postMigrate) {
          migration.postMigrate(db);
        }
        db.run('INSERT OR REPLACE INTO schema_version (version) VALUES (?)', [migration.version]);
        console.log(`[DB] Migration v${migration.version} applied successfully`);
      } catch (error) {
        console.error(`[DB] Migration v${migration.version} failed:`, error);
      }
    }
  }
}