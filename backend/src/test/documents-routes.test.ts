import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt } from '@timemark/shared/crypto';

/**
 * Todo 54 acceptance: /api/documents CRUD + /expiring + encrypted document numbers.
 *
 * Covered here:
 * - 401 without auth for every verb.
 * - `document_number` is encrypted at rest (the INSERT/UPDATE params are ciphertext,
 *   never plaintext), absent from every API response, and surfaced only as
 *   `numberConfigured` (the tokenConfigured convention).
 * - update/replace/clear of the number works without exposing it.
 * - A wrong MASTER_KEY FAILS CLOSED: reveal returns 422 with no ciphertext/plaintext,
 *   and the list endpoint keeps working (it never decrypts).
 * - Legacy-key values are decrypted and re-encrypted with the current key.
 * - link/unlink attachments are owner-checked on both ends; list/detail/extras are
 *   user-scoped (foreign ids are 404).
 *
 * The DB is mocked (no reachable Postgres in this environment); the auth middleware
 * delegates to the real one when no user is seeded, so 401 is exercised for real.
 */

const TEST_KEY = 'test-master-key-0123456789abcdef';
const LEGACY_KEY = 'timemark-default-master-key-change-in-production-2026';

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
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
      if (authState.user) {
        c.set('user', authState.user);
        return next();
      }
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(
        c,
        next,
      );
    },
  };
});

import documentsRoutes from '../routes/documents.js';

const USER = { id: 7, username: 'alice' };
const OTHER_USER = { id: 99, username: 'bob' };
const PLAINTEXT_NUMBER = 'E12345678';
const CIPHERTEXT = encrypt(PLAINTEXT_NUMBER, TEST_KEY);

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];

type Responder = (
  sql: string,
  params: unknown[],
) => { rows: unknown[]; rowCount?: number | null } | undefined;

function documentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    user_id: USER.id,
    profile_id: null,
    kind: 'passport',
    title: '护照',
    issuer: '中国出入境管理局',
    document_number_encrypted: CIPHERTEXT,
    issued_at: '2020-01-01',
    expires_at: '2030-01-01',
    country: 'CN',
    notes: null,
    reminder_config: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function attachmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5,
    user_id: USER.id,
    owner_type: null,
    owner_id: null,
    filename: '扫描件.pdf',
    content_type: 'application/pdf',
    byte_size: 128,
    sha256: 'a'.repeat(64),
    storage_key: 'attachments/7/uuid.pdf',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** User-scoped responder: a row for another user's session is invisible (404). */
function defaultResponder(sql: string, params: unknown[]): ReturnType<Responder> {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s.startsWith('SELECT * FROM documents WHERE id = $1')) {
    // params: [id, userId]. A missing user_id predicate (params.length === 1) still
    // answers the row, so removing the owner check is observable as a 200 vs 404.
    const ownerOk = params.length === 1 || params[1] === USER.id;
    return ownerOk ? { rows: [documentRow()], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (s.startsWith('SELECT COUNT(*)::int AS count FROM documents')) {
    return { rows: [{ count: 1 }], rowCount: 1 };
  }
  if (s.startsWith('SELECT * FROM documents WHERE')) {
    // list/expiring queries: params[0] is always the user id.
    return params[0] === USER.id ? { rows: [documentRow()], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (s.startsWith('INSERT INTO documents')) {
    return { rows: [documentRow({ document_number_encrypted: params[5] })], rowCount: 1 };
  }
  if (s.startsWith('UPDATE documents SET') && s.includes('RETURNING *')) {
    if (params[1] !== USER.id) return { rows: [], rowCount: 0 };
    // Echo the LAST set parameter as the stored number so PATCH tests can observe it.
    const numberParam = params.length > 2 ? params[params.length - 1] : null;
    return { rows: [documentRow({ document_number_encrypted: numberParam })], rowCount: 1 };
  }
  if (s.startsWith('UPDATE documents SET document_number_encrypted')) {
    return { rows: [], rowCount: 1 };
  }
  if (s.startsWith('DELETE FROM documents')) {
    return params[1] === USER.id ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (s.startsWith('SELECT * FROM attachments WHERE id = $1')) {
    const ownerOk = params.length === 1 || params[1] === USER.id;
    return ownerOk ? { rows: [attachmentRow()], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (s.startsWith('UPDATE attachments')) {
    return {
      rows: [attachmentRow({ owner_type: params[2], owner_id: params[3] })],
      rowCount: 1,
    };
  }
  return { rows: [], rowCount: 0 };
}

function installDb(responder: Responder = defaultResponder): void {
  captured = [];
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    return responder(sql, params) ?? { rows: [], rowCount: 0 };
  });
}

function queriesMatching(pattern: RegExp): Captured[] {
  return captured.filter((q) => pattern.test(q.sql.replace(/\s+/g, ' ')));
}

async function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await documentsRoutes.request(path, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.MASTER_KEY = process.env.MASTER_KEY;
  process.env.MASTER_KEY = TEST_KEY;
  authState.user = { ...USER };
  installDb();
});

afterEach(() => {
  if (savedEnv.MASTER_KEY === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = savedEnv.MASTER_KEY;
});

describe('auth guard', () => {
  it('returns 401 for every documents verb without a token', async () => {
    authState.user = null;
    const cases: Array<[string, string]> = [
      ['GET', '/'],
      ['GET', '/expiring'],
      ['POST', '/'],
      ['GET', '/1'],
      ['GET', '/1/number'],
      ['PATCH', '/1'],
      ['DELETE', '/1'],
      ['POST', '/1/attachments'],
      ['DELETE', '/1/attachments/5'],
    ];
    for (const [method, path] of cases) {
      const { status, body } = await request(method, path);
      expect(status, `${method} ${path}`).toBe(401);
      expect(body.error).toBe('Unauthorized');
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('document_number encryption at rest and redaction', () => {
  it('stores the number as ciphertext (not plaintext) and returns numberConfigured only', async () => {
    const { status, body } = await request('POST', '/', {
      kind: 'passport',
      title: '护照',
      documentNumber: PLAINTEXT_NUMBER,
    });

    expect(status).toBe(201);
    const insert = queriesMatching(/INSERT INTO documents/).at(-1);
    expect(insert).toBeDefined();
    const storedNumber = insert!.params[5];
    expect(typeof storedNumber).toBe('string');
    expect(storedNumber).not.toBe(PLAINTEXT_NUMBER);
    // Ciphertext at rest is decryptable with the current MASTER_KEY.
    expect(decrypt(String(storedNumber), TEST_KEY)).toBe(PLAINTEXT_NUMBER);

    const data = body.data as Record<string, unknown>;
    expect(data.numberConfigured).toBe(true);
    expect(data).not.toHaveProperty('document_number');
    expect(data).not.toHaveProperty('document_number_encrypted');
    // Neither the plaintext nor the ciphertext leaks into the response.
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_NUMBER);
    expect(JSON.stringify(body)).not.toContain(String(storedNumber));
  });

  it('never returns the number (or its ciphertext) from list or detail responses', async () => {
    const list = await request('GET', '/');
    expect(list.status).toBe(200);
    const items = list.body.data as Array<Record<string, unknown>>;
    expect(items[0].numberConfigured).toBe(true);
    expect(items[0]).not.toHaveProperty('document_number_encrypted');
    expect(JSON.stringify(list.body)).not.toContain(CIPHERTEXT);
    expect(JSON.stringify(list.body)).not.toContain(PLAINTEXT_NUMBER);

    const detail = await request('GET', '/1');
    expect(detail.status).toBe(200);
    expect((detail.body.data as Record<string, unknown>).numberConfigured).toBe(true);
    expect(JSON.stringify(detail.body)).not.toContain(CIPHERTEXT);
  });

  it('reveals the plaintext exactly once via GET /:id/number', async () => {
    const { status, body } = await request('GET', '/1/number');
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, data: { number: PLAINTEXT_NUMBER } });
  });

  it('returns 404 (not configured) when the document has no number', async () => {
    installDb((sql, params) =>
      sql.startsWith('SELECT * FROM documents WHERE id = $1')
        ? { rows: [documentRow({ document_number_encrypted: null })], rowCount: 1 }
        : defaultResponder(sql, params),
    );
    const { status } = await request('GET', '/1/number');
    expect(status).toBe(404);
  });

  it('clears the number without exposing it (PATCH null) and leaves it untouched when omitted', async () => {
    const cleared = await request('PATCH', '/1', { documentNumber: null, title: '护照（新）' });
    expect(cleared.status).toBe(200);
    expect((cleared.body.data as Record<string, unknown>).numberConfigured).toBe(false);
    const update = queriesMatching(/UPDATE documents SET/).at(-1);
    expect(update?.sql).toContain('document_number_encrypted = $');
    expect(update?.params).toContain(null);
    expect(JSON.stringify(cleared.body)).not.toContain(PLAINTEXT_NUMBER);

    const titleOnly = await request('PATCH', '/1', { title: '仅改标题' });
    expect(titleOnly.status).toBe(200);
    const titleUpdate = queriesMatching(/UPDATE documents SET/).at(-1);
    // The number column is not part of a patch that does not mention it.
    expect(titleUpdate?.sql).not.toContain('document_number_encrypted');
  });

  it('re-encrypts a replaced number and never echoes it', async () => {
    const { status, body } = await request('PATCH', '/1', { documentNumber: 'NEW-42' });
    expect(status).toBe(200);
    const update = queriesMatching(/UPDATE documents SET/).at(-1);
    const cipherParam = update!.params.find(
      (p, i) => i >= 2 && typeof p === 'string' && p !== 'NEW-42' && p.length > 40,
    );
    expect(cipherParam).toBeDefined();
    expect(decrypt(String(cipherParam), TEST_KEY)).toBe('NEW-42');
    expect(JSON.stringify(body)).not.toContain('NEW-42');
  });
});

describe('wrong MASTER_KEY fails closed', () => {
  it('reveal returns 422 with no ciphertext and the list endpoint keeps working', async () => {
    process.env.MASTER_KEY = 'wrong-key-000000000000000000000000';

    const list = await request('GET', '/');
    expect(list.status).toBe(200);
    const items = list.body.data as Array<Record<string, unknown>>;
    expect(items[0].numberConfigured).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain(CIPHERTEXT);
    expect(JSON.stringify(list.body)).not.toContain(PLAINTEXT_NUMBER);

    const reveal = await request('GET', '/1/number');
    expect(reveal.status).toBe(422);
    expect(JSON.stringify(reveal.body)).not.toContain(CIPHERTEXT);
    expect(JSON.stringify(reveal.body)).not.toContain(PLAINTEXT_NUMBER);
    expect(String(reveal.body.error)).toContain('MASTER_KEY');
  });

  it('also fails closed when MASTER_KEY is not set at all', async () => {
    delete process.env.MASTER_KEY;
    const list = await request('GET', '/');
    expect(list.status).toBe(200);
    const reveal = await request('GET', '/1/number');
    expect(reveal.status).toBe(422);
    expect(JSON.stringify(reveal.body)).not.toContain(CIPHERTEXT);
  });

  it('decrypts legacy-key values and re-encrypts them with the current key', async () => {
    const legacyCiphertext = encrypt(PLAINTEXT_NUMBER, LEGACY_KEY);
    installDb((sql, params) =>
      sql.startsWith('SELECT * FROM documents WHERE id = $1')
        ? { rows: [documentRow({ document_number_encrypted: legacyCiphertext })], rowCount: 1 }
        : defaultResponder(sql, params),
    );

    const reveal = await request('GET', '/1/number');
    expect(reveal.status).toBe(200);
    expect(reveal.body.data).toEqual({ number: PLAINTEXT_NUMBER });

    const reEncrypt = queriesMatching(/UPDATE documents SET document_number_encrypted/).at(-1);
    expect(reEncrypt).toBeDefined();
    expect(reEncrypt!.params[0]).toBe(1);
    expect(reEncrypt!.params[1]).toBe(USER.id);
    expect(decrypt(String(reEncrypt!.params[2]), TEST_KEY)).toBe(PLAINTEXT_NUMBER);
  });
});

describe('CRUD and scoping', () => {
  it('creates without a number and reports numberConfigured=false', async () => {
    const { status, body } = await request('POST', '/', { kind: 'id_card', title: '身份证' });
    expect(status).toBe(201);
    const insert = queriesMatching(/INSERT INTO documents/).at(-1);
    expect(insert!.params[5]).toBeNull();
    expect((body.data as Record<string, unknown>).numberConfigured).toBe(false);
  });

  it('rejects an invalid create payload with 400 and never touches the DB', async () => {
    const cases = [
      { kind: 'nonsense', title: 'X' },
      { kind: 'passport', title: '' },
      { kind: 'visa', title: 'X', issuedAt: '2026-05-01', expiresAt: '2026-04-01' },
    ];
    for (const payload of cases) {
      const { status, body } = await request('POST', '/', payload);
      expect(status, JSON.stringify(payload)).toBe(400);
      expect(body.success).toBe(false);
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('lists with kind/active/q filters scoped by user and paginates', async () => {
    const { status, body } = await request('GET', '/?kind=passport&active=true&q=护照&page=2&limit=10');
    expect(status).toBe(200);
    expect(body.pagination).toEqual({ page: 2, limit: 10, total: 1, totalPages: 1 });

    const list = queriesMatching(/SELECT \* FROM documents WHERE/).at(-1);
    const sql = list!.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('user_id = $1');
    expect(sql).toContain('kind = $2');
    expect(sql).toContain('is_active = $3');
    expect(sql).toContain('ILIKE $4');
    expect(list!.params.slice(0, 4)).toEqual([USER.id, 'passport', true, '%护照%']);
    expect(list!.params.slice(-2)).toEqual([10, 10]);
  });

  it('rejects malformed filters with 400', async () => {
    expect((await request('GET', '/?kind=bank_card')).status).toBe(400);
    expect((await request('GET', '/?active=maybe')).status).toBe(400);
  });

  it('returns expiring documents scoped by user and clamps days', async () => {
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT * FROM documents') && s.includes('INTERVAL')) {
        return { rows: [documentRow({ expires_at: '2026-10-01' })], rowCount: 1 };
      }
      return defaultResponder(sql, params);
    });

    const { status, body } = await request('GET', '/expiring?days=30');
    expect(status).toBe(200);
    expect(body.days).toBe(30);
    const expiring = queriesMatching(/INTERVAL/).at(-1);
    expect(expiring!.params).toEqual([USER.id, 30]);
    expect((body.data as Array<Record<string, unknown>>)[0].numberConfigured).toBe(true);

    const clamped = await request('GET', '/expiring?days=99999');
    expect(clamped.body.days).toBe(3650);
  });

  it('returns 404 (not 403) for another user\'s document on detail/patch/delete/reveal', async () => {
    authState.user = { ...OTHER_USER };
    expect((await request('GET', '/1')).status).toBe(404);
    expect((await request('PATCH', '/1', { title: 'steal' })).status).toBe(404);
    expect((await request('DELETE', '/1')).status).toBe(404);
    expect((await request('GET', '/1/number')).status).toBe(404);
  });

  it('deletes only the owner\'s row and rejects malformed ids', async () => {
    const { status } = await request('DELETE', '/1');
    expect(status).toBe(200);
    const del = queriesMatching(/DELETE FROM documents/).at(-1);
    expect(del?.sql).toBe('DELETE FROM documents WHERE id = $1 AND user_id = $2');
    expect(del?.params).toEqual([1, USER.id]);
    expect((await request('DELETE', '/abc')).status).toBe(400);
    expect((await request('GET', '/abc/number')).status).toBe(400);
  });
});

describe('link / unlink attachments', () => {
  it('links a user-owned attachment to the document (both ends owner-checked)', async () => {
    const { status, body } = await request('POST', '/1/attachments', { attachmentId: 5 });
    expect(status).toBe(200);

    const update = queriesMatching(/UPDATE attachments/).at(-1);
    expect(update?.sql.replace(/\s+/g, ' ')).toContain('owner_type = $3');
    expect(update?.sql.replace(/\s+/g, ' ')).toContain('user_id = $2');
    expect(update?.params).toEqual([5, USER.id, 'document', 1]);

    const data = body.data as Record<string, unknown>;
    expect(data.owner_type).toBe('document');
    expect(data.owner_id).toBe(1);
    expect(data.storage_key).toBeUndefined();
  });

  it('rejects linking a foreign attachment or a foreign document with 404', async () => {
    // Attachment belongs to another user.
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT * FROM attachments WHERE id = $1')) return { rows: [], rowCount: 0 };
      return defaultResponder(sql, params);
    });
    expect((await request('POST', '/1/attachments', { attachmentId: 5 })).status).toBe(404);

    // Document belongs to another user.
    authState.user = { ...OTHER_USER };
    installDb();
    expect((await request('POST', '/1/attachments', { attachmentId: 5 })).status).toBe(404);
    expect(queriesMatching(/UPDATE attachments/)).toHaveLength(0);
  });

  it('rejects a malformed link body with 400', async () => {
    expect((await request('POST', '/1/attachments', { attachmentId: 0 })).status).toBe(400);
    expect((await request('POST', '/1/attachments', {})).status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('unlinks only an attachment actually linked to this document', async () => {
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT * FROM attachments WHERE id = $1')) {
        return { rows: [attachmentRow({ owner_type: 'document', owner_id: 1 })], rowCount: 1 };
      }
      return defaultResponder(sql, params);
    });

    const { status, body } = await request('DELETE', '/1/attachments/5');
    expect(status).toBe(200);
    const update = queriesMatching(/UPDATE attachments/).at(-1);
    expect(update?.params).toEqual([5, USER.id, null, null]);
    expect((body.data as Record<string, unknown>).owner_type).toBeNull();
  });

  it('returns 404 when the attachment is linked to a different document', async () => {
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT * FROM attachments WHERE id = $1')) {
        return { rows: [attachmentRow({ owner_type: 'document', owner_id: 999 })], rowCount: 1 };
      }
      return defaultResponder(sql, params);
    });

    const { status } = await request('DELETE', '/1/attachments/5');
    expect(status).toBe(404);
    expect(queriesMatching(/UPDATE attachments/)).toHaveLength(0);
  });
});

describe('user scoping proof', () => {
  it('every SELECT/UPDATE/DELETE against documents carries a user_id predicate', async () => {
    await request('GET', '/');
    await request('GET', '/expiring');
    await request('POST', '/', { kind: 'passport', title: '护照', documentNumber: 'X1' });
    await request('GET', '/1');
    await request('GET', '/1/number');
    await request('PATCH', '/1', { title: 'Y' });
    await request('POST', '/1/attachments', { attachmentId: 5 });
    await request('DELETE', '/1');

    const scoped = captured.filter((q) => {
      const s = q.sql.replace(/\s+/g, ' ').trim();
      return /^(SELECT|UPDATE|DELETE)/.test(s) && s.includes('documents');
    });
    expect(scoped.length).toBeGreaterThanOrEqual(7);
    for (const q of scoped) {
      expect(q.sql, `unscoped statement: ${q.sql}`).toContain('user_id = $');
      expect(q.params).toContain(USER.id);
    }
  });
});
