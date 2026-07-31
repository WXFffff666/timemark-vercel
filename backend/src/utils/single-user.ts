import { query } from '../db/index.js';

/** TimeMark is a personal single-account app — only one user row is allowed. */
export async function assertCanCreateUser(): Promise<void> {
  const result = await query('SELECT COUNT(*)::int AS count FROM users');
  const count = result.rows[0]?.count ?? 0;
  if (count >= 1) {
    throw new Error('本系统仅支持单账户，无法创建更多用户');
  }
}
