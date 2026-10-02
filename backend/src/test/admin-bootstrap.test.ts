import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';

/**
 * Admin bootstrap hardening: there is no published default administrator
 * credential, and production refuses to create an admin at all unless
 * `DEFAULT_ADMIN_PASSWORD` is explicitly set and strong enough.
 *
 * Driven through `ensureVercelReady()` — the real cold-start path every
 * non-health `/api/*` request takes on Vercel — so these cases exercise the
 * production gate itself rather than a helper. `vi.resetModules()` per case
 * clears the module-level `initPromise` dedupe so each case gets a real run.
 *
 * `ADMIN_BOOTSTRAP_REFUSED` is the greppable marker the bootstrap emits on every
 * refusal, so a deployment that skipped admin creation is auditable from logs.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../db/index.js', () => ({ query: mockQuery, waitForDb: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ createLogger: () => mockLogger }));
vi.mock('../utils/password.js', () => ({
  hashPassword: vi.fn(async (password: string) => `hashed(${password})`),
}));
// Cold-start collaborators: irrelevant here, but their real modules drag in the
// whole migration/secret/storage graph, so keep the unit hermetic.
vi.mock('../db/migrate.js', () => ({ runMigrations: vi.fn(), migrateEncryptionKey: vi.fn() }));
vi.mock('../utils/secrets.js', () => ({ initSecretKeys: vi.fn() }));
vi.mock('../services/storage.service.js', () => ({ logStorageStartupStatus: vi.fn() }));
vi.mock('../middleware/auth.middleware.js', () => ({
  authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', { id: '1', username: 'admin' });
    return next();
  },
}));

import securityRoutes from '../routes/security.js';

const ENV_KEYS = ['NODE_ENV', 'VERCEL', 'DATABASE_URL', 'DEFAULT_ADMIN_PASSWORD', 'DEFAULT_ADMIN_USERNAME'] as const;
let savedEnv: Record<string, string | undefined>;

/** Fresh module instance per case (clears the `initPromise` dedupe), then run the cold start. */
async function coldStart(): Promise<void> {
  vi.resetModules();
  const mod = await import('../vercel-init.js');
  await mod.ensureVercelReady();
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DATABASE_URL = 'postgres://localhost:5432/timemark';
  mockQuery.mockReset();
  for (const level of Object.values(mockLogger)) level.mockReset();
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('COUNT(*)::int')) return { rows: [{ count: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function issuedInserts(): Array<{ sql: string; params: unknown[] }> {
  return mockQuery.mock.calls
    .filter(([sql]) => sql.startsWith('INSERT INTO users'))
    .map(([sql, params]) => ({ sql, params: params ?? [] }));
}

function logText(): string {
  return [...mockLogger.info.mock.calls, ...mockLogger.warn.mock.calls, ...mockLogger.error.mock.calls]
    .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .join('\n');
}

describe('admin bootstrap', () => {
  it('creates no admin in production when DEFAULT_ADMIN_PASSWORD is unset', async () => {
    process.env.NODE_ENV = 'production';

    await coldStart();

    expect(issuedInserts()).toHaveLength(0);
    expect(logText()).toContain('ADMIN_BOOTSTRAP_REFUSED');
  });

  it('creates no admin in production when DEFAULT_ADMIN_PASSWORD is under 12 characters', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEFAULT_ADMIN_PASSWORD = 'Sh0rt-Pass!';

    await coldStart();

    expect(issuedInserts()).toHaveLength(0);
    expect(logText()).toContain('ADMIN_BOOTSTRAP_REFUSED');
  });

  it('rejects a small blocklist of trivially guessable passwords in production', async () => {
    process.env.NODE_ENV = 'production';
    // All four are >= 12 characters, so only the blocklist can catch them.
    const guessable = ['TimeMark@2026', 'TIMEMARK@2026', 'admin123456!', 'password123!'];

    for (const password of guessable) {
      mockQuery.mockClear();
      for (const level of Object.values(mockLogger)) level.mockClear();
      process.env.DEFAULT_ADMIN_PASSWORD = password;

      await coldStart();

      expect(issuedInserts(), `${password} must not be accepted`).toHaveLength(0);
      expect(logText(), `${password} must be refused loudly`).toContain('ADMIN_BOOTSTRAP_REFUSED');
    }
  });

  it('creates the admin in development with a short password (dev stays frictionless)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEFAULT_ADMIN_PASSWORD = 'short';

    await coldStart();

    const inserts = issuedInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[0]).toBe('admin');
    expect(inserts[0].params[1]).toBe('hashed(short)');
  });

  it('treats VERCEL as production even when NODE_ENV is not set', async () => {
    process.env.VERCEL = '1';
    expect(process.env.NODE_ENV).toBeUndefined();

    await coldStart();

    expect(issuedInserts()).toHaveLength(0);
    expect(logText()).toContain('ADMIN_BOOTSTRAP_REFUSED');
  });

  it('exposes password_changed_at on the login response so must-change is auditable', async () => {
    const changedAt = '2026-10-01T03:04:05.000Z';
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM schema_version')) return { rows: [{ version: 75 }], rowCount: 1 };
      if (sql.includes('password_changed_at')) return { rows: [{ password_changed_at: changedAt }], rowCount: 1 };
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    });

    const app = new Hono();
    app.route('/api/security', securityRoutes);
    const res = await app.request('/api/security/deploy-info');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.passwordChangedAt).toBe(changedAt);

    // The login response keeps deriving must-change from the same real column.
    const authSource = readFileSync(new URL('../routes/auth.ts', import.meta.url), 'utf8');
    expect(authSource).toContain('const mustChangePassword = !user.passwordChangedAt;');
  });
});