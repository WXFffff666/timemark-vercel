import { Pool } from 'pg';

const DEFAULT_DB_PASSWORD = 'password';
const dbPassword = process.env.DB_PASSWORD;

// 安全检查：如果使用默认密码，发出警告
if (!dbPassword || dbPassword === DEFAULT_DB_PASSWORD) {
  console.warn('[SECURITY] ⚠️ 数据库密码未设置或使用默认密码！请设置DB_PASSWORD环境变量');
}

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'timemark',
  user: process.env.DB_USER || 'timemark',
  password: dbPassword,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// 生产环境抑制详细查询日志
const LOG_QUERIES = process.env.LOG_QUERIES === 'true';

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  // 仅在开发环境或启用详细日志时输出
  if (LOG_QUERIES) {
    console.log('Executed query', { text, duration, rows: res.rowCount });
  }
  return res;
}

export async function getClient() {
  return await pool.connect();
}

export default { query, pool, getClient };
