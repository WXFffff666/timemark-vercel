import { waitForDb, query } from './db/index.js';
import { runMigrations, migrateEncryptionKey } from './db/migrate.js';
import { initSecretKeys } from './utils/secrets.js';
import { hashPassword } from './utils/password.js';
import { createLogger } from './utils/logger.js';
import { assertCanCreateUser } from './utils/single-user.js';
import { logStorageStartupStatus } from './services/storage.service.js';

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
  logStorageStartupStatus();
  await waitForDb();
  await runMigrations();
  await migrateEncryptionKey();
  await ensureAdminUser();
  log.info('Vercel bootstrap complete');
}

/** Minimum length for an operator-supplied `DEFAULT_ADMIN_PASSWORD` in production. */
const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * ponytail: the blocklist is deliberately tiny — it exists only to stop the handful
 * of passwords this project used to publish. Upgrade path: when the app supports real
 * multi-user registration, move strength enforcement into a shared password policy
 * (composition rules / breached-password lookup) and reuse it on the change-password
 * endpoint too, instead of widening this constant.
 */
const ADMIN_PASSWORD_BLOCKLIST = new Set([
  // The password this project used to ship in README/.env.example — plus case and
  // separator variants, since those are the first guesses anyone makes.
  'timemark@2026',
  'timemark2026',
  'timemark#2026',
  // Generic fallbacks people type for a fresh single-account deploy.
  'admin123456!',
  'password123!',
  'qwertyuiop12',
  'administrator',
]);

/** Greppable marker emitted whenever the bootstrap declines to create an admin. */
export const ADMIN_BOOTSTRAP_REFUSED = 'ADMIN_BOOTSTRAP_REFUSED';

/**
 * Local-development fallback so `pnpm dev` works with zero configuration.
 *
 * NOT a credential: it exists only so a developer is not forced to invent a
 * password before the first local run. It is a constant in a public repository
 * and MUST NEVER be honoured when `process.env.VERCEL` is set or
 * `NODE_ENV === 'production'` — `ensureAdminUser` refuses before reaching it in
 * either case.
 */
const DEV_ONLY_ADMIN_PASSWORD = 'dev-only-not-a-credential';

/**
 * Production gate for the admin password. `VERCEL` alone is treated as production:
 * preview deployments are reachable by anyone with the URL.
 */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
}

/**
 * @returns `null` when the password is acceptable, otherwise a human-readable reason.
 * Hand-rolled on purpose — a strength library would be more code than the check is worth.
 */
export function assertStrongAdminPassword(password: string): string | null {
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`;
  }
  if (ADMIN_PASSWORD_BLOCKLIST.has(password.toLowerCase())) {
    return 'password is a well-known default and must not be used';
  }
  return null;
}

export async function ensureAdminUser(): Promise<void> {
  const userResult = await query('SELECT id FROM users LIMIT 1');
  if (userResult.rows.length > 0) return;

  const isProd = isProductionRuntime();
  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const configured = process.env.DEFAULT_ADMIN_PASSWORD?.trim();

  let password: string;
  if (configured) {
    const reason = isProd ? assertStrongAdminPassword(configured) : null;
    if (reason) {
      log.error(
        { event: ADMIN_BOOTSTRAP_REFUSED, reason, username },
        `${ADMIN_BOOTSTRAP_REFUSED}: DEFAULT_ADMIN_PASSWORD rejected (${reason}) — no admin user was created. ` +
        `Set a unique password of ${MIN_ADMIN_PASSWORD_LENGTH}+ characters in the Vercel Production environment, then redeploy.`,
      );
      return;
    }
    password = configured;
  } else if (isProd) {
    log.error(
      { event: ADMIN_BOOTSTRAP_REFUSED, reason: 'unset', username },
      `${ADMIN_BOOTSTRAP_REFUSED}: DEFAULT_ADMIN_PASSWORD is not set — no admin user was created. ` +
      'Set it in the Vercel Production environment before the first deploy, then redeploy.',
    );
    return;
  } else {
    log.warn(
      { username },
      'DEV_ONLY_ADMIN_PASSWORD: development fallback in use — never reached on Vercel or NODE_ENV=production',
    );
    password = DEV_ONLY_ADMIN_PASSWORD;
  }

  await assertCanCreateUser();
  const passwordHash = await hashPassword(password);

  await query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
    [username, passwordHash],
  );
  const adminRow = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (adminRow.rows[0]?.id) {
    await query(
      `INSERT INTO user_configs (user_id, timezone) VALUES ($1, 'Asia/Shanghai') ON CONFLICT (user_id) DO NOTHING`,
      [adminRow.rows[0].id],
    );
  }
  log.info({ username }, 'Default admin user created');
}
