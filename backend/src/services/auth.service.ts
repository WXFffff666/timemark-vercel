import { query } from '../db/index.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt.js';
import { randomUUID } from 'crypto';
import type { User, Session } from '@timemark/shared';

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

export async function createLoginLog(userIdOrUsername: string, ip: string, userAgent: string, fingerprint: string, success: boolean, reason?: string): Promise<void> {
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
      [id, userId, username, ip, userAgent, fingerprint, success ? true : false, reason || null]
    );
  } catch (error) {
    console.error('[createLoginLog] Failed:', error);
  }
}

// ============ 锁定机制 ============
// 公网部署：无运维解锁后门，仅能通过等待锁定期结束或正确密码登录解除
// 规则：以用户名为准统计连续失败（跨 IP 生效），5 次失败触发锁定，时间线性叠加
// 第 1 次锁定 5 分钟，第 2 次 10 分钟，第 3 次 15 分钟……

const LOCK_THRESHOLD = 5;
const LOCK_BASE_MINUTES = 5;

export async function getAccountLockStatus(params: { username: string; ip: string }): Promise<{
  isLocked: boolean;
  failureCount: number;
  lockTriggerCount: number;
  remainingSeconds: number;
  lockMinutes: number;
}> {
  // 以该用户最后一次成功登录为起点（任意 IP），防止换 IP 绕过计数
  const lastSuccessResult = await query(
    `SELECT MAX(login_time) AS last_success FROM login_logs
     WHERE success = TRUE
       AND (
         user_id = (SELECT id FROM users WHERE username = $1 LIMIT 1)
         OR username = $1
       )`,
    [params.username],
  );
  const lastSuccess = lastSuccessResult.rows[0]?.last_success || '1970-01-01';

  const failResult = await query(
    `SELECT COUNT(*) AS count FROM login_logs
     WHERE username = $1
       AND success = FALSE
       AND login_time > $2`,
    [params.username, lastSuccess],
  );
  let failureCount = failResult.rows.length > 0 ? parseInt(failResult.rows[0].count, 10) : 0;

  // 未知用户名：同时按 IP 累计失败（防枚举）
  if (failureCount === 0) {
    const ipFailResult = await query(
      `SELECT COUNT(*) AS count FROM login_logs
       WHERE ip_address = $1 AND success = FALSE AND login_time > NOW() - INTERVAL '1 hour'`,
      [params.ip],
    );
    failureCount = ipFailResult.rows.length > 0 ? parseInt(ipFailResult.rows[0].count, 10) : 0;
  }

  const lockTriggerCount = Math.floor(failureCount / LOCK_THRESHOLD);

  if (lockTriggerCount === 0) {
    return { isLocked: false, failureCount, lockTriggerCount: 0, remainingSeconds: 0, lockMinutes: 0 };
  }

  const lockMinutes = lockTriggerCount * LOCK_BASE_MINUTES;

  const lastFailResult = await query(
    `SELECT MAX(login_time) AS last_failure FROM login_logs
     WHERE username = $1 AND success = FALSE AND login_time > $2`,
    [params.username, lastSuccess],
  );
  let lastFailure = lastFailResult.rows[0]?.last_failure;

  if (!lastFailure && failureCount > 0) {
    const ipLastFail = await query(
      `SELECT MAX(login_time) AS last_failure FROM login_logs
       WHERE ip_address = $1 AND success = FALSE`,
      [params.ip],
    );
    lastFailure = ipLastFail.rows[0]?.last_failure;
  }

  if (lastFailure) {
    const lastFailureTime = new Date(lastFailure + 'Z').getTime();
    const lockUntilTime = lastFailureTime + lockMinutes * 60 * 1000;
    const remainingSeconds = Math.max(0, Math.floor((lockUntilTime - Date.now()) / 1000));

    if (remainingSeconds > 0) {
      return { isLocked: true, failureCount, lockTriggerCount, remainingSeconds, lockMinutes };
    }
  }

  return { isLocked: false, failureCount, lockTriggerCount, remainingSeconds: 0, lockMinutes: 0 };
}

export async function trackLoginFailure(params: { username: string; ip: string }): Promise<{ shouldLock: boolean; failureCount: number; lockTriggerCount: number }> {
  const status = await getAccountLockStatus(params);

  const shouldLock = status.failureCount >= LOCK_THRESHOLD && (status.failureCount % LOCK_THRESHOLD === 0);
  const lockMinutes = Math.max(status.lockTriggerCount, 1) * LOCK_BASE_MINUTES;
  const lockedUntil = shouldLock
    ? new Date(Date.now() + lockMinutes * 60 * 1000).toISOString()
    : null;

  await query(
    `INSERT INTO login_attempts (identifier, type, failed_count, locked_until, last_attempt)
     VALUES ($1, 'username', $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (identifier, type) DO UPDATE SET
       failed_count = $2,
       locked_until = COALESCE($3, login_attempts.locked_until),
       last_attempt = CURRENT_TIMESTAMP`,
    [params.username, status.failureCount, lockedUntil],
  );

  return {
    shouldLock,
    failureCount: status.failureCount,
    lockTriggerCount: status.lockTriggerCount,
  };
}
