import { query } from '../db/index.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { randomUUID } from 'crypto';
import type { User } from '@timemark/shared';

export async function createUser(username: string, password: string): Promise<User> {
  const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows.length > 0) throw new Error('Username already exists');

  const passwordHash = await hashPassword(password);
  await query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, passwordHash]);

  const result = await query('SELECT id, username, created_at FROM users WHERE username = $1', [username]);
  const row = result.rows[0] as any;
  return { id: row.id.toString(), username: row.username, createdAt: row.created_at };
}

export async function getUserByUsername(username: string): Promise<User | null> {
  const result = await query('SELECT id, username, avatar_url, created_at FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as any;
  return { id: row.id.toString(), username: row.username, avatarUrl: row.avatar_url, createdAt: row.created_at };
}

export async function getUserById(id: string): Promise<User | null> {
  const numericId = parseInt(id, 10);
  if (isNaN(numericId)) return null;
  const result = await query('SELECT id, username, avatar_url, created_at FROM users WHERE id = $1', [numericId]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as any;
  return { id: row.id.toString(), username: row.username, avatarUrl: row.avatar_url, createdAt: row.created_at };
}

export async function verifyUserPassword(username: string, password: string): Promise<User | null> {
  const result = await query('SELECT id, username, password_hash, avatar_url, created_at FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as any;
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return null;
  return { id: row.id.toString(), username: row.username, avatarUrl: row.avatar_url, createdAt: row.created_at };
}

// ============ 登录日志 ============

export async function createLoginLog(
  userIdOrUsername: string,
  ip: string,
  userAgent: string,
  fingerprint: string,
  success: boolean,
  reason?: string,
): Promise<void> {
  try {
    const id = randomUUID();
    let userId: number | null = null;
    let username: string | null = null;

    if (success) {
      const numericId = parseInt(userIdOrUsername, 10);
      if (!isNaN(numericId)) {
        const userResult = await query('SELECT id FROM users WHERE id = $1', [numericId]);
        if (userResult.rows.length > 0) {
          userId = userResult.rows[0].id;
        }
      }
    } else {
      username = userIdOrUsername;
    }

    await query(
      `INSERT INTO login_logs (id, user_id, username, ip_address, user_agent, device_fingerprint, success, failure_reason, login_time) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
      [id, userId, username, ip, userAgent, fingerprint, success ? true : false, reason || null],
    );
  } catch (error) {
    console.error('[createLoginLog] Failed:', error);
  }
}

// ============ 锁定机制 ============
// 公网部署：无运维解锁后门
// 5 次密码错误触发锁定，时间线性叠加：5 / 10 / 15 … 分钟
// 锁定期间拒绝一切登录尝试，不验证密码、不累计失败次数

const LOCK_THRESHOLD = 5;
const LOCK_BASE_MINUTES = 5;

export type AccountLockStatus = {
  isLocked: boolean;
  failureCount: number;
  lockTriggerCount: number;
  remainingSeconds: number;
  lockMinutes: number;
};

async function countPasswordFailuresSinceLastSuccess(username: string): Promise<number> {
  const lastSuccessResult = await query(
    `SELECT MAX(login_time) AS last_success FROM login_logs
     WHERE success = TRUE
       AND (
         user_id = (SELECT id FROM users WHERE username = $1 LIMIT 1)
         OR username = $1
       )`,
    [username],
  );
  const lastSuccess = lastSuccessResult.rows[0]?.last_success || '1970-01-01';

  const failResult = await query(
    `SELECT COUNT(*) AS count FROM login_logs
     WHERE username = $1
       AND success = FALSE
       AND COALESCE(failure_reason, '') NOT IN ('locked_attempt', 'rate_limited')
       AND login_time > $2`,
    [username, lastSuccess],
  );
  return failResult.rows.length > 0 ? parseInt(failResult.rows[0].count, 10) : 0;
}

function parseLockedUntil(lockedUntil: string | Date | null): number | null {
  if (!lockedUntil) return null;
  const raw = typeof lockedUntil === 'string' ? lockedUntil : lockedUntil.toISOString();
  const ms = raw.includes('T') || raw.endsWith('Z')
    ? new Date(raw).getTime()
    : new Date(raw + 'Z').getTime();
  return Number.isNaN(ms) ? null : ms;
}

export async function getAccountLockStatus(params: { username: string; ip: string }): Promise<AccountLockStatus> {
  const attemptResult = await query(
    `SELECT failed_count, locked_until FROM login_attempts
     WHERE identifier = $1 AND type = 'username'`,
    [params.username],
  );

  if (attemptResult.rows.length > 0) {
    const row = attemptResult.rows[0];
    const untilMs = parseLockedUntil(row.locked_until);
    if (untilMs && untilMs > Date.now()) {
      const remainingSeconds = Math.max(0, Math.floor((untilMs - Date.now()) / 1000));
      const failureCount = row.failed_count ?? 0;
      const lockTriggerCount = Math.max(1, Math.floor(failureCount / LOCK_THRESHOLD));
      return {
        isLocked: true,
        failureCount,
        lockTriggerCount,
        remainingSeconds,
        lockMinutes: Math.max(1, Math.ceil(remainingSeconds / 60)),
      };
    }
  }

  const failureCount = await countPasswordFailuresSinceLastSuccess(params.username);
  const lockTriggerCount = Math.floor(failureCount / LOCK_THRESHOLD);

  return {
    isLocked: false,
    failureCount,
    lockTriggerCount,
    remainingSeconds: 0,
    lockMinutes: 0,
  };
}

export async function trackLoginFailure(params: { username: string; ip: string }): Promise<{
  shouldLock: boolean;
  failureCount: number;
  lockTriggerCount: number;
  lockMinutes: number;
}> {
  const failureCount = await countPasswordFailuresSinceLastSuccess(params.username);
  const lockTriggerCount = Math.floor(failureCount / LOCK_THRESHOLD);
  const shouldLock = failureCount > 0 && failureCount % LOCK_THRESHOLD === 0;
  const lockMinutes = shouldLock ? lockTriggerCount * LOCK_BASE_MINUTES : 0;
  const lockedUntil = shouldLock
    ? new Date(Date.now() + lockMinutes * 60 * 1000).toISOString()
    : null;

  await query(
    `INSERT INTO login_attempts (identifier, type, failed_count, locked_until, last_attempt)
     VALUES ($1, 'username', $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (identifier, type) DO UPDATE SET
       failed_count = $2,
       locked_until = $3,
       last_attempt = CURRENT_TIMESTAMP`,
    [params.username, failureCount, lockedUntil],
  );

  return { shouldLock, failureCount, lockTriggerCount, lockMinutes };
}

export async function clearAccountLock(username: string): Promise<void> {
  await query(`DELETE FROM login_attempts WHERE identifier = $1 AND type = 'username'`, [username]);
}
