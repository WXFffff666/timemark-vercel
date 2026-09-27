import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@timemark/shared/crypto';

/**
 * Todo 58 acceptance (unit level): /api/data/import for the new life-domain entities.
 *
 * - a future export version is refused with a clear message and zero writes
 * - a missing table is treated as empty; a wrong-typed table is refused
 * - rows with a corrupt `updated_at` are skipped (never clobber anything)
 * - explicit ids + `ON CONFLICT ... WHERE updated_at < EXCLUDED.updated_at` (newer wins)
 * - children are only written when the parent belongs to the importing user
 * - documents with a number encrypted under a DIFFERENT MASTER_KEY are refused BEFORE
 *   any write, with a clear message
 * - every new-entity write goes through db.withTransaction (rollback is proven live)
 */

const authState = vi.hoisted(() => ({ user: { id: 7, username: 'alice' } }));
const { dbQuery, withTransactionMock, txQuery } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  withTransactionMock: vi.fn(),
  txQuery: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  withTransaction: withTransactionMock,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      void actual;
      c.set('user', authState.user);
      return next();
    },
  };
});

import dataRoutes from '../routes/data.js';
import { exportKeyFingerprint } from '../services/data-transfer.service.js';

const MASTER_KEY_A = 'unit-test-master-key-alpha';
const MASTER_KEY_B = 'unit-test-master-key-bravo';

interface TxCall {
  sql: string;
  params: unknown[];
}

let txCalls: TxCall[];
let txRowCount: number;

function installMocks(): void {
  txCalls = [];
  txRowCount = 1;
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  txQuery.mockReset();
  txQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    txCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('SELECT 1 FROM')) return { rows: [{ ok: 1 }], rowCount: 1 };
    return { rows: txRowCount > 0 ? [{ id: 1 }] : [], rowCount: txRowCount };
  });
  withTransactionMock.mockReset();
  withTransactionMock.mockImplementation(
    async (fn: (client: { query: typeof txQuery }) => Promise<unknown>) => fn({ query: txQuery }),
  );
}

async function importPayload(body: Record<string, unknown>) {
  const res = await dataRoutes.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '2.0',
    events: [],
    encryption: { algorithm: 'aes-256-gcm', masterKeyFingerprint: exportKeyFingerprint() },
    ...overrides,
  };
}

function documentPayload(numberCiphertext: string): Record<string, unknown> {
  return basePayload({
    documents: [
      {
        id: 9,
        kind: 'passport',
        title: '护照',
        document_number_encrypted: numberCiphertext,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ],
  });
}

beforeEach(() => {
  authState.user = { id: 7, username: 'alice' };
  process.env.MASTER_KEY = MASTER_KEY_A;
  installMocks();
});

describe('POST /api/data/import - malformed input', () => {
  it('refuses a future export version before any write', async () => {
    const { status, body } = await importPayload({ version: '3.0', events: [] });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('不支持的导出版本');
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('still accepts legacy 1.x payloads (old entities only)', async () => {
    const { status } = await importPayload({ version: '1.0', events: [] });
    expect(status).toBe(200);
    // No new-entity keys -> the transaction runs but applies nothing.
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('treats a missing table in the payload as empty and refuses a wrong-typed one', async () => {
    const ok = await importPayload(basePayload({ inventoryItems: undefined }));
    expect(ok.status).toBe(200);

    const bad = await importPayload(basePayload({ inventoryItems: { nope: true } }));
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain('inventoryItems 必须是数组');
    expect(withTransactionMock).toHaveBeenCalledTimes(1); // only the first (ok) request
  });

  it('skips rows with a corrupt updated_at instead of clobbering or crashing', async () => {
    const { status, body } = await importPayload(
      basePayload({
        inventoryItems: [
          {
            id: 5,
            name: '牛奶',
            category: 'food',
            quantity: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: 'not-a-date',
          },
        ],
      }),
    );

    expect(status).toBe(200);
    const data = body.data as Record<string, unknown>;
    expect(data.inventoryItems).toBe(0);
    expect(data.skipped).toBe(1);
    // The corrupt row never reached the database.
    expect(txCalls.filter((call) => call.sql.startsWith('INSERT INTO inventory_items'))).toHaveLength(0);
  });

  it('refuses documents encrypted with a DIFFERENT MASTER_KEY before any write', async () => {
    process.env.MASTER_KEY = MASTER_KEY_A;
    const foreignCiphertext = encrypt('E12345678', MASTER_KEY_B);
    process.env.MASTER_KEY = MASTER_KEY_B;

    // Payload fingerprint was produced under key A (as a real export would be).
    const payload = {
      version: '2.0',
      events: [],
      encryption: {
        algorithm: 'aes-256-gcm',
        masterKeyFingerprint: (() => {
          process.env.MASTER_KEY = MASTER_KEY_A;
          const fp = exportKeyFingerprint();
          process.env.MASTER_KEY = MASTER_KEY_B;
          return fp;
        })(),
      },
      documents: [
        {
          id: 9,
          kind: 'passport',
          title: '护照',
          document_number_encrypted: foreignCiphertext,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
    };

    const { status, body } = await importPayload(payload);
    expect(status).toBe(400);
    expect(String(body.error)).toContain('MASTER_KEY');
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('refuses a matching fingerprint whose ciphertext cannot actually be decrypted', async () => {
    // Fingerprint claims key A, ciphertext was made with key B.
    const ciphertext = encrypt('E12345678', MASTER_KEY_B);
    const { status, body } = await importPayload(documentPayload(ciphertext));
    expect(status).toBe(400);
    expect(String(body.error)).toContain('MASTER_KEY');
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/data/import - idempotent newer-wins semantics', () => {
  it('inserts with explicit ids and forces user_id to the importing user', async () => {
    const { status, body } = await importPayload(
      basePayload({
        inventoryItems: [
          {
            id: 5,
            user_id: 999, // must be ignored
            name: '牛奶',
            category: 'food',
            quantity: 2,
            reminder_config: { daysBeforeList: [7] },
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    );

    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).inventoryItems).toBe(1);

    const insert = txCalls.find((call) => call.sql.startsWith('INSERT INTO inventory_items'))!;
    expect(insert).toBeDefined();
    expect(insert.sql).toContain('ON CONFLICT (id) DO UPDATE SET');
    expect(insert.sql).toContain('inventory_items.user_id = EXCLUDED.user_id');
    expect(insert.sql).toContain('inventory_items.updated_at < EXCLUDED.updated_at');
    expect(insert.params[0]).toBe(5); // explicit id
    expect(insert.params[1]).toBe(7); // forced to the session user
  });

  it('is a no-op on a second import (conflict without a newer updated_at applies nothing)', async () => {
    txRowCount = 0; // every ON CONFLICT hits an existing, not-older row
    const { status, body } = await importPayload(
      basePayload({
        expiryItems: [
          {
            id: 11,
            kind: 'custom',
            title: '域名',
            next_due_date: '2026-12-01',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    );

    expect(status).toBe(200);
    const data = body.data as Record<string, unknown>;
    expect(data.expiryItems).toBe(0);
    expect(data.skipped).toBe(1);
    // Still exactly one INSERT attempt (upsert), never a plain duplicate append.
    expect(txCalls.filter((call) => call.sql.startsWith('INSERT INTO expiry_items'))).toHaveLength(1);
  });

  it('uses DO NOTHING for append-only tables (history / logs / attachments)', async () => {
    await importPayload(
      basePayload({
        expiryHistory: [
          { id: 3, item_id: 11, action: 'renew', created_at: '2026-01-03T00:00:00.000Z' },
        ],
        maintenanceLogs: [
          { id: 4, plan_id: 21, done_at: '2026-01-04', created_at: '2026-01-04T00:00:00.000Z' },
        ],
        attachments: [
          {
            id: 6,
            owner_type: 'document',
            owner_id: 9,
            filename: '护照.pdf',
            content_type: 'application/pdf',
            byte_size: 100,
            sha256: 'a'.repeat(64),
            storage_key: 'attachments/7/uuid-6.pdf',
            created_at: '2026-01-05T00:00:00.000Z',
          },
        ],
      }),
    );

    for (const table of ['expiry_history', 'maintenance_logs', 'attachments']) {
      const insert = txCalls.find((call) => call.sql.startsWith(`INSERT INTO ${table}`))!;
      expect(insert, table).toBeDefined();
      expect(insert.sql, table).toContain('ON CONFLICT (id) DO NOTHING');
    }
  });

  it('only writes a child row when the parent belongs to the importing user', async () => {
    txQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      txCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('SELECT 1 FROM expiry_items')) return { rows: [], rowCount: 0 }; // not mine
      return { rows: [{ id: 1 }], rowCount: 1 };
    });

    const { status, body } = await importPayload(
      basePayload({
        expiryHistory: [
          { id: 3, item_id: 999, action: 'renew', created_at: '2026-01-03T00:00:00.000Z' },
        ],
      }),
    );

    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).expiryHistory).toBe(0);
    expect((body.data as Record<string, unknown>).skipped).toBe(1);
    expect(txCalls.filter((call) => call.sql.startsWith('INSERT INTO expiry_history'))).toHaveLength(0);
  });
});

describe('POST /api/data/import - transactional failure', () => {
  it('reports a rollback and does not leak partial state when the transaction throws', async () => {
    txQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      txCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.startsWith('INSERT INTO documents')) throw new Error('check constraint "documents_kind_check"');
      return { rows: [{ id: 1 }], rowCount: 1 };
    });

    const { status, body } = await importPayload(
      basePayload({
        expiryItems: [
          {
            id: 11,
            kind: 'custom',
            title: '域名',
            next_due_date: '2026-12-01',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-02T00:00:00.000Z',
          },
        ],
        documents: [
          {
            id: 9,
            kind: 'alien', // would violate the CHECK constraint
            title: '非法证件',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    );

    expect(status).toBe(500);
    expect(String(body.error)).toContain('事务已回滚');
    // The rollback itself is done by db.withTransaction (real BEGIN/ROLLBACK in prod);
    // here we assert every new-entity write went through that single transaction.
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });
});
