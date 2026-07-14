import { waitForDb, query } from './db/index.js';
import { runMigrations, migrateEncryptionKey } from './db/migrate.js';
import { initSecretKeys } from './utils/secrets.js';
import { hashPassword } from './utils/password.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('vercel-init');

let initPromise: Promise<void> | null = null;

/**
 * One-time cold-start initialization for Vercel serverless.
 * Idempotent — safe to call on every request (deduped via initPromise).
 */
export function ensureVercelReady(): Promise<void> {
  if (!initPromise) {
    initPromise = bootstrapVercel().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function bootstrapVercel(): Promise<void> {
  log.info('Vercel cold-start bootstrap...');
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not configured — set it in Vercel Environment Variables');
  }
  initSecretKeys();
  await waitForDb();
  await runMigrations();
  await migrateEncryptionKey();
  await ensureAdminUser();
  log.info('Vercel bootstrap complete');
}

async function ensureAdminUser(): Promise<void> {
  const userResult = await query('SELECT id FROM users LIMIT 1');
  if (userResult.rows.length > 0) return;

  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'TimeMark@2026';
  const passwordHash = await hashPassword(password);

  await query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
    [username, passwordHash],
  );
  log.info({ username }, 'Default admin user created');
}
