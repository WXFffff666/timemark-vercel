import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Todo 53 acceptance: /api/attachments upload / download / delete / list.
 *
 * Covered here:
 * - 401 without auth for every verb; nothing reaches the DB.
 * - 2 MB cap enforced BEFORE any storage call (JSON and multipart), zero-byte rejected.
 * - content-type allowlist (image/svg+xml rejected) + declared/actual sniff mismatch is
 *   REJECTED (fail closed - we do not silently correct the type).
 * - user A cannot read/delete user B's attachment (404); list/detail are user-scoped.
 * - downloads always carry `Content-Disposition: attachment` and `X-Content-Type-Options:
 *   nosniff`; filenames with `../` or markup never reach storage keys.
 * - insert failure rolls the uploaded object back (deleteObject called with the same key).
 * - production storage-unconfigured surfaces as 503, never a disk write.
 *
 * The DB and storage layers are mocked (no reachable Postgres / BLOB token in this
 * environment); the auth middleware delegates to the real one when no user is seeded,
 * so the 401 contract is exercised for real.
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
const { putObjectMock, getObjectMock, deleteObjectMock } = vi.hoisted(() => ({
  putObjectMock: vi.fn(),
  getObjectMock: vi.fn(),
  deleteObjectMock: vi.fn(),
}));

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

vi.mock('../services/storage.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/storage.service.js')>();
  return {
    ...actual,
    putObject: putObjectMock,
    getObject: getObjectMock,
    deleteObject: deleteObjectMock,
  };
});

import attachmentsRoutes from '../routes/attachments.js';
import { StorageNotConfiguredError } from '../services/storage.service.js';

const USER = { id: 7, username: 'alice' };
const OTHER_USER = { id: 99, username: 'bob' };

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8');
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
// MZ header (a Windows .exe renamed to .pdf): binary, no allowlist signature.
const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

/**
 * A well-formed oversized PDF: a real `%PDF-` signature followed by padding, so the
 * ONLY rejection reason in the cap tests is the size cap (not content sniffing).
 */
function bigPdfBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]), 0);
  bytes.fill(0x41, 9);
  return bytes;
}

const STORAGE_KEY = 'attachments/7/9f1c2d3e-0000-4000-8000-000000000001.pdf';
const SHA_PDF = createHash('sha256').update(PDF_BYTES).digest('hex');

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[];

type Responder = (
  sql: string,
  params: unknown[],
) => { rows: unknown[]; rowCount?: number | null } | undefined;

function attachmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    user_id: USER.id,
    owner_type: 'document',
    owner_id: 42,
    filename: '护照.pdf',
    content_type: 'application/pdf',
    byte_size: PDF_BYTES.byteLength,
    sha256: SHA_PDF,
    storage_key: STORAGE_KEY,
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Default responder that behaves like a user-scoped database. `SELECT ... WHERE id = $1`
 * deliberately answers a row even when the `user_id` predicate is missing (params length
 * 1) - that is what lets the "owner check removed" mutation be observable.
 */
function defaultResponder(sql: string, params: unknown[]): ReturnType<Responder> {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith('SELECT 1 FROM documents')) {
    return { rows: params[1] === USER.id ? [{ ok: 1 }] : [], rowCount: 1 };
  }
  if (s.startsWith('INSERT INTO attachments')) {
    // Echo the inserted values like `RETURNING *` would, so the API response reflects input.
    return {
      rows: [
        attachmentRow({
          id: 42,
          user_id: params[0],
          owner_type: params[1],
          owner_id: params[2],
          filename: params[3],
          content_type: params[4],
          byte_size: params[5],
          sha256: params[6],
          storage_key: params[7],
        }),
      ],
      rowCount: 1,
    };
  }
  if (s.startsWith('SELECT COUNT(*)::int AS count FROM attachments')) {
    return { rows: [{ count: 1 }], rowCount: 1 };
  }
  if (s.startsWith('SELECT * FROM attachments WHERE id = $1')) {
    return params[1] === undefined || params[1] === USER.id
      ? { rows: [attachmentRow()], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (s.startsWith('SELECT * FROM attachments WHERE')) {
    return { rows: [attachmentRow()], rowCount: 1 };
  }
  if (s.startsWith('DELETE FROM attachments')) {
    return params[1] === USER.id ? { rows: [attachmentRow()], rowCount: 1 } : { rows: [], rowCount: 0 };
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
  if (body !== undefined && typeof body === 'object' && body !== null && typeof (body as FormData).get === 'function') {
    init.body = body as FormData;
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await attachmentsRoutes.request(path, init);
  const contentType = res.headers.get('content-type') ?? '';
  const parsed = contentType.includes('application/json')
    ? ((await res.json()) as Record<string, unknown>)
    : null;
  return { status: res.status, res, body: parsed };
}

function jsonUpload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerType: 'document',
    ownerId: 42,
    filename: '护照.pdf',
    contentType: 'application/pdf',
    dataBase64: Buffer.from(PDF_BYTES).toString('base64'),
    ...overrides,
  };
}

function multipartUpload(file: File, fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append('file', file);
  form.append('ownerType', 'document');
  form.append('ownerId', '42');
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

beforeEach(() => {
  authState.user = { ...USER };
  installDb();
  putObjectMock.mockReset();
  putObjectMock.mockResolvedValue({ url: 'https://store.example/blob', size: PDF_BYTES.byteLength, sha256: SHA_PDF });
  getObjectMock.mockReset();
  getObjectMock.mockResolvedValue({
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(PDF_BYTES));
        controller.close();
      },
    }),
    size: PDF_BYTES.byteLength,
  });
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);
});

describe('auth guard', () => {
  it('returns 401 for every attachments verb without a token and never touches the DB', async () => {
    authState.user = null;
    const cases: Array<[string, string]> = [
      ['GET', '/'],
      ['POST', '/'],
      ['GET', '/1'],
      ['DELETE', '/1'],
    ];
    for (const [method, path] of cases) {
      const { status, body } = await request(method, path);
      expect(status, `${method} ${path}`).toBe(401);
      expect(body?.error).toBe('Unauthorized');
    }
    expect(dbQuery).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(getObjectMock).not.toHaveBeenCalled();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/attachments - caps, allowlist and sniffing', () => {
  it('stores an allowlisted PDF (JSON base64), returns metadata without storage_key and computes sha256', async () => {
    const { status, body } = await request('POST', '/', jsonUpload());

    expect(status).toBe(201);
    expect(body?.success).toBe(true);
    const data = body?.data as Record<string, unknown>;
    expect(data).toMatchObject({
      id: 42,
      owner_type: 'document',
      owner_id: 42,
      filename: '护照.pdf',
      content_type: 'application/pdf',
      byte_size: PDF_BYTES.byteLength,
      sha256: SHA_PDF,
      download_url: '/api/attachments/42',
    });
    // The storage key / provider URL must never leak to the client.
    expect(JSON.stringify(body)).not.toContain('attachments/7');
    expect(JSON.stringify(body)).not.toContain('storage_key');

    expect(putObjectMock).toHaveBeenCalledTimes(1);
    const [key, bytes, contentType] = putObjectMock.mock.calls[0];
    expect(key).toMatch(/^attachments\/7\/[0-9a-f-]{36}\.pdf$/);
    expect(contentType).toBe('application/pdf');
    expect(Array.from(bytes as Uint8Array)).toEqual(Array.from(PDF_BYTES));

    const insert = queriesMatching(/INSERT INTO attachments/).at(-1);
    expect(insert).toBeDefined();
    expect(insert!.params).toEqual([
      USER.id,
      'document',
      42,
      '护照.pdf',
      'application/pdf',
      PDF_BYTES.byteLength,
      SHA_PDF,
      key,
    ]);
  });

  it('stores an allowlisted PNG sent as multipart (File)', async () => {
    const { status, body } = await request(
      'POST',
      '/',
      multipartUpload(new File([PNG_BYTES], '照片.png', { type: 'image/png' })),
    );
    expect(status).toBe(201);
    const data = body?.data as Record<string, unknown>;
    expect(data.content_type).toBe('image/png');
    expect(putObjectMock).toHaveBeenCalledTimes(1);
    const [key, bytes] = putObjectMock.mock.calls[0];
    expect(key).toMatch(/^attachments\/7\/[0-9a-f-]{36}\.png$/);
    expect(Array.from(bytes as Uint8Array)).toEqual(Array.from(PNG_BYTES));
  });

  it('rejects a 3 MB JSON payload BEFORE any storage or DB call', async () => {
    const big = bigPdfBytes(3 * 1024 * 1024); // valid PDF signature + 3 MB padding
    const { status } = await request(
      'POST',
      '/',
      jsonUpload({ dataBase64: Buffer.from(big).toString('base64') }),
    );
    expect([413, 400]).toContain(status);
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(queriesMatching(/INSERT INTO attachments/)).toHaveLength(0);
  });

  it('rejects a 3 MB multipart payload BEFORE any storage call', async () => {
    const big = new File([bigPdfBytes(3 * 1024 * 1024)], '大文件.pdf', { type: 'application/pdf' });
    const { status } = await request('POST', '/', multipartUpload(big));
    expect([413, 400]).toContain(status);
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it('accepts a valid PDF just below the 2 MB cap (positive control for the cap)', async () => {
    const nearCap = bigPdfBytes(1_900_000);
    const { status } = await request(
      'POST',
      '/',
      jsonUpload({ dataBase64: Buffer.from(nearCap).toString('base64') }),
    );
    expect(status).toBe(201);
    expect(putObjectMock).toHaveBeenCalledTimes(1);
  });

  it('rejects image/svg+xml (script vector) in JSON and multipart', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const json = await request(
      'POST',
      '/',
      jsonUpload({ filename: 'vector.svg', contentType: 'image/svg+xml', dataBase64: Buffer.from(svg).toString('base64') }),
    );
    expect(json.status).toBe(400);

    const multipart = await request(
      'POST',
      '/',
      multipartUpload(new File([Buffer.from(svg)], 'vector.svg', { type: 'image/svg+xml' })),
    );
    expect(multipart.status).toBe(400);

    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it('REJECTS (does not silently correct) a declared/actual content-type mismatch', async () => {
    // An .exe renamed .pdf: declared application/pdf, bytes are MZ...
    const exe = await request('POST', '/', jsonUpload({ dataBase64: Buffer.from(EXE_BYTES).toString('base64') }));
    expect(exe.status).toBe(400);
    expect(String(exe.body?.error)).toContain('不一致');

    // Declared PNG but the bytes are a JPEG (both allowlisted; still a mismatch).
    const jpegAsPng = await request(
      'POST',
      '/',
      jsonUpload({ filename: 'x.png', contentType: 'image/png', dataBase64: Buffer.from(JPEG_BYTES).toString('base64') }),
    );
    expect(jpegAsPng.status).toBe(400);

    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it('rejects a zero-byte file and malformed base64', async () => {
    const emptyJson = await request('POST', '/', jsonUpload({ dataBase64: '' }));
    expect(emptyJson.status).toBe(400);

    const emptyMultipart = await request(
      'POST',
      '/',
      multipartUpload(new File([], '空.pdf', { type: 'application/pdf' })),
    );
    expect(emptyMultipart.status).toBe(400);

    for (const bad of ['!!!!', 'abc', 'YWJjZA', 'a===', '====']) {
      const res = await request('POST', '/', jsonUpload({ dataBase64: bad }));
      expect(res.status, bad).toBe(400);
    }
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it('validates owner type/id and rejects a foreign owner row with 404 before storage', async () => {
    const badType = await request('POST', '/', jsonUpload({ ownerType: 'users' }));
    expect(badType.status).toBe(400);

    const badId = await request('POST', '/', jsonUpload({ ownerId: -1 }));
    expect(badId.status).toBe(400);

    const missingOwnerType = await request('POST', '/', {
      ownerId: 42,
      filename: 'x.pdf',
      contentType: 'application/pdf',
      dataBase64: Buffer.from(PDF_BYTES).toString('base64'),
    });
    expect(missingOwnerType.status).toBe(400);

    const missingOwnerId = await request('POST', '/', {
      ownerType: 'document',
      filename: 'x.pdf',
      contentType: 'application/pdf',
      dataBase64: Buffer.from(PDF_BYTES).toString('base64'),
    });
    expect(missingOwnerId.status).toBe(400);

    // Multipart with no owner fields is rejected before storage too.
    const form = new FormData();
    form.append('file', new File([PDF_BYTES], 'x.pdf', { type: 'application/pdf' }));
    const missingMultipartOwner = await request('POST', '/', form);
    expect(missingMultipartOwner.status).toBe(400);

    // The owner row exists but belongs to another user: ownerExists() finds nothing.
    authState.user = { ...OTHER_USER };
    const foreign = await request('POST', '/', jsonUpload({ ownerId: 42 }));
    expect(foreign.status).toBe(404);
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it('never lets a hostile filename influence the storage key', async () => {
    const evil = '../../evil<script>.pdf';
    const { status, body } = await request('POST', '/', jsonUpload({ filename: evil }));
    expect(status).toBe(201);
    const [key] = putObjectMock.mock.calls[0];
    expect(key).toMatch(/^attachments\/7\/[0-9a-f-]{36}\.pdf$/);
    expect(key).not.toContain('..');
    expect(key).not.toContain('<');
    // The label is stored verbatim but only used in a sanitized response header.
    expect((body?.data as Record<string, unknown>).filename).toBe(evil);
  });
});

describe('GET /api/attachments/:id - owner scoping and safe download headers', () => {
  it('streams the bytes with Content-Disposition: attachment and nosniff', async () => {
    const { status, res } = await request('GET', '/1');
    expect(status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-disposition')).toContain('filename="');
    // CJK filename is RFC 5987 encoded, never raw.
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(res.headers.get('content-length')).toBe(String(PDF_BYTES.byteLength));

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(PDF_BYTES));
    expect(getObjectMock).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('sanitizes a hostile filename in the download header (no CR/LF, no raw markup)', async () => {
    installDb((sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT * FROM attachments WHERE id = $1') && params[1] === USER.id) {
        return { rows: [attachmentRow({ filename: 'evil"><script>alert(1)</script>.pdf' })], rowCount: 1 };
      }
      return defaultResponder(sql, params);
    });
    const { status, res } = await request('GET', '/1');
    expect(status).toBe(200);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment; filename="')).toBe(true);
    expect(disposition).not.toContain('<');
    expect(disposition).not.toContain('>');
    expect(disposition).not.toMatch(/[\r\n]/);
  });

  it('returns 404 (not 403) when user B requests user A\'s attachment', async () => {
    authState.user = { ...OTHER_USER };
    const { status, body } = await request('GET', '/1');
    expect(status).toBe(404);
    expect(body?.error).toBe('附件不存在');
    // The storage layer is never reached for a foreign id.
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the row exists but the stored object is gone', async () => {
    getObjectMock.mockResolvedValueOnce(null);
    const { status } = await request('GET', '/1');
    expect(status).toBe(404);
  });
});

describe('DELETE /api/attachments/:id', () => {
  it('deletes the owner\'s row and the stored object', async () => {
    const { status, body } = await request('DELETE', '/1');
    expect(status).toBe(200);
    expect(body?.success).toBe(true);

    const del = queriesMatching(/DELETE FROM attachments/).at(-1);
    expect(del?.sql).toContain('user_id = $2');
    expect(del?.params).toEqual([1, USER.id]);
    expect(deleteObjectMock).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('returns 404 for another user\'s attachment and never deletes the object', async () => {
    authState.user = { ...OTHER_USER };
    const { status } = await request('DELETE', '/1');
    expect(status).toBe(404);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/attachments - list scoping and filters', () => {
  it('lists the user\'s attachments with pagination and maps to the public DTO', async () => {
    const { status, body } = await request('GET', '/?owner_type=document&owner_id=42&page=2&limit=1');
    expect(status).toBe(200);
    expect(body?.pagination).toEqual({ page: 2, limit: 1, total: 1, totalPages: 1 });
    const data = body?.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0].download_url).toBe('/api/attachments/1');
    expect(data[0].storage_key).toBeUndefined();

    const list = queriesMatching(/SELECT \* FROM attachments WHERE/).at(-1);
    const sql = list!.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('user_id = $1');
    expect(sql).toContain('owner_type = $2');
    expect(sql).toContain('owner_id = $3');
    expect(list!.params.slice(0, 3)).toEqual([USER.id, 'document', 42]);
  });

  it('rejects an unknown owner_type and an owner_id without owner_type', async () => {
    expect((await request('GET', '/?owner_type=users')).status).toBe(400);
    expect((await request('GET', '/?owner_id=42')).status).toBe(400);
    expect((await request('GET', '/?owner_id=-3&owner_type=document')).status).toBe(400);
  });
});

describe('rollback and storage-unavailable behaviour', () => {
  it('calls deleteObject with the same key when the metadata insert fails', async () => {
    installDb((sql, params) => {
      if (sql.includes('INSERT INTO attachments')) throw new Error('db down (injected)');
      return defaultResponder(sql, params);
    });

    const { status } = await request('POST', '/', jsonUpload());
    expect(status).toBe(500);
    expect(putObjectMock).toHaveBeenCalledTimes(1);
    const [uploadedKey] = putObjectMock.mock.calls[0];
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(uploadedKey);
  });

  it('returns 503 (not a disk write) when storage is unconfigured in production', async () => {
    putObjectMock.mockRejectedValueOnce(new StorageNotConfiguredError());
    const upload = await request('POST', '/', jsonUpload());
    expect(upload.status).toBe(503);
    expect(String(upload.body?.error)).toContain('BLOB_READ_WRITE_TOKEN');

    getObjectMock.mockRejectedValueOnce(new StorageNotConfiguredError());
    const download = await request('GET', '/1');
    expect(download.status).toBe(503);
  });
});

describe('user scoping proof', () => {
  it('every SELECT/DELETE against attachments carries a user_id predicate', async () => {
    await request('GET', '/');
    await request('POST', '/', jsonUpload());
    await request('GET', '/1');
    await request('DELETE', '/1');

    const scoped = captured.filter((q) => {
      const s = q.sql.replace(/\s+/g, ' ').trim();
      return /^(SELECT|DELETE)/.test(s) && s.includes('attachments') && !s.startsWith('SELECT 1');
    });
    expect(scoped.length).toBeGreaterThanOrEqual(4);
    for (const q of scoped) {
      expect(q.sql, `unscoped statement: ${q.sql}`).toContain('user_id = $');
      expect(q.params).toContain(USER.id);
    }
  });
});

describe('static proof: no byte columns in the attachments DDL', () => {
  it('keeps bytes out of Postgres (metadata-only migration)', () => {
    const migrate = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
    const block = migrate.slice(migrate.indexOf('CREATE TABLE IF NOT EXISTS attachments'));
    const ddl = block.slice(0, block.indexOf('CREATE INDEX'));
    expect(ddl).not.toMatch(/\bBYTEA\b/i);
    expect(ddl).not.toMatch(/\bBLOB\b/i);
    for (const column of ['filename', 'content_type', 'byte_size', 'sha256', 'storage_key']) {
      expect(ddl).toContain(column);
    }
  });
});
