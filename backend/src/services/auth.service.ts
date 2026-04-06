import { query } from '../db/index.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt.js';
import { randomUUID } from 'crypto';
import type { User, Session } from '@timemark/shared';

export async function createUser(username: string, password: string): Promise<User> {
  const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows.length > 0) throw new Error('Username already exists');

  const passwordHash = await hashPassword(password);

  // Don't specify id - let the database auto-increment
  await query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, passwordHash]);

  // Get the created user to return
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
  // Convert string ID to integer for database query
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

export async function createLoginLog(userIdOrUsername: string, ip: string, userAgent: string, fingerprint: string, success: boolean, reason?: string): Promise<void> {
  try {
    const id = randomUUID();
    let userId: number | null = null;
    let username: string | null = null;

    if (success) {
      // 成功登录时 userIdOrUsername 是 user.id (字符串格式，如 "1")
      const numericId = parseInt(userIdOrUsername, 10);
      if (!isNaN(numericId)) {
        const userResult = await query('SELECT id FROM users WHERE id = $1', [numericId]);
        if (userResult.rows.length > 0) {
          userId = userResult.rows[0].id;
        }
      }
    } else {
      // 失败时记录用户名
      username = userIdOrUsername;
    }
    
    await query(
      'INSERT INTO login_logs (id, user_id, username, ip_address, user_agent, device_fingerprint, success, failure_reason, login_time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())',
      [id, userId, username, ip, userAgent, fingerprint, success, reason || null]
    );
  } catch (error) {
    console.error('[createLoginLog] Failed to log login attempt:', error);
  }
}

// 获取账户锁定状态
export async function getAccountLockStatus(params: { username: string; ip: string }): Promise<{ 
  isLocked: boolean; 
  lockedUntil: Date | null;
  failureCount: number;
  remainingSeconds: number;
}> {
  // 检查最近1小时内的失败尝试
  const windowStart = new Date(Date.now() - 60 * 60 * 1000);
  
  const result = await query(
    `SELECT COUNT(*) as count, MAX(login_time) as last_failure FROM login_logs 
     WHERE (username = $1 OR ip_address = $2) 
     AND success = FALSE 
     AND login_time > $3`,
    [params.username, params.ip, windowStart]
  );
  
  const count = result.rows.length > 0 ? parseInt(result.rows[0].count) : 0;
  
  // 渐进式锁定规则
  // 5次失败 → 锁定1分钟
  // 10次失败 → 锁定5分钟
  // 15次失败 → 锁定15分钟
  // 20次失败 → 锁定30分钟
  // 25次以上 → 锁定1小时
  let lockMinutes = 0;
  if (count >= 25) lockMinutes = 60;
  else if (count >= 20) lockMinutes = 30;
  else if (count >= 15) lockMinutes = 15;
  else if (count >= 10) lockMinutes = 5;
  else if (count >= 5) lockMinutes = 1;
  
  if (lockMinutes === 0) {
    return { isLocked: false, lockedUntil: null, failureCount: count, remainingSeconds: 0 };
  }
  
  // 检查最近一次失败后是否已经过了锁定时间
  const lastFailure = result.rows[0]?.last_failure;
  if (lastFailure) {
    const lastFailureTime = new Date(lastFailure);
    const lockUntil = new Date(lastFailureTime.getTime() + lockMinutes * 60 * 1000);
    const now = new Date();
    const remainingSeconds = Math.max(0, Math.floor((lockUntil.getTime() - now.getTime()) / 1000));
    
    if (remainingSeconds > 0) {
      return { isLocked: true, lockedUntil: lockUntil, failureCount: count, remainingSeconds };
    }
  }
  
  return { isLocked: false, lockedUntil: null, failureCount: count, remainingSeconds: 0 };
}

export async function trackLoginFailure(params: { username: string; ip: string }): Promise<{ shouldLock: boolean; failureCount: number }> {
  const windowStart = new Date(Date.now() - 15 * 60 * 1000);
  
  const result = await query(
    `SELECT COUNT(*) as count FROM login_logs 
     WHERE (username = $1 OR ip_address = $2) 
     AND success = FALSE 
     AND login_time > $3`,
    [params.username, params.ip, windowStart]
  );
  
  const count = result.rows.length > 0 ? parseInt(result.rows[0].count) : 0;
  return {
    shouldLock: count >= 10,
    failureCount: count
  };
}
