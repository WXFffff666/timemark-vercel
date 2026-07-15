#!/usr/bin/env node
/**
 * Clear account lockout for a user (login_attempts + failed login_logs counter reset).
 * Usage: DATABASE_URL="..." npx tsx scripts/clear-login-lock.ts [username]
 */
import 'dotenv/config';
import { Pool } from 'pg';

const username = process.argv[2] || process.env.DEFAULT_ADMIN_USERNAME || 'admin';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

try {
  await pool.query('DELETE FROM login_attempts WHERE identifier = $1', [username]);
  const logs = await pool.query(
    `DELETE FROM login_logs WHERE username = $1 AND success = FALSE RETURNING id`,
    [username],
  );
  console.log(`Cleared lock for "${username}": login_attempts removed, ${logs.rowCount} failed login_logs deleted`);
} finally {
  await pool.end();
}
