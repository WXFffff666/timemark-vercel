import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_KINDS,
  createDocumentSchema,
  documentKindSchema,
  linkAttachmentSchema,
  updateDocumentSchema,
} from './documents.js';

/**
 * Todo 54 acceptance: the shared document-vault contract.
 *
 * `documentNumber` is transport-only plaintext: it is accepted by create/update schemas
 * (the backend encrypts it) and is NEVER part of a response type - responses carry
 * `numberConfigured` instead.
 */
describe('document contract', () => {
  it('lists exactly the eight document kinds', () => {
    expect([...DOCUMENT_KINDS]).toEqual([
      'passport',
      'id_card',
      'driver_license',
      'visa',
      'certificate',
      'policy',
      'contract',
      'other',
    ]);
    expect(documentKindSchema.safeParse('passport').success).toBe(true);
    expect(documentKindSchema.safeParse('bank_card').success).toBe(false);
  });

  it('accepts a full create payload including a document number', () => {
    const parsed = createDocumentSchema.safeParse({
      kind: 'passport',
      title: '护照',
      issuer: '中国出入境管理局',
      documentNumber: 'E12345678',
      issuedAt: '2020-01-01',
      expiresAt: '2030-01-01',
      country: 'CN',
      notes: '十年有效期',
      reminderConfig: { daysBeforeList: [180, 90, 30, 7, 0] },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an expiry before issue and an unknown kind', () => {
    const base = { kind: 'visa', title: '申根签证' };
    expect(createDocumentSchema.safeParse({ ...base, issuedAt: '2026-05-01', expiresAt: '2026-04-01' }).success).toBe(false);
    expect(createDocumentSchema.safeParse({ ...base, kind: 'nonsense' }).success).toBe(false);
    expect(createDocumentSchema.safeParse({ ...base, title: '' }).success).toBe(false);
  });

  it('treats documentNumber as optional/nullable (omitted = keep, null = clear on PATCH)', () => {
    const created = createDocumentSchema.safeParse({ kind: 'id_card', title: '身份证' });
    expect(created.success).toBe(true);

    const cleared = updateDocumentSchema.safeParse({ documentNumber: null });
    expect(cleared.success).toBe(true);

    const replaced = updateDocumentSchema.safeParse({ documentNumber: 'X99' });
    expect(replaced.success).toBe(true);

    const controlChar = updateDocumentSchema.safeParse({ documentNumber: 'X\r\n99' });
    expect(controlChar.success).toBe(false);
  });

  it('allows partial updates and rejects a cross-field date violation when both dates are present', () => {
    expect(updateDocumentSchema.safeParse({ title: '新标题' }).success).toBe(true);
    expect(
      updateDocumentSchema.safeParse({ issuedAt: '2026-06-01', expiresAt: '2026-05-01' }).success,
    ).toBe(false);
  });

  it('linkAttachmentSchema requires a positive integer attachment id', () => {
    expect(linkAttachmentSchema.safeParse({ attachmentId: 5 }).success).toBe(true);
    expect(linkAttachmentSchema.safeParse({ attachmentId: 0 }).success).toBe(false);
    expect(linkAttachmentSchema.safeParse({ attachmentId: -1 }).success).toBe(false);
    expect(linkAttachmentSchema.safeParse({}).success).toBe(false);
  });
});
