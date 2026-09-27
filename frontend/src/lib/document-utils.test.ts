import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_NUMBER_MASK,
  base64PayloadFromDataUrl,
  documentCountdown,
  documentKindLabel,
  formatBytes,
  isAllowedAttachmentType,
  maskedDocumentNumber,
  sniffContentType,
  validateAttachment,
} from './document-utils';

describe('maskedDocumentNumber', () => {
  it('renders a fixed mask when a number is configured and a placeholder otherwise', () => {
    expect(maskedDocumentNumber(true)).toBe(DOCUMENT_NUMBER_MASK);
    expect(maskedDocumentNumber(false)).toBe('—');
  });

  it('proof: removing the mask breaks the exact-match assertion', () => {
    // The page asserts `toHaveText(DOCUMENT_NUMBER_MASK)`. If the mask were removed
    // (rendering '' or the raw flag), this equality fails — so this pins the contract.
    expect(maskedDocumentNumber(true)).not.toBe('');
    expect(maskedDocumentNumber(true)).not.toBe('true');
    expect(maskedDocumentNumber(true)).toBe('•••• •••• ••••');
  });
});

describe('documentCountdown', () => {
  const ref = new Date(2026, 0, 1);

  it('returns a future countdown for a future expiry', () => {
    const result = documentCountdown('2026-01-11', ref);
    expect(result.kind).toBe('future');
    expect(result.text).toBe('还有 10 天');
  });

  it('returns overdue for a past expiry', () => {
    const result = documentCountdown('2025-12-30', ref);
    expect(result.kind).toBe('overdue');
    expect(result.text).toBe('已逾期 2 天');
  });

  it('renders 无到期日 for null / malformed dates and never NaN', () => {
    for (const value of [null, undefined, '', 'not-a-date', '2026-02-31']) {
      const result = documentCountdown(value, ref);
      expect(result.kind).toBe('none');
      expect(result.text).toBe('无到期日');
      expect(result.text).not.toContain('NaN');
    }
  });
});

describe('formatBytes', () => {
  it('formats byte sizes and guards non-finite input', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(null)).toBe('—');
  });
});

describe('isAllowedAttachmentType', () => {
  it('mirrors the server allowlist and rejects svg', () => {
    expect(isAllowedAttachmentType('application/pdf')).toBe(true);
    expect(isAllowedAttachmentType('image/png')).toBe(true);
    expect(isAllowedAttachmentType('image/jpeg')).toBe(true);
    expect(isAllowedAttachmentType('image/webp')).toBe(true);
    expect(isAllowedAttachmentType('text/plain')).toBe(true);
    expect(isAllowedAttachmentType('image/svg+xml')).toBe(false);
    expect(isAllowedAttachmentType('application/octet-stream')).toBe(false);
  });
});

describe('sniffContentType', () => {
  it('detects known signatures', () => {
    expect(sniffContentType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('application/pdf');
    expect(
      sniffContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
    expect(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    webp.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    expect(sniffContentType(webp)).toBe('image/webp');
    expect(sniffContentType(new TextEncoder().encode('hello vault'))).toBe('text/plain');
  });

  it('returns null for a PE/exe header (the renamed .pdf failure case)', () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(sniffContentType(exe)).toBeNull();
  });
});

describe('validateAttachment (client-side pre-network gate)', () => {
  const pdf = new TextEncoder().encode('%PDF-1.4\n% stub');
  const text = new TextEncoder().encode('plain text');

  it('accepts a real PDF and text file', () => {
    expect(validateAttachment({ name: 'a.pdf', type: 'application/pdf', size: pdf.length }, pdf)).toBeNull();
    expect(
      validateAttachment({ name: 'a.txt', type: 'text/plain', size: text.length }, text),
    ).toBeNull();
  });

  it('rejects an .exe renamed .pdf via magic-byte mismatch', () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const message = validateAttachment(
      { name: 'evil.pdf', type: 'application/pdf', size: exe.length },
      exe,
    );
    expect(message).toContain('不一致');
    expect(message).toContain('application/pdf');
  });

  it('rejects oversize and zero-byte files before any read', () => {
    expect(
      validateAttachment({ name: 'big.pdf', type: 'application/pdf', size: 3 * 1024 * 1024 }, pdf),
    ).toBe('文件超过 2 MB 上限');
    expect(
      validateAttachment({ name: 'empty.pdf', type: 'application/pdf', size: 0 }, new Uint8Array()),
    ).toBe('不能上传空文件');
  });

  it('rejects a disallowed declared type (svg script vector)', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const message = validateAttachment(
      { name: 'x.svg', type: 'image/svg+xml', size: svg.length },
      svg,
    );
    expect(message).toContain('不支持的内容类型');
  });

  it('proof: dropping the size cap would let an oversized file through', () => {
    // If the client check were removed, validateAttachment would return null for a 3 MB
    // file and the upload request WOULD fire. The non-null result here is the guard.
    const big = validateAttachment({ name: 'big.pdf', type: 'application/pdf', size: 3 * 1024 * 1024 }, pdf);
    expect(big).not.toBeNull();
  });
});

describe('base64PayloadFromDataUrl', () => {
  it('strips the data-url prefix and tolerates a raw payload', () => {
    expect(base64PayloadFromDataUrl('data:application/pdf;base64,JVBERi0=')).toBe('JVBERi0=');
    expect(base64PayloadFromDataUrl('JVBERi0=')).toBe('JVBERi0=');
  });
});

describe('documentKindLabel', () => {
  it('maps known kinds and falls back to the raw value', () => {
    expect(documentKindLabel('passport')).toBe('护照');
    expect(documentKindLabel('visa')).toBe('签证');
    expect(documentKindLabel('mystery')).toBe('mystery');
    expect(documentKindLabel(null)).toBe('未知');
  });
});
