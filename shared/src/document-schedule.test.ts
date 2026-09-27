import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCUMENT_LEAD_DAYS,
  DOCUMENT_EXPIRED_EVENT_TYPE,
  DOCUMENT_LONG_LEAD_KINDS,
  LONG_LEAD_DOCUMENT_LEAD_DAYS,
  buildDocumentExpiredKey,
  buildDocumentSendKey,
  documentEventType,
  documentLeadDays,
} from './document-schedule.js';

/**
 * Todo 55: per-kind default lead tables for document-expiry reminders.
 *
 * These pure functions are consumed by the shared reminder iterator in
 * `backend/src/jobs/tasks.ts`; the backend tests assert they actually drive
 * the dispatch, this file locks the tables and key shapes themselves.
 */
describe('document-schedule', () => {
  it('uses [180, 90, 30, 7, 0] for passport and visa', () => {
    for (const kind of DOCUMENT_LONG_LEAD_KINDS) {
      expect(documentLeadDays(kind)).toEqual([180, 90, 30, 7, 0]);
    }
  });

  it('uses [90, 30, 7, 0] for every other kind (including unknown values)', () => {
    for (const kind of ['id_card', 'driver_license', 'certificate', 'policy', 'contract', 'other', 'mystery']) {
      expect(documentLeadDays(kind)).toEqual([90, 30, 7, 0]);
    }
  });

  it('exposes the raw tables as immutable defaults', () => {
    expect([...DEFAULT_DOCUMENT_LEAD_DAYS]).toEqual([90, 30, 7, 0]);
    expect([...LONG_LEAD_DOCUMENT_LEAD_DAYS]).toEqual([180, 90, 30, 7, 0]);
  });

  it('builds namespaced keys so documents never collide with other reminder sources', () => {
    expect(buildDocumentSendKey('2026-06-01', 180, '09:00')).toBe('document:2026-06-01#d180#t09:00');
    expect(buildDocumentSendKey('2026-06-01', 90, '09:00')).toBe('document:2026-06-01#d90#t09:00');
    // The expired key deliberately has NO date component: exactly one final reminder.
    expect(buildDocumentExpiredKey('2026-05-20')).toBe('document:expired#2026-05-20');
  });

  it('maps upcoming documents to document_<kind> and past ones to the expired type', () => {
    expect(documentEventType('passport', 180)).toBe('document_passport');
    expect(documentEventType('visa', 0)).toBe('document_visa');
    expect(documentEventType('id_card', 90)).toBe('document_id_card');
    expect(documentEventType('passport', -1)).toBe(DOCUMENT_EXPIRED_EVENT_TYPE);
    expect(documentEventType('other', -400)).toBe('document_expired');
  });
});
