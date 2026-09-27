import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encrypt } from '@timemark/shared/crypto';
import { MockCalDavServer } from './helpers/mock-caldav-server.js';

/**
 * Checkbox 86 orchestrator contract (`syncCalDavWriteBack`) against a mocked
 * CalDAV server and an in-memory PostgreSQL stand-in:
 *  - loop guard (per entity + per user) skips anything that came from an external sync
 *  - a second run with unchanged content neither re-PUTs nor duplicates
 *  - a persistent 412 leaves caldav_writeback_objects untouched (no local corruption)
 *  - stale mappings delete the remote object with the stored ETag
 *  - the toggle defaults OFF: no enabled row = zero requests
 */

const { dbQuery, isSafePublicUrlMock } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  isSafePublicUrlMock: vi.fn(async (): Promise<{ safe: boolean; reason?: string }> => ({ safe: true })),
}));

vi.mock('../db/index.js', () => ({ query: dbQuery, waitForDb: vi.fn(), getClient: vi.fn() }));
vi.mock('../utils/url-safety.js', () => ({ isSafePublicUrl: isSafePublicUrlMock }));

import { deriveCalDavUid, syncAllCalDavSubscriptions, syncCalDavWriteBack } from '../services/caldav-sync.service.js';

const MASTER_KEY = 'task86-test-master-key';
process.env.MASTER_KEY = MASTER_KEY;

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

interface FakeDbState {
  users: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  expiryItems: Array<Record<string, unknown>>;
  mappings: Array<Record<string, unknown>>;
  captured: CapturedQuery[];
}

let state: FakeDbState;
let server: MockCalDavServer;

function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: 1,
    caldav_username: 'davuser',
    caldav_password_encrypted: encrypt('dav-pass', MASTER_KEY),
    caldav_url: null,
    external_calendar_urls: [],
    caldav_writeback_enabled: true,
    caldav_writeback_url: server.baseUrl,
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    user_id: 1,
    name: '妈妈生日',
    type: 'birthday',
    date: '2026-10-01',
    person_name: '妈妈',
    reminder_config: { enabled: true, daysBeforeList: [1, 7] },
    ...overrides,
  };
}

function installDb(): void {
  state = { users: [], events: [], expiryItems: [], mappings: [], captured: [] };
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const compact = sql.replace(/\s+/g, ' ').trim();
    state.captured.push({ sql: compact, params });

    // Read-only import path (syncAllCalDavSubscriptions) selects the import URL.
    if (compact.startsWith('SELECT user_id, caldav_url, caldav_username')) {
      const rows = state.users.filter((row) => typeof row.caldav_url === 'string' && row.caldav_url !== '');
      return { rows, rowCount: rows.length };
    }
    if (compact.includes('FROM user_configs') && compact.includes('caldav_writeback_enabled = TRUE')) {
      // Emulates the WHERE clause: only opted-in users with a URL are returned.
      const rows = state.users.filter(
        (row) =>
          row.caldav_writeback_enabled === true &&
          typeof row.caldav_writeback_url === 'string' &&
          row.caldav_writeback_url !== '',
      );
      return { rows, rowCount: rows.length };
    }
    if (compact.startsWith('SELECT entity_type, entity_id, uid, collection_url, etag, content_hash FROM caldav_writeback_objects')) {
      const rows = state.mappings.filter((row) => row.user_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (compact.includes('date::text AS date') && compact.includes('FROM events')) {
      const rows = state.events.filter(
        (row) => row.user_id === params[0] && ((row.reminder_config as Record<string, unknown> | undefined)?.enabled ?? true) === true,
      );
      return { rows, rowCount: rows.length };
    }
    if (compact.includes('next_due_date::text') && compact.includes('FROM expiry_items')) {
      const rows = state.expiryItems.filter((row) => row.user_id === params[0] && row.is_active === true);
      return { rows, rowCount: rows.length };
    }
    if (compact.startsWith('SELECT id, reminder_config FROM events')) {
      const row = state.events.find((entry) => entry.user_id === params[0] && entry.id === params[1]);
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (compact.startsWith('SELECT id, is_active, reminder_config FROM expiry_items')) {
      const row = state.expiryItems.find((entry) => entry.user_id === params[0] && entry.id === params[1]);
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (compact.startsWith('INSERT INTO caldav_writeback_objects')) {
      const [userId, entityType, entityId, uid, collectionUrl, etag, contentHash] = params;
      const index = state.mappings.findIndex(
        (row) => row.user_id === userId && row.entity_type === entityType && row.entity_id === entityId,
      );
      const record = { user_id: userId, entity_type: entityType, entity_id: entityId, uid, collection_url: collectionUrl, etag, content_hash: contentHash };
      if (index >= 0) state.mappings[index] = record;
      else state.mappings.push(record);
      return { rows: [], rowCount: 1 };
    }
    if (compact.startsWith('DELETE FROM caldav_writeback_objects')) {
      const before = state.mappings.length;
      state.mappings = state.mappings.filter(
        (row) => !(row.user_id === params[0] && row.entity_type === params[1] && row.entity_id === params[2]),
      );
      return { rows: [], rowCount: before - state.mappings.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function upserts(): CapturedQuery[] {
  return state.captured.filter((entry) => entry.sql.startsWith('INSERT INTO caldav_writeback_objects'));
}

beforeEach(async () => {
  server = new MockCalDavServer();
  await server.start();
  installDb();
  isSafePublicUrlMock.mockReset();
  isSafePublicUrlMock.mockResolvedValue({ safe: true });
});

afterEach(async () => {
  await server.stop();
});

describe('loop guard', () => {
  it('SKIPS an entity that originated from an external sync', async () => {
    state.users = [userRow()];
    state.events = [
      eventRow({ id: 1, name: 'imported', reminder_config: { enabled: true, importSource: 'external_calendar' } }),
      eventRow({ id: 2, name: 'native', reminder_config: { enabled: true, daysBeforeList: [1] } }),
    ];

    const stats = await syncCalDavWriteBack();

    const uids = server.requests.map((request) => request.uid);
    expect(uids).toEqual([deriveCalDavUid('event', 2)]);
    expect(uids).not.toContain(deriveCalDavUid('event', 1));
    expect(stats.created).toBe(1);
    expect(stats.loopGuardSkips).toBe(1);
  });

  it('SKIPS a whole user whose write-back URL equals an import URL', async () => {
    state.users = [userRow({ caldav_url: server.baseUrl })];
    state.events = [eventRow({ id: 2 })];

    const stats = await syncCalDavWriteBack();

    expect(server.requests).toHaveLength(0);
    expect(stats.users).toBe(1);
    expect(stats.loopGuardSkips).toBe(1);
    expect(stats.created).toBe(0);
  });

  it('does not DELETE a remote object whose entity is now marked as imported', async () => {
    const uid = deriveCalDavUid('event', 5);
    state.users = [userRow()];
    // The load query only returns reminder-enabled rows, so event 5 is not
    // "desired"; the classification lookup finds it with importSource set.
    state.events = [eventRow({ id: 5, reminder_config: { enabled: false, importSource: 'caldav' } })];
    state.mappings = [
      { user_id: 1, entity_type: 'event', entity_id: 5, uid, collection_url: server.baseUrl, etag: '"v5"', content_hash: 'h5' },
    ];
    server.seed(uid, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');

    const stats = await syncCalDavWriteBack();

    expect(server.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
    expect(state.mappings).toHaveLength(1);
    expect(stats.deleted).toBe(0);
    expect(stats.loopGuardSkips).toBeGreaterThanOrEqual(1);
  });
});

describe('idempotency and stale state', () => {
  it('creates once, then a second run SKIPS the unchanged entity (no re-PUT, no duplicate)', async () => {
    state.users = [userRow()];
    state.events = [eventRow({ id: 2 })];

    const first = await syncCalDavWriteBack();
    expect(first.created).toBe(1);
    expect(server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(state.mappings).toHaveLength(1);
    // Reuses the existing Basic-auth credentials.
    const auth = server.requests[0]?.authorization;
    expect(auth).toBe(`Basic ${Buffer.from('davuser:dav-pass').toString('base64')}`);

    const second = await syncCalDavWriteBack();

    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    expect(server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0]?.uid).toBe(deriveCalDavUid('event', 2));
  });

  it('deletes the remote object (with the stored ETag) when the entity no longer qualifies', async () => {
    const uid = deriveCalDavUid('event', 9);
    state.users = [userRow()];
    state.mappings = [
      { user_id: 1, entity_type: 'event', entity_id: 9, uid, collection_url: server.baseUrl, etag: '"v9"', content_hash: 'h9' },
    ];
    server.seed(uid, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');

    const stats = await syncCalDavWriteBack();

    expect(stats.deleted).toBe(1);
    const deleteRequest = server.requests.find((request) => request.method === 'DELETE');
    expect(deleteRequest?.uid).toBe(uid);
    expect(deleteRequest?.ifMatch).toBe('"v9"');
    expect(state.mappings).toHaveLength(0);
  });

  it('pushes active expiry items under their own stable UID', async () => {
    state.users = [userRow()];
    state.expiryItems = [
      { id: 7, user_id: 1, title: '域名续费', kind: 'domain', vendor: 'Namecheap', next_due_date: '2026-11-11', reminder_config: { daysBeforeList: [7] }, is_active: true },
      { id: 8, user_id: 1, title: '已停用', kind: 'custom', vendor: null, next_due_date: '2026-01-01', reminder_config: null, is_active: false },
    ];

    const stats = await syncCalDavWriteBack();

    expect(stats.created).toBe(1);
    expect(server.requests.map((request) => request.uid)).toEqual([deriveCalDavUid('expiry_item', 7)]);
    expect(server.requests[0]?.body).toContain('SUMMARY:域名续费');
  });
});

describe('read-only CalDAV import (existing path, now loop-guard marked)', () => {
  it('still imports VEVENTs and tags them with importSource=caldav', async () => {
    const icsBody = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:external-1@example.com',
      'SUMMARY:Imported event',
      'DTSTART;VALUE=DATE:20261015',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const collectionServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      res.end(icsBody);
    });
    await new Promise<void>((resolve) => collectionServer.listen(0, '127.0.0.1', resolve));
    const collectionAddress = collectionServer.address() as AddressInfo;
    const collectionUrl = `http://127.0.0.1:${collectionAddress.port}/caldav/collection.ics`;
    try {
      state.users = [userRow({ caldav_writeback_enabled: false, caldav_url: collectionUrl })];

      const result = await syncAllCalDavSubscriptions();

      expect(result.synced).toBe(1);
      const insert = state.captured.find((entry) => entry.sql.startsWith('INSERT INTO events'));
      expect(insert).toBeDefined();
      const reminderConfig = JSON.parse(String(insert?.params[3])) as Record<string, unknown>;
      expect(reminderConfig.importSource).toBe('caldav');
      expect(insert?.params[1]).toBe('Imported event');
    } finally {
      await new Promise<void>((resolve, reject) => collectionServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe('412 handling and local state protection', () => {
  it('a persistent 412 reports an actionable error and does NOT touch the stored mapping', async () => {
    const uid = deriveCalDavUid('event', 2);
    state.users = [userRow()];
    state.events = [eventRow({ id: 2 })];
    state.mappings = [
      { user_id: 1, entity_type: 'event', entity_id: 2, uid, collection_url: server.baseUrl, etag: '"stale"', content_hash: 'old-hash' },
    ];
    server.seed(uid, 'BEGIN:VCALENDAR\r\nX-REMOTE\r\nEND:VCALENDAR\r\n');
    server.alwaysRejectPut.add(uid);

    const stats = await syncCalDavWriteBack();

    expect(stats.failed).toBe(1);
    expect(stats.errors.join(' | ')).toContain(uid);
    expect(stats.errors.join(' | ')).toContain('one retry');
    expect(stats.errors.join(' | ')).toContain('NOT modified');
    // Exactly one retry: initial PUT + retry PUT, one GET in between.
    const requests = server.requestsFor(uid);
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    expect(requests.filter((r) => r.method === 'GET')).toHaveLength(1);
    // Local state untouched: the old ETag/hash are still the only mapping row.
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0]?.etag).toBe('"stale"');
    expect(state.mappings[0]?.content_hash).toBe('old-hash');
    expect(upserts()).toHaveLength(0);
  });
});

describe('toggle discipline', () => {
  it('defaults OFF: a user without the toggle produces zero requests', async () => {
    state.users = [userRow({ caldav_writeback_enabled: false })];
    state.events = [eventRow({ id: 2 })];

    const stats = await syncCalDavWriteBack();

    expect(stats.users).toBe(0);
    expect(server.requests).toHaveLength(0);
    const runQuery = state.captured.find((entry) => entry.sql.includes('FROM user_configs') && entry.sql.includes('caldav_writeback_enabled = TRUE'));
    expect(runQuery).toBeDefined();
    expect(runQuery?.sql).toContain("caldav_writeback_url != ''");
  });

  it('rejects an unsafe write-back URL before any HTTP request', async () => {
    state.users = [userRow()];
    state.events = [eventRow({ id: 2 })];
    isSafePublicUrlMock.mockResolvedValue({ safe: false, reason: 'Private IP blocked' });

    const stats = await syncCalDavWriteBack();

    expect(server.requests).toHaveLength(0);
    expect(stats.errors.join(' | ')).toContain('Private IP blocked');
  });

  it('reports a decrypt failure without any HTTP request', async () => {
    state.users = [userRow({ caldav_password_encrypted: 'not-a-ciphertext' })];
    state.events = [eventRow({ id: 2 })];

    const stats = await syncCalDavWriteBack();

    expect(server.requests).toHaveLength(0);
    expect(stats.errors.join(' | ')).toContain('could not be decrypted');
  });
});
