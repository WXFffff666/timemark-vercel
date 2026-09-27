import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Todo 52 acceptance: provider-agnostic object storage.
 *
 * - Blob mode (token present) is exercised against a MOCKED @vercel/blob client:
 *   putObject returns { url, size, sha256 }, getSignedUrl clamps the TTL,
 *   deleteObject tolerates BlobNotFoundError (idempotent delete).
 * - Local fallback (no token, non-production) writes under ATTACHMENT_LOCAL_DIR and
 *   round-trips bytes; traversal-shaped keys are rejected.
 * - A production runtime with NO token REFUSES every operation
 *   (StorageNotConfiguredError) instead of silently writing to disk.
 * - Startup status is loud: warn for the local fallback, error for production-unconfigured.
 */

const {
  putMock,
  delMock,
  getMock,
  issueSignedTokenMock,
  presignUrlMock,
  BlobNotFoundErrorMock,
} = vi.hoisted(() => {
  class BlobNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BlobNotFoundError';
    }
  }
  return {
    putMock: vi.fn(),
    delMock: vi.fn(),
    getMock: vi.fn(),
    issueSignedTokenMock: vi.fn(),
    presignUrlMock: vi.fn(),
    BlobNotFoundErrorMock: BlobNotFoundError,
  };
});

const { warnMock, errorMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('@vercel/blob', () => ({
  put: putMock,
  del: delMock,
  get: getMock,
  issueSignedToken: issueSignedTokenMock,
  presignUrl: presignUrlMock,
  BlobNotFoundError: BlobNotFoundErrorMock,
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ warn: warnMock, error: errorMock, info: vi.fn(), debug: vi.fn() }),
}));

import {
  deleteObject,
  getObject,
  getSignedUrl,
  logStorageStartupStatus,
  putObject,
  resolveStorageMode,
  StorageKeyError,
  StorageNotConfiguredError,
  SIGNED_URL_MAX_TTL_SECONDS,
} from '../services/storage.service.js';

const ENV_KEYS = [
  'BLOB_READ_WRITE_TOKEN',
  'NODE_ENV',
  'VERCEL',
  'ATTACHMENT_LOCAL_DIR',
] as const;

const savedEnv: Record<string, string | undefined> = {};
let tempDir: string;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  putMock.mockReset();
  delMock.mockReset();
  getMock.mockReset();
  issueSignedTokenMock.mockReset();
  presignUrlMock.mockReset();
  warnMock.mockReset();
  errorMock.mockReset();

  tempDir = mkdtempSync(join(tmpdir(), 'timemark-storage-'));
  process.env.ATTACHMENT_LOCAL_DIR = tempDir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  process.env.NODE_ENV = 'test';
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(tempDir, { recursive: true, force: true });
});

const KEY = 'attachments/7/9f1c2d3e-0000-4000-8000-000000000001.pdf';

describe('blob mode (mocked @vercel/blob client)', () => {
  beforeEach(() => {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_token';
  });

  it('putObject uploads through the SDK and returns url/size/sha256', async () => {
    putMock.mockResolvedValue({
      url: `https://store.private.blob.vercel-storage.com/${KEY}`,
      downloadUrl: `https://store.private.blob.vercel-storage.com/${KEY}?download=1`,
      pathname: KEY,
      contentType: 'application/pdf',
      contentDisposition: 'inline',
      etag: 'etag-1',
    });

    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01, 0x02, 0x03]);
    const result = await putObject(KEY, bytes, 'application/pdf');

    expect(result).toEqual({
      url: `https://store.private.blob.vercel-storage.com/${KEY}`,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(putMock).toHaveBeenCalledTimes(1);
    const [key, body, options] = putMock.mock.calls[0];
    expect(key).toBe(KEY);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(Array.from(body as Buffer)).toEqual(Array.from(bytes));
    expect(options).toMatchObject({
      access: 'private',
      contentType: 'application/pdf',
      addRandomSuffix: false,
      allowOverwrite: false,
    });
  });

  it('getSignedUrl mints a presigned URL and clamps the TTL to 300 seconds', async () => {
    issueSignedTokenMock.mockResolvedValue({
      delegationToken: 'delegation',
      clientSigningToken: 'signing',
      validUntil: Date.now() + SIGNED_URL_MAX_TTL_SECONDS * 1000,
    });
    presignUrlMock.mockResolvedValue({ presignedUrl: 'https://signed.example/blob?token=x' });

    const before = Date.now();
    const url = await getSignedUrl(KEY, 99999);

    expect(url).toBe('https://signed.example/blob?token=x');
    const issueOptions = issueSignedTokenMock.mock.calls[0][0];
    expect(issueOptions).toMatchObject({ pathname: KEY, operations: ['get'] });
    expect(issueOptions.validUntil).toBeLessThanOrEqual(
      before + SIGNED_URL_MAX_TTL_SECONDS * 1000 + 1000,
    );
    const presignOptions = presignUrlMock.mock.calls[0][1];
    expect(presignOptions).toMatchObject({ operation: 'get', pathname: KEY, access: 'private' });
    expect(presignOptions.validUntil).toBeLessThanOrEqual(
      before + SIGNED_URL_MAX_TTL_SECONDS * 1000 + 1000,
    );
  });

  it('deleteObject deletes via the SDK and treats a missing blob as already deleted', async () => {
    delMock.mockResolvedValue(undefined);
    await deleteObject(KEY);
    expect(delMock).toHaveBeenCalledWith(KEY);

    delMock.mockRejectedValueOnce(new BlobNotFoundErrorMock('gone'));
    await expect(deleteObject(KEY)).resolves.toBeUndefined();
  });

  it('getObject returns a stream and size, or null when the blob is missing', async () => {
    const payload = new TextEncoder().encode('pdf-bytes');
    getMock.mockResolvedValueOnce({
      statusCode: 200,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      }),
      headers: new Headers(),
      blob: { size: payload.byteLength, contentType: 'application/pdf' },
    });

    const stored = await getObject(KEY);
    expect(stored).not.toBeNull();
    expect(stored!.size).toBe(payload.byteLength);
    const roundTrip = new Uint8Array(await new Response(stored!.stream).arrayBuffer());
    expect(Array.from(roundTrip)).toEqual(Array.from(payload));

    getMock.mockResolvedValueOnce(null);
    expect(await getObject(KEY)).toBeNull();
  });
});

describe('local fallback (no token, non-production)', () => {
  it('resolves local mode and round-trips bytes on disk without any network call', async () => {
    expect(resolveStorageMode()).toBe('local');

    const bytes = new TextEncoder().encode('hello 证件保险箱');
    const result = await putObject('attachments/7/doc.txt', bytes, 'text/plain');

    expect(result.size).toBe(bytes.byteLength);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.url).toBe('local://attachments/7/doc.txt');
    expect(putMock).not.toHaveBeenCalled();

    const onDisk = join(tempDir, 'attachments', '7', 'doc.txt');
    expect(existsSync(onDisk)).toBe(true);

    const stored = await getObject('attachments/7/doc.txt');
    expect(stored).not.toBeNull();
    expect(stored!.size).toBe(bytes.byteLength);
    const roundTrip = new Uint8Array(await new Response(stored!.stream).arrayBuffer());
    expect(Array.from(roundTrip)).toEqual(Array.from(bytes));

    await deleteObject('attachments/7/doc.txt');
    expect(existsSync(onDisk)).toBe(false);
    expect(await getObject('attachments/7/doc.txt')).toBeNull();
  });

  it('getSignedUrl returns null in local mode (the route streams instead)', async () => {
    expect(await getSignedUrl('attachments/7/doc.txt', 60)).toBeNull();
    expect(issueSignedTokenMock).not.toHaveBeenCalled();
    expect(presignUrlMock).not.toHaveBeenCalled();
  });

  it('rejects traversal-shaped keys before touching the filesystem', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    for (const evil of [
      '../evil.txt',
      'attachments/7/../../evil.txt',
      'attachments//evil.txt',
      'attachments/./evil.txt',
      '\\evil.txt',
      '/evil.txt',
      'attachments\\7\\evil.txt',
      'C:/evil.txt',
    ]) {
      await expect(putObject(evil, bytes, 'text/plain'), evil).rejects.toBeInstanceOf(StorageKeyError);
      await expect(getObject(evil), evil).rejects.toBeInstanceOf(StorageKeyError);
      await expect(deleteObject(evil), evil).rejects.toBeInstanceOf(StorageKeyError);
    }
    expect(readdirSync(tempDir)).toHaveLength(0);
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('production without a token refuses instead of writing to disk', () => {
  it('resolves unconfigured and refuses every operation with StorageNotConfiguredError', async () => {
    process.env.NODE_ENV = 'production';
    expect(resolveStorageMode()).toBe('unconfigured');

    const bytes = new Uint8Array([1, 2, 3]);
    await expect(putObject(KEY, bytes, 'application/pdf')).rejects.toBeInstanceOf(
      StorageNotConfiguredError,
    );
    await expect(getObject(KEY)).rejects.toBeInstanceOf(StorageNotConfiguredError);
    await expect(getSignedUrl(KEY, 60)).rejects.toBeInstanceOf(StorageNotConfiguredError);
    await expect(deleteObject(KEY)).rejects.toBeInstanceOf(StorageNotConfiguredError);

    expect(putMock).not.toHaveBeenCalled();
    // Nothing was silently written to disk.
    expect(readdirSync(tempDir)).toHaveLength(0);
  });

  it('treats VERCEL as production even when NODE_ENV is not production', async () => {
    process.env.NODE_ENV = 'test';
    process.env.VERCEL = '1';
    expect(resolveStorageMode()).toBe('unconfigured');
    await expect(putObject(KEY, new Uint8Array([1]), 'application/pdf')).rejects.toBeInstanceOf(
      StorageNotConfiguredError,
    );
    expect(readdirSync(tempDir)).toHaveLength(0);
  });
});

describe('startup status logging', () => {
  it('warns loudly for the dev-only local fallback', () => {
    logStorageStartupStatus();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(errorMock).not.toHaveBeenCalled();
    const [context, message] = warnMock.mock.calls[0];
    expect(context.event).toBe('storage.local_fallback');
    expect(context.dir).toBe(tempDir);
    expect(String(message)).toContain('BLOB_READ_WRITE_TOKEN');
  });

  it('logs an error (not just a warning) when production has no token', () => {
    process.env.NODE_ENV = 'production';
    logStorageStartupStatus();
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalled();
    expect(errorMock.mock.calls[0][0].event).toBe('storage.unconfigured');
  });

  it('stays silent when a token is configured', () => {
    process.env.NODE_ENV = 'production';
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_token';
    expect(resolveStorageMode()).toBe('blob');
    logStorageStartupStatus();
    expect(warnMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });
});
