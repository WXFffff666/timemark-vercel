import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

/**
 * todo 88 acceptance — public share/embed OG images + crawler meta.
 *
 * - a valid token renders OG tags WITH the event name (server-rendered document)
 * - an invalid token is 404 with NO OG data
 * - a revoked token is 404 with a GENERIC title (no event-name leak)
 * - the OG image route returns image/svg+xml and is byte-stable for the same token
 * - a DB edit changes the (ETag'd) image — stale state never serves the old event
 * - hostile event names render as inert text (no SVG/XML injection)
 *
 * The DB layer is mocked (no reachable Postgres); `query` is exercised for its parameters so the
 * token-scoped access control is proven at the SQL boundary.
 */

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock('../db/index.js', () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

import ogRoutes, {
  buildOgMeta,
  escapeXml,
  formatCountdown,
  renderOgSvg,
  toOgInput,
  OG_IMAGE_PATH,
} from '../routes/og.js';

const TOKEN = 'a'.repeat(32);

interface Row {
  name: string;
  type: string;
  date: string;
  calendar_type: string;
  person_name: string | null;
  next_occurrence: string | null;
  recurring_config: unknown;
}

function eventRow(overrides: Partial<Row> = {}): Row {
  return {
    name: '妈妈的生日',
    type: 'birthday',
    date: '1990-08-15',
    calendar_type: 'gregorian',
    person_name: '妈妈',
    next_occurrence: null,
    recurring_config: null,
    ...overrides,
  };
}

function installDb(row: Row | null): void {
  dbQuery.mockReset();
  dbQuery.mockImplementation(async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function fetchShare(token: string) {
  const res = await ogRoutes.request(`/share/${token}`);
  return { res, html: await res.text() };
}

beforeEach(() => {
  installDb(eventRow());
});

describe('todo 88 — GET /share/:token OG meta', () => {
  it('renders og:* + twitter:card WITH the event name for a valid token', async () => {
    const { res, html } = await fetchShare(TOKEN);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<meta property="og:title" content="妈妈的生日 · TimeMark"');
    expect(html).toContain('<meta property="og:type" content="website"');
    expect(html).toContain('<meta property="og:site_name" content="TimeMark"');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    expect(html).toContain('<meta property="og:image" content="');
    expect(html).toContain(`${OG_IMAGE_PATH}/${TOKEN}`);
    expect(html).toContain(`/share/${TOKEN}`);
    // keeps the noindex contract
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive"');

    // token access control is a parameterised equality on share_token
    expect(dbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(String(sql)).toContain('FROM events WHERE share_token = $1');
    expect(params).toEqual([TOKEN]);
  });

  it('the OG-tag test is meaningful: it fails if the event name is absent', async () => {
    // Mutation proof at the assertion level — render without the name and the title tag differs.
    const withoutName = buildOgMeta({
      ...toOgInput(eventRow({ name: '  ' }), '2026-08-15'),
      token: TOKEN,
      origin: 'http://localhost',
    });
    expect(withoutName.title).not.toContain('妈妈的生日');
    const html = await (await ogRoutes.request(`/share/${TOKEN}`)).text();
    // sanity: the real response does contain it
    expect(html).toContain('妈妈的生日');
  });

  it('returns 404 with NO OG data for an unknown token', async () => {
    installDb(null);
    const { res, html } = await fetchShare('f'.repeat(32));

    expect(res.status).toBe(404);
    expect(html).not.toContain('og:');
    expect(html).not.toContain('twitter:');
    expect(html).not.toContain('妈妈的生日');
    expect(html).toContain('<title>TimeMark</title>');
  });

  it('a revoked token leaks nothing — generic title, no event name', async () => {
    // "revoked" = share_token cleared/NULLed, so the lookup matches zero rows.
    installDb(null);
    const { res, html } = await fetchShare('b'.repeat(32));

    expect(res.status).toBe(404);
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    expect(title).toBe('TimeMark');
    expect(html).not.toContain('妈妈的生日');
    expect(html).not.toContain('og:title');
  });

  it('rejects a token that is too short without touching the DB', async () => {
    const { res } = await fetchShare('short');
    expect(res.status).toBe(404);
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('todo 88 — GET /image/:token OG image', () => {
  it('returns a valid image content-type and is byte-stable for the same token', async () => {
    const first = await ogRoutes.request(`/image/${TOKEN}`);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('image/svg+xml');

    const body1 = await first.text();
    const second = await ogRoutes.request(`/image/${TOKEN}`);
    const body2 = await second.text();

    expect(body2).toBe(body1);
    expect(sha256(body2)).toBe(sha256(body1));
    expect(body1.startsWith('<svg')).toBe(true);
    expect(body1.trimEnd().endsWith('</svg>')).toBe(true);
    // shows the app mark, the event name and a countdown
    expect(body1).toContain('TimeMark');
    expect(body1).toContain('妈妈的生日');
    expect(body1).toMatch(/还有 \d+ 天|就是今天|已过去 \d+ 天/);
  });

  it('returns 404 and no image for an invalid token', async () => {
    installDb(null);
    const res = await ogRoutes.request(`/image/${'f'.repeat(32)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('regenerates (new ETag + bytes) after the event is edited — no stale cache', async () => {
    const before = await ogRoutes.request(`/image/${TOKEN}`);
    const etagBefore = before.headers.get('etag');
    const bytesBefore = await before.text();

    installDb(eventRow({ name: '改名后的事件' }));

    const after = await ogRoutes.request(`/image/${TOKEN}`);
    const etagAfter = after.headers.get('etag');
    const bytesAfter = await after.text();

    expect(etagBefore).toBeTruthy();
    expect(etagAfter).toBeTruthy();
    expect(etagAfter).not.toBe(etagBefore);
    expect(bytesAfter).not.toBe(bytesBefore);
    expect(bytesAfter).toContain('改名后的事件');

    // Conditional GET honours the fresh ETag
    const notModified = await ogRoutes.request(`/image/${TOKEN}`, {
      headers: { 'if-none-match': etagAfter as string },
    });
    expect(notModified.status).toBe(304);
  });
});

describe('todo 88 — hostile / malformed input', () => {
  it('renders an SVG/XML-injection event name as inert text', async () => {
    const hostile = '<script>alert(1)</script>';
    installDb(eventRow({ name: hostile }));

    const res = await ogRoutes.request(`/image/${TOKEN}`);
    const svg = await res.text();

    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('</script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(res.status).toBe(200);

    const longHostile = '<script>alert(1)</script>&"<image href="x" onerror="alert(2)"/>';
    installDb(eventRow({ name: longHostile }));
    const html = await (await ogRoutes.request(`/share/${TOKEN}`)).text();
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('</script>');
    expect(html).not.toContain('onerror="alert');
    expect(html).not.toContain('<image ');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('strips XML-illegal control characters', () => {
    expect(escapeXml('a\u0000b\u0008c')).toBe('abc');
    expect(escapeXml('a\tb\nc')).toBe('a\tb\nc');
  });

  it('handles a 500-character event name without breaking the SVG', async () => {
    installDb(eventRow({ name: '长'.repeat(500) }));
    const res = await ogRoutes.request(`/image/${TOKEN}`);
    const svg = await res.text();
    expect(res.status).toBe(200);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('…');
  });

  it('handles a 1000-character title without breaking the SVG', async () => {
    const svg = renderOgSvg({ name: 'x'.repeat(1000), type: 'other', date: '2026-01-01', days: 3 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('TimeMark');
  });

  it('keeps emoji + CJK intact (no tofu, no broken XML)', async () => {
    installDb(eventRow({ name: '🎂妈妈的生日庆祝🎉' }));
    const svg = await (await ogRoutes.request(`/image/${TOKEN}`)).text();
    expect(svg).toContain('🎂妈妈的生日庆祝🎉');
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('treats an SQL/HTML token as an opaque parameter (never interpolated)', async () => {
    installDb(null);
    const sneaky = `x' OR '1'='1' --<img src=x onerror=alert(1)>`;
    const res = await ogRoutes.request(`/image/${encodeURIComponent(sneaky)}`);
    expect(res.status).toBe(404);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(String(sql)).not.toContain(sneaky);
    expect(String(sql)).not.toContain('DROP');
    expect(params).toEqual([sneaky]);
  });

  it('a token for a deleted event yields 404 in both routes', async () => {
    installDb(null);
    expect((await ogRoutes.request(`/share/${TOKEN}`)).status).toBe(404);
    expect((await ogRoutes.request(`/image/${TOKEN}`)).status).toBe(404);
  });
});

describe('todo 88 — countdown + escaping units', () => {
  it('formatCountdown covers past / today / future', () => {
    expect(formatCountdown(0)).toBe('就是今天');
    expect(formatCountdown(5)).toBe('还有 5 天');
    expect(formatCountdown(-3)).toBe('已过去 3 天');
  });

  it('toOgInput rolls a yearly birthday to the next occurrence', () => {
    const input = toOgInput(eventRow({ date: '1990-08-15', type: 'birthday' }), '2026-08-15');
    expect(input.days).toBe(0);
    const later = toOgInput(eventRow({ date: '1990-08-15', type: 'birthday' }), '2026-08-20');
    expect(later.days).toBe(360);
  });

  it('toOgInput keeps a one-off event anchored to its stored date', () => {
    const input = toOgInput(eventRow({ date: '2030-01-01', type: 'other' }), '2026-08-15');
    expect(input.days).toBeGreaterThan(0);
  });

  it('renderOgSvg is a pure function of its input (byte-stable)', () => {
    const a = renderOgSvg({ name: '稳定性', type: 'birthday', date: '2026-01-01', days: 7 });
    const b = renderOgSvg({ name: '稳定性', type: 'birthday', date: '2026-01-01', days: 7 });
    expect(a).toBe(b);
    expect(sha256(a)).toBe(sha256(b));
  });
});
