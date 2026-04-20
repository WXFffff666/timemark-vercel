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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, datetime('now'))`,
      [id, userId, username, ip, userAgent, fingerprint, success ? 1 : 0, reason || null]
    );
  } catch (error) {
    console.error('[createLoginLog] Failed:', error);
  }
}

// ============ 锁定机制 ============
// 规则：基于 IP + 设备指纹 进行锁定
// 5次失败触发锁定，锁定时间线性叠加：
// 第1次锁定 = 5分钟
// 第2次锁定 = 10分钟
// 第3次锁定 = 15分钟
// ...以此类推

const LOCK_THRESHOLD = 5; // 5次失败触发锁定
const LOCK_BASE_MINUTES = 5; // 基础锁定时间5分钟

export async function getAccountLockStatus(params: { username: string; ip: string }): Promise<{
  isLocked: boolean;
  failureCount: number;
  lockTriggerCount: number;
  remainingSeconds: number;
  lockMinutes: number;
}> {
  // 统计该IP的总失败次数（不限时间窗口，只看连续失败）
  // 从最后一次成功登录之后开始计数
  const lastSuccessResult = await query(
    `SELECT MAX(login_time) as last_success FROM login_logs 
     WHERE ip_address = $1 AND success = 1`,
    [params.ip]
  );
  const lastSuccess = lastSuccessResult.rows[0]?.last_success || '1970-01-01';

  // 统计最后一次成功登录之后的失败次数
  const failResult = await query(
    `SELECT COUNT(*) as count FROM login_logs 
     WHERE (username = $1 OR ip_address = $2) 
     AND success = 0 
     AND login_time > $3`,
    [params.username, params.ip, lastSuccess]
  );
  const failureCount = failResult.rows.length > 0 ? parseInt(failResult.rows[0].count) : 0;

  // 计算触发了几次锁定（每5次触发一次）
  const lockTriggerCount = Math.floor(failureCount / LOCK_THRESHOLD);

  if (lockTriggerCount === 0) {
    return { isLocked: false, failureCount, lockTriggerCount: 0, remainingSeconds: 0, lockMinutes: 0 };
  }

  // 线性叠加锁定时间
  const lockMinutes = lockTriggerCount * LOCK_BASE_MINUTES;

  // 检查最后一次失败时间，判断锁定是否还在生效
  const lastFailResult = await query(
    `SELECT MAX(login_time) as last_failure FROM login_logs 
     WHERE (username = $1 OR ip_address = $2) AND success = 0 AND login_time > $3`,
    [params.username, params.ip, lastSuccess]
  );
  const lastFailure = lastFailResult.rows[0]?.last_failure;

  if (lastFailure) {
    const lastFailureTime = new Date(lastFailure + 'Z').getTime(); // SQLite datetime is UTC
    const lockUntilTime = lastFailureTime + lockMinutes * 60 * 1000;
    const now = Date.now();
    const remainingSeconds = Math.max(0, Math.floor((lockUntilTime - now) / 1000));

    if (remainingSeconds > 0) {
      return { isLocked: true, failureCount, lockTriggerCount, remainingSeconds, lockMinutes };
    }
  }

  return { isLocked: false, failureCount, lockTriggerCount, remainingSeconds: 0, lockMinutes };
}

export async function trackLoginFailure(params: { username: string; ip: string }): Promise<{ shouldLock: boolean; failureCount: number; lockTriggerCount: number }> {
  const status = await getAccountLockStatus(params);
  return {
    shouldLock: status.failureCount >= LOCK_THRESHOLD && (status.failureCount % LOCK_THRESHOLD === 0),
    failureCount: status.failureCount,
    lockTriggerCount: status.lockTriggerCount
  };
}
