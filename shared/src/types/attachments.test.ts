import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_BASE64_MAX_CHARS,
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_OWNER_TYPES,
  attachmentFilenameSchema,
  createAttachmentSchema,
} from './attachments.js';

/**
 * Todo 52 acceptance: the shared attachment contract.
 *
 * The allowlist is the single source of truth for the client (page 56) and the server
 * (route 53): `image/svg+xml` must never be accepted because SVG can carry scripts.
 * The 2 MB cap is exported so client-side pre-checks and server-side enforcement agree.
 */
describe('attachment contract', () => {
  it('allowlists exactly the five safe content types and rejects SVG', () => {
    expect([...ATTACHMENT_CONTENT_TYPES]).toEqual([
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'text/plain',
    ]);
    expect((ATTACHMENT_CONTENT_TYPES as readonly string[]).includes('image/svg+xml')).toBe(false);
    expect((ATTACHMENT_CONTENT_TYPES as readonly string[]).includes('text/html')).toBe(false);
    expect((ATTACHMENT_CONTENT_TYPES as readonly string[]).includes('application/x-msdownload')).toBe(false);
  });

  it('caps files at 2 MB and exposes a base64 char bound consistent with it', () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(2 * 1024 * 1024);
    // 4/3 base64 expansion plus a small scalar allowance.
    expect(ATTACHMENT_BASE64_MAX_CHARS).toBeGreaterThanOrEqual(Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4);
    expect(ATTACHMENT_BASE64_MAX_CHARS).toBeLessThan(Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 64);
  });

  it('accepts a well-formed base64 upload for every allowlisted type', () => {
    for (const contentType of ATTACHMENT_CONTENT_TYPES) {
      const parsed = createAttachmentSchema.safeParse({
        ownerType: 'document',
        ownerId: 7,
        filename: '证件.pdf',
        contentType,
        dataBase64: Buffer.from('hello').toString('base64'),
      });
      expect(parsed.success, contentType).toBe(true);
    }
  });

  it('rejects svg, unknown owner types, malformed base64 bounds and zero-byte payloads', () => {
    const base = {
      ownerType: 'document',
      ownerId: 7,
      filename: 'x.pdf',
      contentType: 'application/pdf',
      dataBase64: 'aGVsbG8=',
    };
    expect(createAttachmentSchema.safeParse({ ...base, contentType: 'image/svg+xml' }).success).toBe(false);
    expect(createAttachmentSchema.safeParse({ ...base, ownerType: 'users' }).success).toBe(false);
    expect(createAttachmentSchema.safeParse({ ...base, ownerId: 0 }).success).toBe(false);
    expect(createAttachmentSchema.safeParse({ ...base, ownerId: -3 }).success).toBe(false);
    expect(createAttachmentSchema.safeParse({ ...base, filename: '' }).success).toBe(false);
    expect(createAttachmentSchema.safeParse({ ...base, dataBase64: '' }).success).toBe(false);
    expect(
      createAttachmentSchema.safeParse({ ...base, dataBase64: 'A'.repeat(ATTACHMENT_BASE64_MAX_CHARS + 1) }).success,
    ).toBe(false);
  });

  it('rejects filenames with control characters (response-header injection) but allows unicode labels', () => {
    expect(attachmentFilenameSchema.safeParse('报告 2026.pdf').success).toBe(true);
    expect(attachmentFilenameSchema.safeParse('../evil.pdf').success).toBe(true); // label only, never a key
    expect(attachmentFilenameSchema.safeParse('a\r\nX-Evil: 1').success).toBe(false);
    expect(attachmentFilenameSchema.safeParse('a\u0000b').success).toBe(false);
    expect(attachmentFilenameSchema.safeParse('x'.repeat(256)).success).toBe(false);
  });

  it('lists the five polymorphic owner types', () => {
    expect([...ATTACHMENT_OWNER_TYPES]).toEqual([
      'document',
      'expiry',
      'inventory',
      'maintenance',
      'event',
    ]);
  });
});
