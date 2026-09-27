import { Pool, type PoolClient } from 'pg';

export type QueryResult = {
  rows: any[];
  rowCount: number;
  insertedId?: number;
};

let pool: Pool | null = null;
let poolReady = false;
let initPromise: Promise<Pool> | null = null;

const LOG_QUERIES = process.env.LOG_QUERIES === 'true';

// Initialize connection pool
async function initPool(): Promise<Pool> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      '[DB] DATABASE_URL environment variable is required for PostgreSQL connection'
    );
  }

  pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    // Default 10; test harnesses against a single-threaded engine (PGlite) can set
    // PG_POOL_MAX=1 to serialize every query over one connection.
    max: (() => {
      const configured = Number(process.env.PG_POOL_MAX);
      return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 50) : 10;
    })(),
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err);
  });

  if (process.env.VERCEL) {
    try {
      const { attachDatabasePool } = await import('@vercel/functions');
      attachDatabasePool(pool);
    } catch (err) {
      console.warn('[DB] attachDatabasePool failed:', err);
    }
  }

  poolReady = true;
  return pool;
}

// Wait for pool initialization (lazy singleton - no race condition)
export async function waitForDb(): Promise<Pool> {
  if (!initPromise) {
    initPromise = initPool();
  }
  await initPromise;
  if (!pool || !poolReady) {
    throw new Error('Database pool not initialized.');
  }
  return pool;
}

// Graceful shutdown - exported for unified handler in index.ts
export function gracefulShutdown(): void {
  if (pool) {
    console.log('[DB] Closing database pool...');
    pool.end();
    console.log('[DB] Database pool closed.');
  }
}

/**
 * Check if a query returns rows (SELECT, WITH, EXPLAIN, or has RETURNING clause).
 */
function isRowReturningQuery(sql: string): boolean {
  const normalized = sql.trim();
  const isSelectLike = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(normalized);
  const hasReturning = /\bRETURNING\b/i.test(normalized);
  return isSelectLike || hasReturning;
}

export async function query(text: string, params: any[] = []): Promise<QueryResult> {
  const start = Date.now();

  // Ensure pool is ready
  const client = await waitForDb();

  // Auto-append RETURNING id for simple INSERTs (skip UPSERT / tables without id PK)
  let sql = text;
  let addedReturning = false;
  if (
    /^\s*INSERT\b/i.test(sql) &&
    !/\bRETURNING\b/i.test(sql) &&
    !/\bON CONFLICT\b/i.test(sql)
  ) {
    sql = sql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id';
    addedReturning = true;
  }

  try {
    const result = await client.query(sql, params);

    const duration = Date.now() - start;

    if (LOG_QUERIES) {
      console.log('Executed query', { text, duration, rows: result.rowCount });
    }

    if (isRowReturningQuery(sql)) {
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
        insertedId: addedReturning && result.rows.length > 0
          ? Number(result.rows[0].id)
          : undefined,
      };
    }

    return {
      rows: [],
      rowCount: result.rowCount ?? 0,
      insertedId: addedReturning && result.rows.length > 0
        ? Number(result.rows[0].id)
        : undefined,
    };
  } catch (error) {
    if (LOG_QUERIES) {
      console.error('Query failed', { text, params, error });
    }
    throw error;
  }
}

export function getClient(): Pool {
  if (!pool || !poolReady) {
    throw new Error('Database not initialized. Call waitForDb() first.');
  }
  return pool;
}

/**
 * Run `fn` inside a single-connection transaction (BEGIN/COMMIT/ROLLBACK).
 *
 * Data import (todo 58) uses this so a mid-import failure leaves NOTHING written;
 * callers must use the provided `client` for every statement in the unit of work.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await waitForDb();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is broken; the original error is the useful one.
    }
    throw error;
  } finally {
    client.release();
  }
}

export default { query, db: { getClient }, waitForDb, withTransaction };
