import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 57 acceptance: `GET /api/data/export` includes attachment METADATA but not bytes.
 *
 * The bytes never live in Postgres; this test pins the export shape so the metadata-only
 * contract cannot silently regress into something that tries to serialize file content.
 */

const authState = vi.hoisted(() => ({ user: { id: 7, username: 'alice' } }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      // Always authenticated in this file; `actual` only keeps the mock shape compatible.
      void actual;
      c.set('user', authState.user);
      return next();
    },
  };
});

import dataRoutes from '../routes/data.js';

const ATTACHMENT_ROW = {
  id: 3,
  owner_type: 'document',
  owner_id: 42,
  filename: '../../../etc/passwd.pdf',
  content_type: 'application/pdf',
  byte_size: 22,
  sha256: 'a'.repeat(64),
  storage_key: 'attachments/7/uuid-3.pdf',
  created_at: '2026-09-01T00:00:00.000Z',
  // A perverse row: if any future code path selected * and the column existed, bytes
  // would leak. The explicit column list in data.ts must never select this.
  data_base64: Buffer.from('%PDF-1.4 TOP-SECRET-BYTES').toString('base64'),
};

let captured: Array<{ sql: string; params: unknown[] }>;

function installDb(): void {
  captured = [];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM events')) return { rows: [{ id: 1, name: '生日' }], rowCount: 1 };
    if (s.includes('FROM user_configs')) return { rows: [{ user_id: 7, timezone: 'Asia/Shanghai' }], rowCount: 1 };
    if (s.includes('FROM notification_accounts')) return { rows: [], rowCount: 0 };
    if (s.includes('FROM relationship_mappings')) return { rows: [], rowCount: 0 };
    if (s.includes('FROM event_templates')) return { rows: [], rowCount: 0 };
    if (s.includes('FROM event_trigger_logs')) return { rows: [], rowCount: 0 };
    if (s.includes('FROM attachments')) {
      // The real query names its columns explicitly; the mock returns the projected
      // shape (minus the perverse `data_base64` column that must never be selected).
      const { data_base64: _neverSelected, ...projected } = ATTACHMENT_ROW;
      return { rows: [projected], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function exportData() {
  const res = await dataRoutes.request('/export', { method: 'GET' });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body, res };
}

beforeEach(() => {
  authState.user = { id: 7, username: 'alice' };
  installDb();
});

describe('GET /api/data/export - attachments', () => {
  it('exports metadata rows with an explicit column list (no SELECT *)', async () => {
    const { status, body } = await exportData();
    expect(status).toBe(200);

    const attachments = body.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(Object.keys(attachments[0]).sort()).toEqual(
      ['byte_size', 'content_type', 'created_at', 'filename', 'id', 'owner_id', 'owner_type', 'sha256', 'storage_key'].sort(),
    );
    expect(attachments[0]).toMatchObject({
      id: 3,
      owner_type: 'document',
      owner_id: 42,
      content_type: 'application/pdf',
      byte_size: 22,
    });

    const select = captured.find((q) => q.sql.includes('FROM attachments'));
    expect(select).toBeDefined();
    expect(select!.sql).not.toMatch(/SELECT\s+\*/i);
    expect(select!.sql).not.toContain('data_base64');
  });

  it('never includes file bytes or base64 payloads anywhere in the response', async () => {
    const { res, body } = await exportData();
    const raw = JSON.stringify(body);

    expect(raw).not.toContain('TOP-SECRET-BYTES');
    expect(raw).not.toContain('data_base64');
    expect(raw).not.toContain('dataBase64');
    expect(raw).not.toContain('"bytes"');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('keeps exporting the pre-existing entities unchanged', async () => {
    const { body } = await exportData();
    expect(body.events).toEqual([{ id: 1, name: '生日' }]);
    expect(body.configs).toHaveLength(1);
    expect(body.notificationAccounts).toEqual([]);
    expect(body.relationshipMappings).toEqual([]);
    expect(body.eventTemplates).toEqual([]);
    expect(body.triggerLogs).toEqual([]);
    expect(body.version).toBe('2.0');
    // New entities (todo 58) are exported too; this responder returns none.
    for (const key of ['expiryItems', 'expiryHistory', 'inventoryItems', 'maintenancePlans', 'maintenanceLogs', 'documents']) {
      expect(body[key]).toEqual([]);
    }
    expect(body.encryption).toMatchObject({ algorithm: 'aes-256-gcm' });
  });
});
