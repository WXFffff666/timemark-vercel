#!/usr/bin/env node

/**
 * TimeMark — PostgreSQL Database Migration Script
 *
 * Standalone script to apply the PostgreSQL schema and create the
 * initial admin user. Fully idempotent — safe to run multiple times.
 *
 * Usage:
 *   DATABASE_URL="postgresql://user:password@host:5432/dbname" npx tsx scripts/migrate-db.ts
 *
 * Or via pnpm (from backend/):
 *   pnpm run migrate-db
 */

import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrate(): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. Connection
  // ---------------------------------------------------------------------------
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is not set.');
    console.error('   Usage: DATABASE_URL="postgresql://user:password@host:5432/dbname" npx tsx scripts/migrate-db.ts');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
  });

  try {
    // Test connectivity
    process.stdout.write('🔌 Connecting to PostgreSQL... ');
    await pool.query('SELECT 1 AS ping');
    console.log('✅ connected');

    // ---------------------------------------------------------------------------
    // 2. Read schema file
    // ---------------------------------------------------------------------------
    const schemaPath = join(__dirname, '..', 'shared', 'src', 'schema.pg.sql');
    process.stdout.write(`📖 Reading schema from shared/src/schema.pg.sql... `);

    let schemaSql: string;
    try {
      schemaSql = readFileSync(schemaPath, 'utf-8');
    } catch {
      console.error('\n❌ Failed to read schema file.');
      console.error(`   Expected at: ${schemaPath}`);
      console.error('   Ensure the file exists (created in T2).');
      process.exit(1);
    }
    console.log(`✅ (${schemaSql.length} bytes)`);

    // ---------------------------------------------------------------------------
    // 3. Execute DDL statements one by one
    // ---------------------------------------------------------------------------
    const statements = schemaSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    console.log(`⚡ Executing ${statements.length} SQL statements...`);

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        await pool.query(stmt + ';');
        console.log(`   ✅ [${i + 1}/${statements.length}] executed`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`   ❌ [${i + 1}/${statements.length}] failed: ${msg}`);
        console.error(`      SQL: ${stmt.slice(0, 120)}${stmt.length > 120 ? '…' : ''}`);
        throw err;
      }
    }
    console.log('✅ Schema applied successfully');

    // Run incremental migrations (v2–v16) for existing deployments
    const { runMigrations } = await import('../backend/src/db/migrate.js');
    await runMigrations();

    // ---------------------------------------------------------------------------
    // 4. Create default admin user (idempotent)
    // ---------------------------------------------------------------------------
    const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
    const password = process.env.DEFAULT_ADMIN_PASSWORD || 'TimeMark@2026';

    const { rows: existing } = await pool.query('SELECT id FROM users LIMIT 1');

    if (existing.length === 0) {
      process.stdout.write(`👤 Creating default admin user "${username}"... `);

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      await pool.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
        [username, passwordHash],
      );

      console.log('✅ created');
      console.log(`   Username : ${username}`);
      console.log('   Password : (hidden — use DEFAULT_ADMIN_PASSWORD env or change after first login)');
      console.log('⚠️  Change the default password after first login!');
    } else {
      console.log('👤 Users already exist — skipping admin creation');
    }

    // ---------------------------------------------------------------------------
    // 5. Done
    // ---------------------------------------------------------------------------
    console.log('\n🎉 Migration completed successfully');
    await pool.end();
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Migration failed: ${msg}`);
    await pool.end().catch(() => { /* ignore */ });
    process.exit(1);
  }
}

migrate();
