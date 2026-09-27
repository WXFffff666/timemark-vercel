import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCalDavItemUrl,
  buildEventWriteBackItem,
  buildExpiryWriteBackItem,
  buildVeventIcs,
  createCalDavClient,
  deriveCalDavUid,
  escapeIcsText,
  normalizeCollectionUrl,
  pushCalDavItem,
  removeCalDavItem,
  sanitizeAlarmDays,
  type CalDavWriteBackItem,
} from '../services/caldav-sync.service.js';
import { parseIcsEvents } from '../utils/ics-parser.js';
import { MockCalDavServer } from './helpers/mock-caldav-server.js';

/**
 * Checkbox 86 acceptance, HTTP contract against a MOCKED CalDAV server:
 *  - create  = PUT with `If-None-Match: *`, stores the returned ETag
 *  - update  = PUT with `If-Match: <stored ETag>`
 *  - delete  = DELETE with `If-Match: <stored ETag>`
 *  - a 412 triggers exactly one re-fetch (GET) + one retry, then an actionable
 *    error when it fails again
 *  - unchanged content is skipped without any HTTP request (idempotency)
 *  - ICS text injection (CRLF) and empty titles still produce a parseable VEVENT
 *
 * The mock enforces CalDAV preconditions strictly (428 when a mutating request
 * carries no precondition), so a blind PUT cannot silently pass.
 */

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Counts lines that are EXACTLY the marker (a real block boundary, not injected text). */
function countBlockLines(body: string, marker: string): number {
  return body.split('\r\n').filter((line) => line === marker).length;
}

function itemFor(uid: string, overrides: Partial<CalDavWriteBackItem> = {}): CalDavWriteBackItem {
  const descriptor = {
    uid,
    summary: '生日提醒',
    description: 'TimeMark 提醒',
    date: '2026-10-01',
    categories: '生日',
    alarmDaysBefore: [1, 7],
  };
  return {
    entityType: 'event',
    entityId: 12,
    uid,
    ics: buildVeventIcs(descriptor) ?? '',
    contentHash: 'hash-v1',
    ...overrides,
  };
}

let server: MockCalDavServer;

beforeEach(async () => {
  server = new MockCalDavServer();
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('CalDAV write-back pure helpers', () => {
  it('derives a stable UID from the entity (no timestamp / randomness)', () => {
    expect(deriveCalDavUid('event', 12)).toBe('timemark-event-12@timemark.app');
    expect(deriveCalDavUid('expiry_item', 7)).toBe('timemark-expiry-7@timemark.app');
    expect(deriveCalDavUid('event', 12)).toBe(deriveCalDavUid('event', 12));
    expect(deriveCalDavUid('event', 12)).not.toBe(deriveCalDavUid('event', 13));
    expect(deriveCalDavUid('event', 12)).not.toContain('/');
  });

  it('builds the PUT URL as {collection}/{uid}.ics and percent-encodes unsafe UID characters', () => {
    expect(buildCalDavItemUrl('https://dav.example.com/cal/', 'timemark-event-12@timemark.app')).toBe(
      'https://dav.example.com/cal/timemark-event-12%40timemark.app.ics',
    );
    const withSlash = buildCalDavItemUrl('https://dav.example.com/cal/', 'a/b@x');
    expect(withSlash).toContain('a%2Fb');
    expect(withSlash).not.toContain('a/b');
    expect(withSlash.endsWith('.ics')).toBe(true);
    expect(normalizeCollectionUrl('https://dav.example.com/cal///')).toBe('https://dav.example.com/cal');
  });

  it('escapes ICS special characters so an injected title cannot open a second VEVENT', () => {
    expect(escapeIcsText('a;b,c\\d')).toBe('a\\;b\\,c\\\\d');
    expect(escapeIcsText('line1\r\nline2')).toBe('line1\\nline2');
    expect(escapeIcsText('line1\nline2')).toBe('line1\\nline2');
    expect(escapeIcsText('line1\rline2')).toBe('line1\\nline2');
    expect(escapeIcsText(null)).toBe('');
  });

  it('sanitizes alarm days to bounded unique integers', () => {
    expect(sanitizeAlarmDays([7, 1, 7, -1, 999, '3', 'nope', 1.5])).toEqual([1, 3, 7]);
    expect(sanitizeAlarmDays(undefined)).toEqual([]);
  });
});

describe('mocked CalDAV server: create / update / delete', () => {
  it('CREATE sends PUT with If-None-Match: * and stores the returned ETag', async () => {
    const uid = deriveCalDavUid('event', 12);
    const client = createCalDavClient({
      collectionUrl: server.baseUrl,
      username: 'alice',
      password: 's3cret',
    });
    const item = itemFor(uid);

    const result = await pushCalDavItem(client, item);

    expect(result.action).toBe('created');
    const [request] = server.requestsFor(uid);
    expect(request?.method).toBe('PUT');
    expect(request?.ifNoneMatch).toBe('*');
    expect(request?.ifMatch).toBeNull();
    expect(request?.authorization).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
    expect(request?.contentType).toContain('text/calendar');
    expect(request?.body).toContain('BEGIN:VEVENT');
    expect(server.objects.get(uid)?.etag).toBe(result.etag);
    expect(result.etag).toBeTruthy();
  });

  it('UPDATE uses the STORED ETag in If-Match (a blind PUT would hit 428)', async () => {
    const uid = deriveCalDavUid('event', 12);
    const client = createCalDavClient({ collectionUrl: server.baseUrl, username: '', password: '' });
    const created = await pushCalDavItem(client, itemFor(uid, { contentHash: 'hash-v1' }));
    expect(created.action).toBe('created');
    const storedEtag = created.etag as string;

    const result = await pushCalDavItem(
      client,
      itemFor(uid, { contentHash: 'hash-v2' }),
      { etag: storedEtag, contentHash: 'hash-v1' },
    );

    expect(result.action).toBe('updated');
    const secondPut = server.requestsFor(uid)[1];
    expect(secondPut?.method).toBe('PUT');
    expect(secondPut?.ifMatch).toBe(storedEtag);
    expect(secondPut?.ifNoneMatch).toBeNull();
    expect(result.etag).not.toBe(storedEtag);
    expect(server.objects.get(uid)?.etag).toBe(result.etag);
  });

  it('DELETE issues DELETE with the stored ETag', async () => {
    const uid = deriveCalDavUid('expiry_item', 7);
    const client = createCalDavClient({ collectionUrl: server.baseUrl, username: '', password: '' });
    const created = await pushCalDavItem(client, itemFor(uid, { entityType: 'expiry_item', entityId: 7 }));
    expect(created.action).toBe('created');

    const result = await removeCalDavItem(
      client,
      { entityType: 'expiry_item', entityId: 7, uid },
      { etag: created.etag, contentHash: created.contentHash },
    );

    expect(result.action).toBe('deleted');
    const request = server.requestsFor(uid)[1];
    expect(request?.method).toBe('DELETE');
    expect(request?.ifMatch).toBe(created.etag);
    expect(server.objects.has(uid)).toBe(false);
  });

  it('stale state: unchanged content is SKIPPED without any HTTP request', async () => {
    const uid = deriveCalDavUid('event', 12);
    const client = createCalDavClient({ collectionUrl: server.baseUrl, username: '', password: '' });
    const item = itemFor(uid, { contentHash: 'hash-stable' });
    const created = await pushCalDavItem(client, item);
    const requestsAfterCreate = server.requests.length;

    const second = await pushCalDavItem(client, item, { etag: created.etag, contentHash: 'hash-stable' });

    expect(second.action).toBe('skipped');
    expect(server.requests.length).toBe(requestsAfterCreate);
  });
});

describe('mocked CalDAV server: 412 recovery and failure reporting', () => {
  it('412 on create triggers ONE re-fetch + ONE retry with the current ETag', async () => {
    const uid = deriveCalDavUid('event', 12);
    const existingEtag = server.seed(uid, 'BEGIN:VCALENDAR\r\nX-PREVIOUS\r\nEND:VCALENDAR\r\n');
    const client = createCalDavClient({ collectionUrl: server.baseUrl, username: '', password: '' });

    const result = await pushCalDavItem(client, itemFor(uid));

    expect(result.action).toBe('updated');
    const requests = server.requestsFor(uid);
    expect(requests.map((r) => r.method)).toEqual(['PUT', 'GET', 'PUT']);
    expect(requests[0]?.ifNoneMatch).toBe('*');
    expect(requests[2]?.ifMatch).toBe(existingEtag);
    expect(server.objects.get(uid)?.body).toContain('BEGIN:VEVENT');
  });

  it('a persistent 412 reports an actionable error after exactly one retry and leaves state intact', async () => {
    const uid = deriveCalDavUid('event', 12);
    server.seed(uid);
    server.alwaysRejectPut.add(uid);
    const objectsBefore = JSON.stringify([...server.objects.entries()]);
    const client = createCalDavClient({ collectionUrl: server.baseUrl, username: '', password: '' });

    const result = await pushCalDavItem(client, itemFor(uid), { etag: '"stale"', contentHash: 'old-hash' });

    expect(result.action).toBe('failed');
    expect(result.error).toContain('412');
    expect(result.error).toContain(uid);
    expect(result.error).toContain('one retry');
    expect(result.error).toContain('NOT modified');
    expect(result.error).toContain('caldav-sync');

    const requests = server.requestsFor(uid);
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    expect(requests.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(requests).toHaveLength(3);
    // The remote object was not corrupted by the failed attempts.
    expect(JSON.stringify([...server.objects.entries()])).toBe(objectsBefore);
  });

  it('a collection returning 500 produces an actionable failure instead of throwing', async () => {
    const uid = deriveCalDavUid('event', 12);
    server.failAll = true;
    const client = createCalDavClient({ collectionUrl: server.baseUrl, username: '', password: '' });

    const result = await pushCalDavItem(client, itemFor(uid));

    expect(result.action).toBe('failed');
    expect(result.error).toContain('HTTP 500');
    expect(result.error).toContain('NOT modified');
  });

  it('a persistent 412 on DELETE reports an actionable error after one retry', async () => {
    const uid = deriveCalDavUid('expiry_item', 7);
    server.seed(uid);
    server.alwaysRejectDelete.add(uid);
    const client = createCalDavClient({ collectionUrl: server.baseUrl, username: '', password: '' });

    const result = await removeCalDavItem(
      client,
      { entityType: 'expiry_item', entityId: 7, uid },
      { etag: '"stale"', contentHash: null },
    );

    expect(result.action).toBe('failed');
    expect(result.error).toContain('DELETE');
    expect(result.error).toContain('one retry');
    expect(result.error).toContain('NOT modified');
    const requests = server.requestsFor(uid);
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(2);
    expect(requests.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(server.objects.has(uid)).toBe(true);
  });
});

describe('ICS body hardening', () => {
  it('an empty title still produces a valid single-VEVENT calendar', () => {
    const descriptor = {
      uid: deriveCalDavUid('event', 1),
      summary: '',
      description: '',
      date: '2026-10-01',
      categories: '其他',
      alarmDaysBefore: [],
    };
    const ics = buildVeventIcs(descriptor);
    expect(ics).not.toBeNull();
    expect(countBlockLines(ics as string, 'BEGIN:VEVENT')).toBe(1);
    expect(parseIcsEvents(ics as string)).toHaveLength(1);
  });

  it('a CRLF-injected title cannot break out of SUMMARY', () => {
    const injected = 'Evil\r\nBEGIN:VEVENT\r\nUID:injected@attacker\r\nEND:VEVENT\r\nend';
    const ics = buildVeventIcs({
      uid: deriveCalDavUid('event', 99),
      summary: injected,
      description: 'notes\r\nSUMMARY:overridden',
      date: '2026-10-01',
      categories: '其他',
      alarmDaysBefore: [1],
    });
    expect(ics).not.toBeNull();
    const body = ics as string;
    // Exactly one real VEVENT block: the injected text stays escaped inside the
    // SUMMARY / DESCRIPTION line and can never become a block boundary.
    expect(countBlockLines(body, 'BEGIN:VEVENT')).toBe(1);
    expect(countBlockLines(body, 'END:VEVENT')).toBe(1);
    expect(body).toContain('\\nBEGIN:VEVENT');
    expect(countOccurrences(body, '\r\nBEGIN:VEVENT')).toBe(1);
    const parsed = parseIcsEvents(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toContain('Evil');
    // Every line is CRLF-terminated and no line contains a bare LF.
    expect(body.split('\r\n').every((line) => !line.includes('\n'))).toBe(true);
  });

  it('a malformed date / empty entity fields are rejected instead of producing broken ICS', () => {
    expect(
      buildVeventIcs({
        uid: 'u',
        summary: 'x',
        description: '',
        date: '2026-13-45',
        categories: '',
        alarmDaysBefore: [],
      }),
    ).toBeNull();
    expect(buildEventWriteBackItem({ id: 1, name: 'x', type: 'other', date: 'not-a-date' })).toBeNull();
    expect(buildExpiryWriteBackItem({ id: 2, title: '', kind: 'custom', nextDueDate: '' })).toBeNull();
  });
});
