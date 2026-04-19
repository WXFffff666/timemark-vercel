import fs from 'fs';
import path from 'path';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';

export type QueryResult = {
  rows: any[];
  rowCount: number;
  lastInsertRowid?: number;
};

const DB_PATH = process.env.DB_PATH || './data/timemark.db';
const resolvedDbPath = path.resolve(DB_PATH);
const dataDir = path.dirname(resolvedDbPath);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// In-memory database instance
let db: SqlJsDatabase | null = null;
let dbReady = false;

// Initialize database
async function initDatabase(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();
  
  // Load existing database if exists
  if (fs.existsSync(resolvedDbPath)) {
    const fileBuffer = fs.readFileSync(resolvedDbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  
  dbReady = true;
  return db;
}

// Get database instance
export function getDb(): SqlJsDatabase {
  if (!db || !dbReady) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// Save database to file
function saveDatabase(): void {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(resolvedDbPath, buffer);
  }
}

// Wait for database initialization
export async function waitForDb(): Promise<SqlJsDatabase> {
  if (!db) {
    await initDatabase();
  }
  return getDb();
}

// Initialize on module load
initDatabase().catch(console.error);

const LOG_QUERIES = process.env.LOG_QUERIES === 'true';

function convertPgParamsToSqlite(text: string): string {
  return text.replace(/\$\d+/g, '?');
}

function isRowReturningQuery(sql: string): boolean {
  const normalized = sql.trim();
  const isSelectLike = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(normalized);
  const hasReturning = /\bRETURNING\b/i.test(normalized);
  return isSelectLike || hasReturning;
}

export async function query(text: string, params: any[] = []): Promise<QueryResult> {
  const start = Date.now();
  const sqliteText = convertPgParamsToSqlite(text);
  
  // Ensure database is ready
  await waitForDb();
  
  try {
    const database = getDb();
    
    if (isRowReturningQuery(sqliteText)) {
      const stmt = database.prepare(sqliteText);
      stmt.bind(params);
      
      const rows: any[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        rows.push(row);
      }
      stmt.free();
      
      const duration = Date.now() - start;
      
      if (LOG_QUERIES) {
        console.log('Executed query', { text, duration, rows: rows.length });
      }
      
      // Auto-save after reads
      saveDatabase();
      
      return {
        rows,
        rowCount: rows.length,
      };
    }
    
    database.run(sqliteText, params);
    
    const lastId = database.exec('SELECT last_insert_rowid() as id')[0]?.values[0]?.[0];
    const changes = database.getRowsModified();
    
    const duration = Date.now() - start;
    
    if (LOG_QUERIES) {
      console.log('Executed query', { text, duration, rows: changes });
    }
    
    // Auto-save after writes
    saveDatabase();
    
    return {
      rows: [],
      rowCount: changes,
      lastInsertRowid: typeof lastId === 'number' ? lastId : undefined,
    };
  } catch (error) {
    if (LOG_QUERIES) {
      console.error('Query failed', { text, params, error });
    }
    throw error;
  }
}

export function getClient(): SqlJsDatabase {
  return getDb();
}

export default { query, db: { getClient }, waitForDb };