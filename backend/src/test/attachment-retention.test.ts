import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Todo 57 acceptance: orphan-attachment retention.
 *
 * - the candidate predicate is evaluated in SQL against a DATABASE-computed cutoff
 *   (`created_at < NOW() - $1 days`) with the day count as the only parameter, so no
 *   process-cached timestamp can ever be used
 * - orphan rows (unlinked, or owner row deleted) are deleted row-first, then object
 * - a referenced attachment never matches the predicate (NOT EXISTS per owner table)
 * - prompt-injection-shaped filenames are irrelevant: the purge never reads `filename`
 */

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
const { deleteObjectMock } = vi.hoisted(() => ({ deleteObjectMock: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../services/storage.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/storage.service.js')>();
  return { ...actual, deleteObject: deleteObjectMock };
});

import {
  ATTACHMENT_ORPHAN_RETENTION_DAYS,
  ATTACHMENT_PURGE_BATCH_LIMIT,
  purgeOrphanAttachments,
} from '../services/attachment-retention.service.js';

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];

function installDb(candidates: Array<Record<string, unknown>>): void {
  captured = [];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT a.id')) {
      return { rows: candidates, rowCount: candidates.length };
    }
    if (s.startsWith('DELETE FROM attachments WHERE id = ANY')) {
      return { rows: candidates, rowCount: candidates.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 1, user_id: 7, storage_key: 'attachments/7/uuid-1.pdf', ...overrides };
}

beforeEach(() => {
  installDb([candidate()]);
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);
});

describe('purgeOrphanAttachments', () => {
  it('uses a DB-computed 30-day cutoff with the day count as the only parameter', async () => {
    await purgeOrphanAttachments();

    const select = captured.find((q) => q.sql.replace(/\s+/g, ' ').trim().startsWith('SELECT a.id'));
    expect(select).toBeDefined();
    const sql = select!.sql.replace(/\s+/g, ' ');
    expect(sql).toContain("created_at < NOW() - ($1::int * INTERVAL '1 day')");
    // No cached JS timestamp: the ONLY parameter is the retention window in days.
    expect(select!.params).toEqual([ATTACHMENT_ORPHAN_RETENTION_DAYS]);
    expect(select!.params.every((p) => typeof p === 'number')).toBe(true);
  });

  it('never deletes a referenced attachment: the predicate requires NOT EXISTS in every owner table', async () => {
    await purgeOrphanAttachments();
    const sql = captured.find((q) => q.sql.replace(/\s+/g, ' ').trim().startsWith('SELECT a.id'))!.sql.replace(/\s+/g, ' ');

    for (const table of ['documents', 'expiry_items', 'inventory_items', 'maintenance_plans', 'events']) {
      expect(sql, table).toContain(`NOT EXISTS ( SELECT 1 FROM ${table} o WHERE o.id = a.owner_id AND o.user_id = a.user_id)`);
    }
    expect(sql).toContain('a.owner_type IS NULL');
    expect(sql).toContain(`LIMIT ${ATTACHMENT_PURGE_BATCH_LIMIT}`);
    // Filenames never participate in the retention decision.
    expect(sql).not.toContain('filename');
  });

  it('deletes candidate rows first, then their objects; result counts add up', async () => {
    installDb([
      candidate({ id: 1, storage_key: 'attachments/7/uuid-1.pdf' }),
      candidate({ id: 2, storage_key: 'attachments/7/uuid-2.pdf' }),
    ]);

    const result = await purgeOrphanAttachments();

    expect(result).toEqual({ orphans: 2, purged: 2, objectsDeleted: 2, objectDeleteFailures: 0 });
    const deleteSql = captured.find((q) => q.sql.includes('DELETE FROM attachments WHERE id = ANY'));
    expect(deleteSql).toBeDefined();
    expect(deleteSql!.params[0]).toEqual([1, 2]);
    expect(deleteObjectMock.mock.calls.map((call) => call[0])).toEqual([
      'attachments/7/uuid-1.pdf',
      'attachments/7/uuid-2.pdf',
    ]);
  });

  it('does not resurrect a row when the object delete fails (row is the source of truth)', async () => {
    deleteObjectMock.mockRejectedValueOnce(new Error('blob store down'));

    const result = await purgeOrphanAttachments();

    expect(result.purged).toBe(1);
    expect(result.objectsDeleted).toBe(0);
    expect(result.objectDeleteFailures).toBe(1);
  });

  it('re-evaluates the candidate set on every run (no module-level caching)', async () => {
    const first = await purgeOrphanAttachments();
    expect(first.orphans).toBe(1);

    // The "database" now contains a second, newly-aged orphan.
    installDb([candidate({ id: 5, storage_key: 'attachments/7/uuid-5.pdf' })]);
    const second = await purgeOrphanAttachments();
    expect(second.orphans).toBe(1);
    expect(deleteObjectMock).toHaveBeenLastCalledWith('attachments/7/uuid-5.pdf');
  });

  it('honours an explicit retention window and falls back to 30 days for malformed input', async () => {
    const lastSelectParams = () =>
      captured.filter((q) => q.sql.replace(/\s+/g, ' ').trim().startsWith('SELECT a.id')).at(-1)!.params;

    await purgeOrphanAttachments({ days: 7 });
    expect(lastSelectParams()).toEqual([7]);

    await purgeOrphanAttachments({ days: 0 });
    expect(lastSelectParams()).toEqual([ATTACHMENT_ORPHAN_RETENTION_DAYS]);

    await purgeOrphanAttachments({ days: Number.NaN });
    expect(lastSelectParams()).toEqual([ATTACHMENT_ORPHAN_RETENTION_DAYS]);
  });

  it('is a no-op (no DELETE, no object calls) when there are no orphans', async () => {
    installDb([]);
    const result = await purgeOrphanAttachments();
    expect(result).toEqual({ orphans: 0, purged: 0, objectsDeleted: 0, objectDeleteFailures: 0 });
    expect(captured).toHaveLength(1);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});
