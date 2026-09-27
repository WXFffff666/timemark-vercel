import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * Todo 57 acceptance: attachment access hardening.
 *
 * - signed download URLs are SHORT-LIVED (hard cap 300 s / 5 min) and minted only
 *   after an owner check; they point at the API (never at the blob store)
 * - an EXPIRED signature is rejected (403); a tampered one too
 * - a VALID signature consumed with a DIFFERENT user's session is 404 (the signature
 *   is not authorization; the owner check always runs server-side)
 * - signatures / signed URLs never reach a log sink (route does not log them and the
 *   pino redact list covers signature/signedUrl)
 * - no unauthenticated listing (all verbs 401)
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
const { getObjectMock, deleteObjectMock } = vi.hoisted(() => ({
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
  return { ...actual, getObject: getObjectMock, deleteObject: deleteObjectMock };
});

import attachmentsRoutes from '../routes/attachments.js';
import { createLoggerInstance } from '../utils/logger.js';
import {
  ATTACHMENT_SIGNED_URL_TTL_SECONDS,
  buildAttachmentDownloadPath,
  signAttachmentDownload,
} from '../utils/attachment-signing.js';

const USER = { id: 7, username: 'alice' };
const OTHER_USER = { id: 99, username: 'bob' };
const PDF_BYTES = Buffer.from('%PDF-1.4\nsignature test bytes\n%%EOF\n', 'utf8');
const STORAGE_KEY = 'attachments/7/9f1c2d3e-0000-4000-8000-000000000001.pdf';

function attachmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    user_id: USER.id,
    owner_type: 'document',
    owner_id: 42,
    filename: '护照.pdf',
    content_type: 'application/pdf',
    byte_size: PDF_BYTES.byteLength,
    sha256: createHash('sha256').update(PDF_BYTES).digest('hex'),
    storage_key: STORAGE_KEY,
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function installDb(): void {
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM attachments WHERE id = $1')) {
      // Behaves like a user-scoped query: a missing user predicate (params length 1)
      // still matches, which is what makes a removed owner check observable.
      return params[1] === undefined || params[1] === USER.id
        ? { rows: [attachmentRow()], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function request(method: string, path: string) {
  const res = await attachmentsRoutes.request(path, { method });
  const contentType = res.headers.get('content-type') ?? '';
  const parsed = contentType.includes('application/json')
    ? ((await res.json()) as Record<string, unknown>)
    : null;
  return { status: res.status, res, body: parsed };
}

/** The router is exercised directly (mounted at /api/attachments in index.ts). */
function routerPath(fullPath: string): string {
  expect(fullPath.startsWith('/api/attachments')).toBe(true);
  return fullPath.slice('/api/attachments'.length);
}

beforeEach(() => {
  process.env.JWT_SECRET = 'test-jwt-secret-for-attachment-signing';
  delete process.env.ATTACHMENT_URL_SECRET;
  authState.user = { ...USER };
  installDb();
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

describe('auth guard / public listing', () => {
  it('returns 401 for listing, signed-url and download without a session', async () => {
    authState.user = null;
    const now = Date.now();
    const url = buildAttachmentDownloadPath(1, now + 60_000, 'whatever');
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/1'],
      ['GET', '/1/signed-url'],
      ['GET', routerPath(url)],
    ] as Array<[string, string]>) {
      const { status, body } = await request(method, path);
      expect(status, `${method} ${path}`).toBe(401);
      expect(body?.error).toBe('Unauthorized');
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('GET /:id/signed-url', () => {
  it('pins the 5-minute hard cap as a literal (mutation guard)', () => {
    expect(ATTACHMENT_SIGNED_URL_TTL_SECONDS).toBe(300);
  });

  it('mints an API-relative URL with a TTL at or below 300 seconds', async () => {
    const { status, body } = await request('GET', '/1/signed-url');
    expect(status).toBe(200);
    const data = body?.data as Record<string, unknown>;
    expect(data.ttlSeconds).toBe(300);
    const expiresAt = new Date(String(data.expiresAt)).getTime();
    // Hard cap of 5 minutes, measured after the response (1 s tolerance for the
    // round-trip; a 600 s TTL would still fail this by ~299 s).
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(300 * 1000 + 1_000);
    expect(expiresAt - Date.now()).toBeGreaterThan(300 * 1000 - 5_000);

    const url = String(data.url);
    expect(url.startsWith('/api/attachments/1/download?expires=')).toBe(true);
    expect(url).toContain('signature=');
    // Never the blob-store URL / storage key.
    expect(url).not.toContain('https://');
    expect(url).not.toContain(STORAGE_KEY);
  });

  it('clamps an oversized ttl request down to 300 seconds', async () => {
    const { status, body } = await request('GET', '/1/signed-url?ttl=99999');
    expect(status).toBe(200);
    expect((body?.data as Record<string, unknown>).ttlSeconds).toBe(300);
  });

  it('404s for an attachment the session does not own', async () => {
    authState.user = { ...OTHER_USER };
    const { status, body } = await request('GET', '/1/signed-url');
    expect(status).toBe(404);
    expect(body?.error).toBe('附件不存在');
  });
});

describe('GET /:id/download - signature + owner check', () => {
  it('serves bytes for a valid, unexpired signature owned by the session', async () => {
    const expires = Date.now() + 60_000;
    const signature = signAttachmentDownload(1, expires);
    const { status, res } = await request('GET', routerPath(buildAttachmentDownloadPath(1, expires, signature)));

    expect(status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString('utf8')).toBe(PDF_BYTES.toString('utf8'));
  });

  it('REJECTS an expired signature even though it was once valid', async () => {
    const expiredAt = Date.now() - 1_000;
    const signature = signAttachmentDownload(1, expiredAt); // valid HMAC, past expiry
    const { status, body } = await request('GET', routerPath(buildAttachmentDownloadPath(1, expiredAt, signature)));

    expect(status).toBe(403);
    expect(body?.error).toBe('下载签名已过期');
    expect(getObjectMock).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled(); // never even reaches the owner query
  });

  it('REJECTS a tampered signature', async () => {
    const expires = Date.now() + 60_000;
    const valid = signAttachmentDownload(1, expires);
    const tampered = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A');
    const { status, body } = await request('GET', routerPath(buildAttachmentDownloadPath(1, expires, tampered)));

    expect(status).toBe(403);
    expect(body?.error).toBe('下载签名无效');
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  it('returns 404 for a VALID signature presented with a DIFFERENT session', async () => {
    const expires = Date.now() + 60_000;
    const signature = signAttachmentDownload(1, expires); // minted for attachment 1 while alice was signed in

    authState.user = { ...OTHER_USER };
    const { status, body } = await request('GET', routerPath(buildAttachmentDownloadPath(1, expires, signature)));

    expect(status).toBe(404);
    expect(body?.error).toBe('附件不存在');
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  it('rejects missing / malformed signature parameters with 400', async () => {
    const cases = ['/1/download', '/1/download?expires=abc&signature=x', '/1/download?expires=123'];
    for (const path of cases) {
      const { status } = await request('GET', path);
      expect(status, path).toBe(400);
    }
  });
});

describe('signed URLs are never logged', () => {
  it('redacts signature / signedUrl fields in the real pino configuration', () => {
    const chunks: string[] = [];
    const logger = createLoggerInstance({ write: (msg: string) => chunks.push(msg) });
    const secretSignature = 'SUPER-SECRET-SIGNATURE-VALUE-1234567890';
    logger.info(
      { signature: secretSignature, signedUrl: `/api/attachments/1/download?signature=${secretSignature}`, signed_url: secretSignature },
      'test redaction',
    );

    const output = chunks.join('');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(secretSignature);
    expect(output).not.toContain('SUPER-SECRET');
  });
});
