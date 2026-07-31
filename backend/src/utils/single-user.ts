import { query } from '../db/index.js';

/** Personal deployment: one account only. Set SINGLE_USER_MODE=false to allow multiple users. */
export function isSingleUserMode(): boolean {
  const env = process.env.SINGLE_USER_MODE;
  if (env === 'false' || env === '0') return false;
  return true;
}

export async function getUserCount(): Promise<number> {
  const result = await query('SELECT COUNT(*)::int AS count FROM users');
  return result.rows[0]?.count ?? 0;
}

export async function assertCanCreateUser(): Promise<void> {
  if (!isSingleUserMode()) return;
  const count = await getUserCount();
  if (count >= 1) {
    throw new Error('单用户模式已启用，无法创建更多账户');
  }
}
