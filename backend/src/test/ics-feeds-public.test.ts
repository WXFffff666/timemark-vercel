import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvents } from 'ics';
import { createHash } from 'crypto';

/**
 * Checkbox 89 - public tokenised ICS feed contract.
 *
 * The db module is mocked with a small state-based fake that APPLIES the WHERE
 * clauses it sees in the SQL. That makes these tests sensitive to a dropped
 * filter (returning everything fails the count assertion) and to a dropped
 * `revoked_at IS NULL` (serving a revoked feed fails the 404 assertion).
 */

interface FeedRow {
  id: number;
  user_id: number;
  name: string;
  filter: unknown;
  token_hash: string | null;
  created_at?: string;
  last_access_at?: string | null;
  revoked_at?: string | null;
}

const db = vi.hoisted(() => ({
  feeds: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  documents: [] as Array<Record<string, unknown>>,
  expiryItems: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ sql: string; params: unknown[] }>,
}));

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

vi.mock('../db/index.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = norm(sql);
    db.calls.push({ sql: s, params });

    if (s.includes('FROM ics_feeds')) {
      const hash = params[0];
      const requireLive = s.includes('revoked_at IS NULL');
      const row = db.feeds.find(
        (f) => f.token_hash !== null && f.token_hash === hash && (!requireLive || f.revoked_at == null),
      );
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (s.startsWith('UPDATE ics_feeds SET last_access_at')) {
      const row = db.feeds.find((f) => f.id === params[0]);
      if (row) row.last_access_at = '2026-09-28T00:00:00.000Z';
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (s.includes('FROM events')) {
      const filtered = filterRows(db.events, s, params);
      return { rows: filtered, rowCount: filtered.length };
    }
    if (s.includes('FROM documents')) {
      const filtered = filterRows(db.documents, s, params);
      return { rows: filtered, rowCount: filtered.length };
    }
    if (s.includes('FROM expiry_items')) {
      const filtered = filterRows(db.expiryItems, s, params);
      return { rows: filtered, rowCount: filtered.length };
    }
    return { rows: [], rowCount: 0 };
  }),
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

function filterRows(
  rows: Array<Record<string, unknown>>,
  sql: string,
  params: unknown[],
): Array<Record<string, unknown>> {
  let out = rows.filter((r) => r.user_id === params[0]);
  const value = params[1];
  if (sql.includes('is_active = TRUE')) out = out.filter((r) => r.is_active === true);
  if (sql.includes('expires_at IS NOT NULL')) out = out.filter((r) => r.expires_at != null);
  if (sql.includes('next_due_date IS NOT NULL')) out = out.filter((r) => r.next_due_date != null);
  if (sql.includes('LOWER(person_name) = LOWER($2)')) {
    out = out.filter((r) => String(r.person_name ?? '').toLowerCase() === String(value).toLowerCase());
  }
  if (sql.includes('type = $2')) out = out.filter((r) => r.type === value);
  if (sql.includes('kind = $2')) out = out.filter((r) => r.kind === value);
  if (sql.includes('profile_id = $2')) out = out.filter((r) => r.profile_id === value);
  return projectRows(out, sql);
}

/**
 * Emulate the SQL SELECT aliases (`name AS title`, `type AS kind`, `date AS due`,
 * ...) exactly like pg would: the service must only ever see the projected
 * columns, never the raw row.
 */
function projectRows(
  rows: Array<Record<string, unknown>>,
  sql: string,
): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    id: r.id,
    title: sql.includes('name AS title') ? r.name : r.title,
    kind: sql.includes('type AS kind') ? r.type : r.kind,
    due: sql.includes('next_due_date AS due')
      ? r.next_due_date
      : sql.includes('expires_at AS due')
        ? r.expires_at
        : r.date,
  }));
}

import publicIcsRoutes from '../routes/public-ics.js';

const TOKEN = 'tok_' + 'a'.repeat(40);
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const USER_ID = 7;

function seedFeed(overrides: Partial<FeedRow> = {}): FeedRow {
  const row: FeedRow = {
    id: 1,
    user_id: USER_ID,
    name: '家庭日历',
    filter: { type: 'category', value: 'birthday' },
    token_hash: TOKEN_HASH,
    created_at: '2026-09-01T00:00:00.000Z',
    last_access_at: null,
    revoked_at: null,
    ...overrides,
  };
  db.feeds.push(row as unknown as Record<string, unknown>);
  return row;
}

function veventCount(body: string): number {
  return body.split('BEGIN:VEVENT').length - 1;
}

function veventBlocks(body: string): string[] {
  return body
    .split('BEGIN:VEVENT')
    .slice(1)
    .map((block) => block.split('END:VEVENT')[0]);
}

function lineValue(block: string, prefix: string): string | null {
  const line = block.split('\r\n').find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

beforeEach(() => {
  db.feeds.length = 0;
  db.events.length = 0;
  db.documents.length = 0;
  db.expiryItems.length = 0;
  db.calls.length = 0;
});

describe('GET /api/public/ics/:token.ics', () => {
  it('returns a valid ICS calendar, parseable via the ics library, with the expected VEVENT count', async () => {
    seedFeed({ filter: { type: 'category', value: 'birthday' } });
    db.events.push(
      { id: 1, user_id: USER_ID, name: '妈妈生日', type: 'birthday', date: '2026-10-05', person_name: '妈妈', profile_id: 1 },
      { id: 2, user_id: USER_ID, name: '爸爸生日', type: 'birthday', date: '2026-11-01', person_name: '爸爸', profile_id: 1 },
      { id: 3, user_id: USER_ID, name: '期末考试', type: 'exam', date: '2026-12-01', person_name: null, profile_id: 1 },
    );

    const res = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const body = await res.text();

    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(veventCount(body)).toBe(2);
    expect(body).not.toContain('期末考试');

    // Round-trip every VEVENT through the ics library: the feed's events are
    // expressible AND serializable by the same package.
    const attributes = veventBlocks(body).map((block) => {
      const dtstart = lineValue(block, 'DTSTART;VALUE=DATE:');
      expect(dtstart).toMatch(/^\d{8}$/);
      return {
        start: [Number(dtstart!.slice(0, 4)), Number(dtstart!.slice(4, 6)), Number(dtstart!.slice(6, 8))] as [
          number,
          number,
          number,
        ],
        duration: { days: 1 },
        title: lineValue(block, 'SUMMARY:') ?? '',
        uid: lineValue(block, 'UID:') ?? '',
        categories: [lineValue(block, 'CATEGORIES:') ?? ''],
      };
    });
    expect(attributes).toHaveLength(2);
    const roundTrip = createEvents(attributes, { calName: 'round-trip' });
    expect(roundTrip.error).toBeNull();
    expect(roundTrip.value).toContain('BEGIN:VEVENT');
  });

  it('aggregates events, documents and expiry items for a profile filter', async () => {
    seedFeed({ filter: { type: 'profile', value: 3 } });
    db.events.push(
      { id: 11, user_id: USER_ID, name: '体检', type: 'medical', date: '2026-10-20', person_name: null, profile_id: 3 },
    );
    db.documents.push({
      id: 21,
      user_id: USER_ID,
      title: '护照',
      kind: 'passport',
      expires_at: '2027-01-02',
      profile_id: 3,
      is_active: true,
      document_number_encrypted: 'P1234567890',
      notes: 'PRIVATE-DOC-NOTE',
    });
    db.expiryItems.push({
      id: 31,
      user_id: USER_ID,
      title: '域名续费',
      kind: 'domain',
      next_due_date: '2026-12-31',
      profile_id: 3,
      is_active: true,
      amount_cents: 19900,
      notes: 'PRIVATE-EXPIRY-NOTE',
    });
    db.documents.push({
      id: 22,
      user_id: USER_ID,
      title: '别的档案的合同',
      kind: 'contract',
      expires_at: '2027-02-02',
      profile_id: 9,
      is_active: true,
    });

    const res = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(veventCount(body)).toBe(3);
    expect(body).toContain('护照');
    expect(body).toContain('域名续费');
    expect(body).not.toContain('别的档案的合同');
    expect(body).toContain('UID:timemark-document-21@timemark.app');
    expect(body).toContain('UID:timemark-expiry-31@timemark.app');
  });

  it('never serializes document_number, notes or amount_cents into the feed body (positive control on the entity)', async () => {
    seedFeed({ filter: { type: 'profile', value: 3 } });
    db.documents.push({
      id: 41,
      user_id: USER_ID,
      title: '护照',
      kind: 'passport',
      expires_at: '2027-01-02',
      profile_id: 3,
      is_active: true,
      document_number_encrypted: 'P1234567890',
      notes: 'PRIVATE-DOC-NOTE',
    });
    db.expiryItems.push({
      id: 42,
      user_id: USER_ID,
      title: '域名续费',
      kind: 'domain',
      next_due_date: '2026-12-31',
      profile_id: 3,
      is_active: true,
      amount_cents: 19900,
      notes: 'PRIVATE-EXPIRY-NOTE',
      vendor: 'PRIVATE-VENDOR',
    });

    // Positive control: the fields DO exist on the entity rows.
    expect(db.documents[0].document_number_encrypted).toBe('P1234567890');
    expect(db.documents[0].notes).toBe('PRIVATE-DOC-NOTE');
    expect(db.expiryItems[0].amount_cents).toBe(19900);

    const res = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    expect(res.status).toBe(200);
    const body = await res.text();

    // Assert on the SERIALIZED body, not on an object.
    expect(body).toContain('护照');
    expect(body).not.toContain('P1234567890');
    expect(body).not.toContain('PRIVATE-DOC-NOTE');
    expect(body).not.toContain('PRIVATE-EXPIRY-NOTE');
    expect(body).not.toContain('PRIVATE-VENDOR');
    expect(body).not.toContain('19900');
    expect(body).not.toContain('199.00');
    expect(body).not.toContain('document_number');
    expect(body).not.toContain('amount_cents');
    expect(body).not.toContain('notes');

    // Structural guarantee: the service SQL never selects the private columns.
    const selects = db.calls.filter((c) => c.sql.includes('FROM documents') || c.sql.includes('FROM expiry_items'));
    expect(selects.length).toBeGreaterThan(0);
    for (const call of selects) {
      expect(call.sql).not.toMatch(/document_number|amount_cents|notes|vendor|issuer/i);
    }
  });

  it('returns 404 for a revoked token and keeps returning 404 on a fresh request', async () => {
    const feed = seedFeed({ revoked_at: '2026-09-20T00:00:00.000Z' });

    const first = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    expect(first.status).toBe(404);
    expect(await first.text()).not.toContain('妈妈生日');

    feed.revoked_at = '2026-09-20T00:00:00.000Z';
    const second = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    expect(second.status).toBe(404);
    expect(await second.text()).toBe('Not found');

    // A live feed is served, then a revoke flips the very next read to 404
    // (regenerated on read, no cached 200).
    const live = seedFeed({ id: 2, token_hash: createHash('sha256').update(TOKEN + 'x').digest('hex'), revoked_at: null });
    const liveRes = await publicIcsRoutes.request(`/${TOKEN}x.ics`);
    expect(liveRes.status).toBe(200);
    live.revoked_at = '2026-09-28T00:00:00.000Z';
    const afterRevoke = await publicIcsRoutes.request(`/${TOKEN}x.ics`);
    expect(afterRevoke.status).toBe(404);
  });

  it('returns 404 for malformed, absent and oversized tokens without ever querying the feed table', async () => {
    for (const path of ['/', '/.ics', '/short.ics', `/${'z'.repeat(200)}.ics`, `/${'a'.repeat(200)}`]) {
      const res = await publicIcsRoutes.request(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('BEGIN:VCALENDAR');
    }
    const feedQueries = db.calls.filter((c) => c.sql.includes('FROM ics_feeds'));
    expect(feedQueries).toHaveLength(0);
  });

  it('returns 404 (never 500) for a double .ics suffix and a token_hash NULL row', async () => {
    seedFeed({ filter: { type: 'category', value: 'birthday' } });
    db.feeds.push({
      id: 99,
      user_id: USER_ID,
      name: 'null hash',
      filter: { type: 'category', value: 'birthday' },
      token_hash: null,
      revoked_at: null,
    });

    const doubleSuffix = await publicIcsRoutes.request(`/${TOKEN}.ics.ics`);
    expect(doubleSuffix.status).toBe(404);

    const nullHash = await publicIcsRoutes.request(`/${'n'.repeat(43)}.ics`);
    expect(nullHash.status).toBe(404);
    expect(await nullHash.text()).not.toContain('BEGIN:VCALENDAR');
  });

  it('returns 404 (never 500) for a stored empty filter {} and for an oversized filter value', async () => {
    seedFeed({ filter: {} });

    const res = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('BEGIN:VCALENDAR');

    db.feeds.length = 0;
    seedFeed({ filter: { type: 'category', value: 'x'.repeat(365) } });
    const oversized = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    expect(oversized.status).toBe(404);
    expect(await oversized.text()).not.toContain('BEGIN:VCALENDAR');
  });

  it('returns a valid EMPTY calendar when the filter matches zero items', async () => {
    seedFeed({ filter: { type: 'category', value: 'no-such-category' } });
    db.events.push({ id: 1, user_id: USER_ID, name: '妈妈生日', type: 'birthday', date: '2026-10-05', person_name: '妈妈', profile_id: 1 });

    const res = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('END:VCALENDAR');
    expect(body).toContain('X-WR-CALNAME:');
    expect(veventCount(body)).toBe(0);
    expect(body).not.toContain('妈妈生日');
  });

  it('updates last_access_at on every read', async () => {
    const feed = seedFeed({ filter: { type: 'category', value: 'birthday' } });
    expect(feed.last_access_at).toBeNull();

    await publicIcsRoutes.request(`/${TOKEN}.ics`);

    const update = db.calls.find((c) => c.sql.startsWith('UPDATE ics_feeds SET last_access_at'));
    expect(update).toBeDefined();
    expect(update!.params).toEqual([1]);
    expect(feed.last_access_at).toBe('2026-09-28T00:00:00.000Z');
  });

  it('escapes a hostile feed name and title so the ICS header/body cannot be broken', async () => {
    seedFeed({
      name: 'Evil\r\nX-INJECTED:1, semi; back\\slash',
      filter: { type: 'category', value: 'Evil\r\nCAT-INJECT:1' },
    });
    db.events.push({
      id: 1,
      user_id: USER_ID,
      name: 'Party\r\nINJECTED:1',
      type: 'Evil\r\nCAT-INJECT:1',
      date: '2026-10-05',
      person_name: null,
      profile_id: 1,
    });

    const res = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const lines = body.split('\r\n');

    // No raw CR/LF escaped into a forged header line.
    expect(lines.some((l) => l.startsWith('X-INJECTED'))).toBe(false);
    expect(lines.some((l) => l.startsWith('INJECTED'))).toBe(false);
    expect(lines.some((l) => l.startsWith('CAT-INJECT'))).toBe(false);
    expect(body).not.toContain('Evil\r\n');
    const calNameLine = lines.find((l) => l.startsWith('X-WR-CALNAME:'));
    expect(calNameLine).toBeDefined();
    // Stable X-WR-CALNAME: identical across two independent reads.
    const res2 = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    const body2 = await res2.text();
    expect(body2.split('\r\n').find((l) => l.startsWith('X-WR-CALNAME:'))).toBe(calNameLine);
  });

  it('renders an item 365 days in the future as one valid VEVENT (huge range)', async () => {
    seedFeed({ filter: { type: 'category', value: 'birthday' } });
    const future = new Date();
    future.setDate(future.getDate() + 365);
    const ymd = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    db.events.push({ id: 1, user_id: USER_ID, name: '一年后', type: 'birthday', date: ymd, person_name: null, profile_id: 1 });

    const res = await publicIcsRoutes.request(`/${TOKEN}.ics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(veventCount(body)).toBe(1);
    expect(body).toContain('DTSTART;VALUE=DATE:' + ymd.replace(/-/g, ''));
  });
});
