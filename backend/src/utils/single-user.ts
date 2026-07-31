import { query } from '../db/index.js';

/** TimeMark is a single-user personal app — only one account may exist. */
export const DEPLOYMENT_MODE = 'single-user' as const;

export async function getUserCount(): Promise<number> {
  const result = await query('SELECT COUNT(*)::int AS count FROM users');
  return result.rows[0]?.count ?? 0;
}

export async function assertCanCreateUser(): Promise<void> {
  const count = await getUserCount();
  if (count >= 1) {
    throw new Error('本系统仅支持单用户，无法创建更多账户');
  }
}

export async function getOwnerUserId(): Promise<number | null> {
  const result = await query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
  const id = result.rows[0]?.id;
  return id != null ? Number(id) : null;
}
