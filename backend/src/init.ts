import db from './db/index.js';
import { hashPassword } from './utils/password.js';
import { randomUUID } from 'crypto';

async function init() {
  console.log('🔧 初始化数据库...');

  // 检查是否已有用户
  const result = await db.execute({ sql: 'SELECT id FROM users LIMIT 1', args: [] });
  
  if (result.rows.length > 0) {
    console.log('✅ 数据库已初始化，已存在用户');
    return;
  }

  // 创建默认用户
  const username = 'admin';
  const password = 'admin123';
  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await db.execute({ 
    sql: 'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    args: [id, username, passwordHash, createdAt]
  });

  console.log('✅ 创建默认用户成功');
  console.log(`   用户名: ${username}`);
  console.log(`   密码: ${password}`);
  console.log('⚠️  请登录后立即修改密码并启用2FA！');
}

init().catch(console.error);
