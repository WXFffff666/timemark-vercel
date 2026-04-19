import { query } from './db/index.js';
import { hashPassword } from './utils/password.js';
import { randomUUID } from 'crypto';

async function init() {
  console.log('🔧 初始化数据库...');

  // 等待数据库就绪
  const { waitForDb } = await import('./db/index.js');
  await waitForDb();

  // 检查是否已有用户
  const result = await query('SELECT id FROM users LIMIT 1');
  
  if (result.rows.length > 0) {
    console.log('✅ 数据库已初始化，已存在用户');
    return;
  }

  // 检查是否设置了管理员凭证（生产环境必须设置！）
  const username = process.env.DEFAULT_ADMIN_USERNAME;
  const password = process.env.DEFAULT_ADMIN_PASSWORD;
  
  if (!username || !password) {
    console.error('❌ 安全错误：生产环境必须设置 DEFAULT_ADMIN_USERNAME 和 DEFAULT_ADMIN_PASSWORD 环境变量！');
    console.error('   请在 docker-compose.yml 或环境变量中设置：');
    console.error('   - DEFAULT_ADMIN_USERNAME: 管理员用户名');
    console.error('   - DEFAULT_ADMIN_PASSWORD: 管理员密码（请使用强密码）');
    process.exit(1);
  }

  // 创建默认用户
  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await query(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES ($1, $2, $3, $4)',
    [id, username, passwordHash, createdAt]
  );

  console.log('✅ 创建默认用户成功');
  console.log(`   用户名: ${username}`);
  console.log('⚠️  请登录后立即修改密码并启用2FA！');
}

init().catch(console.error);
