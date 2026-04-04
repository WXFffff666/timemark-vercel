import { query } from '../db/index.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt.js';
import { randomUUID } from 'crypto';
import type { User, Session } from '@timemark/shared';

export async function createUser(username: string, password: string): Promise<User> {
  const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows.length > 0) throw new Error('Username already exists');

  const id = randomUUID();
  const passwordHash = await hashPassword(password);

  await query('INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)', [id, username, passwordHash]);

  return { id, username, createdAt: new Date().toISOString() };
}

export async function getUserByUsername(username: string): Promise<User | null> {
  const result = await query('SELECT id, username, created_at FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as any;
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

export async function getUserById(id: string): Promise<User | null> {
  const result = await query('SELECT id, username, created_at FROM users WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as any;
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

export async function verifyUserPassword(username: string, password: string): Promise<User | null> {
  const result = await query('SELECT id, username, password_hash, created_at FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as any;
  
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return null;
  
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

export async function createLoginLog(userIdOrUsername: string, ip: string, userAgent: string, fingerprint: string, success: boolean, reason?: string): Promise<void> {
  try {
    const id = randomUUID();
    const userId = success ? userIdOrUsername : null;
    const username = success ? null : userIdOrUsername;
    
    await query(
      'INSERT INTO login_logs (id, user_id, username, ip_address, user_agent, device_fingerprint, success, failure_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, userId, username, ip, userAgent, fingerprint, success, reason || null]
    );
  } catch (error) {
    console.error('[createLoginLog] Failed to log login attempt:', error);
  }
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
