import { Hono, type Context } from 'hono';
import { createHash } from 'crypto';
import { diffCalendarDays, resolveNextGregorianOccurrence } from '@timemark/shared';
import { query } from '../db/index.js';

/**
 * todo 88 — dynamic Open Graph images + crawler meta for public share/embed links.
 *
 * Technology decision: HAND-ROLLED DETERMINISTIC SVG (no `@vercel/og`, no new dependency).
 * Rationale:
 *  - strict free-tier / bundle budget; `@vercel/og` ships a multi-MB WASM runtime + font data
 *  - byte-stable output: no font fetches, no timestamps, no randomness — a pure function of
 *    (event name, countdown days, date, type)
 *  - token access control is inherited verbatim from `features.ts`: `events.share_token = $1`
 *    (parameterised). No token -> no row -> 404 -> no data. There is no share-link index here.
 *
 * Mounted by `index.ts` at `/api/og` (production-reachable without a vercel.json rewrite) AND at
 * the app root so `/share/:token` resolves locally / in tests. See the evidence file for the
 * explicit crawler-visibility statement.
 */

/** Path the image is served from under the API mount. */
export const OG_IMAGE_PATH = '/api/og/image';

const SHARE_COLUMNS = `name, type, date, calendar_type, person_name, next_occurrence, recurring_config`;

const EVENT_TYPE_LABELS: Record<string, string> = {
  birthday: '生日',
  exam: '考试',
  anniversary: '纪念日',
  holiday: '节日',
  meeting: '会议',
  deadline: '截止日期',
  travel: '旅行',
  graduation: '毕业',
  wedding: '婚礼',
  medical: '医疗',
  other: '重要日子',
};

const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Noto Sans SC', 'Noto Sans CJK SC', sans-serif";

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escape a value for XML/HTML text and attributes, dropping XML-illegal control characters. */
export function escapeXml(value: string): string {
  return value
    .replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch)
    // XML 1.0 forbids most C0 control chars (tab/LF/CR allowed) plus U+FFFE/U+FFFF.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function wrapName(value: string, perLine = 18, maxLines = 2): string[] {
  const chars = codePoints(value);
  const lines: string[] = [];
  for (let i = 0; i < chars.length && lines.length < maxLines; i += perLine) {
    lines.push(chars.slice(i, i + perLine).join(''));
  }
  if (chars.length > perLine * maxLines && lines.length === maxLines) {
    const last = codePoints(lines[maxLines - 1]);
    lines[maxLines - 1] = last.slice(0, Math.max(0, perLine - 1)).join('') + '…';
  }
  return lines.length ? lines : ['TimeMark'];
}

export function eventTypeLabel(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? EVENT_TYPE_LABELS.other;
}

/** Human countdown phrase. Deterministic day granularity — never a wall-clock timestamp. */
export function formatCountdown(days: number): string {
  if (!Number.isFinite(days)) return '重要日子';
  if (days === 0) return '就是今天';
  if (days > 0) return `还有 ${days} 天`;
  return `已过去 ${Math.abs(days)} 天`;
}

export interface OgInput {
  name: string;
  type: string;
  date: string;
  days: number;
}

/**
 * Render the OG image as a self-contained SVG string.
 * Pure function of its input — identical inputs always produce identical bytes.
 */
export function renderOgSvg(input: OgInput): string {
  const name = input.name && input.name.trim() ? input.name.trim() : 'TimeMark';
  const nameLines = wrapName(codePoints(name).slice(0, 80).join(''));
  const countdown = formatCountdown(input.days);
  const typeLabel = eventTypeLabel(input.type);
  const dateText = /^\d{4}-\d{2}-\d{2}/.test(input.date) ? input.date.slice(0, 10) : '';

  const nameTspans = nameLines
    .map(
      (line, idx) =>
        `<text x="112" y="${330 + idx * 54}" font-family="${FONT_STACK}" font-size="44" font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`,
    )
    .join('');

  const dateBlock = dateText
    ? `<text x="112" y="548" font-family="${FONT_STACK}" font-size="28" fill="rgba(255,255,255,0.78)">${escapeXml(dateText)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeXml(`${name} · ${countdown}`)}">
  <title>${escapeXml(name)}</title>
  <defs>
    <linearGradient id="ogbg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4f46e5"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
    <linearGradient id="ogmark" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.12"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#ogbg)"/>
  <circle cx="1010" cy="110" r="260" fill="#ffffff" fill-opacity="0.10"/>
  <circle cx="170" cy="580" r="220" fill="#ffffff" fill-opacity="0.08"/>
  <rect x="64" y="64" width="1072" height="502" rx="44" fill="#ffffff" fill-opacity="0.12" stroke="#ffffff" stroke-opacity="0.24" stroke-width="2"/>
  <rect x="112" y="112" width="64" height="64" rx="18" fill="url(#ogmark)" stroke="#ffffff" stroke-opacity="0.3"/>
  <text x="144" y="156" text-anchor="middle" font-family="${FONT_STACK}" font-size="34" font-weight="800" fill="#ffffff">T</text>
  <text x="196" y="152" font-family="${FONT_STACK}" font-size="30" font-weight="700" fill="#ffffff">TimeMark</text>
  <rect x="112" y="218" width="200" height="46" rx="23" fill="#ffffff" fill-opacity="0.18"/>
  <text x="212" y="248" text-anchor="middle" font-family="${FONT_STACK}" font-size="22" font-weight="600" fill="#ffffff">${escapeXml(typeLabel)}</text>
  ${nameTspans}
  <text x="112" y="492" font-family="${FONT_STACK}" font-size="104" font-weight="800" fill="#ffffff">${escapeXml(countdown)}</text>
  ${dateBlock}
</svg>
`;
}

export interface OgMetaInput extends OgInput {
  token: string;
  origin: string;
}

export interface OgMetaTags {
  title: string;
  description: string;
  imageUrl: string;
  pageUrl: string;
}

/** The exact OG/Twitter values served for a valid token (also the client-side contract). */
export function buildOgMeta(input: OgMetaInput): OgMetaTags {
  const title = `${input.name} · TimeMark`;
  const description = `${formatCountdown(input.days)} · ${eventTypeLabel(input.type)}`;
  const imageUrl = `${input.origin}${OG_IMAGE_PATH}/${encodeURIComponent(input.token)}`;
  return { title, description, imageUrl, pageUrl: `${input.origin}/share/${encodeURIComponent(input.token)}` };
}

/** Server-rendered share document. Crawler-readable OG tags + a styled fallback for humans. */
export function renderShareHtml(input: OgMetaInput): string {
  const meta = buildOgMeta(input);
  const name = escapeXml(input.name);
  const countdown = escapeXml(formatCountdown(input.days));
  const typeLabel = escapeXml(eventTypeLabel(input.type));
  const dateText = /^\d{4}-\d{2}-\d{2}/.test(input.date) ? escapeXml(input.date.slice(0, 10)) : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeXml(meta.title)}</title>
<meta name="robots" content="noindex, nofollow, noarchive"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="TimeMark"/>
<meta property="og:title" content="${escapeXml(meta.title)}"/>
<meta property="og:description" content="${escapeXml(meta.description)}"/>
<meta property="og:image" content="${escapeXml(meta.imageUrl)}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:url" content="${escapeXml(meta.pageUrl)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeXml(meta.title)}"/>
<meta name="twitter:description" content="${escapeXml(meta.description)}"/>
<meta name="twitter:image" content="${escapeXml(meta.imageUrl)}"/>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    font-family: ${FONT_STACK}; background: hsl(210 40% 98%); color: hsl(222 47% 11%); }
  .panel { width: 100%; max-width: 460px; border-radius: 40px; padding: 40px 36px;
    background: rgba(255,255,255,0.8); border: 1px solid #fff; backdrop-filter: blur(48px);
    box-shadow: 0 8px 30px rgba(0,0,0,0.06); }
  .mark { width: 52px; height: 52px; border-radius: 16px; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg,#4f46e5,#7c3aed); color: #fff; font-weight: 800; font-size: 26px; }
  .brand { font-weight: 700; font-size: 18px; margin-left: 12px; }
  .row { display: flex; align-items: center; margin-bottom: 28px; }
  .badge { display: inline-block; font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 999px;
    background: rgba(99,102,241,0.12); color: #4f46e5; margin-bottom: 14px; }
  h1 { font-size: 30px; font-weight: 800; margin: 0 0 18px; line-height: 1.2; }
  .count { font-size: 56px; font-weight: 800; color: #4f46e5; margin: 0; }
  .date { font-size: 16px; color: hsl(215 16% 47%); margin: 14px 0 0; }
  @media (prefers-color-scheme: dark) {
    body { background: hsl(240 10% 4%); color: hsl(210 40% 98%); }
    .panel { background: rgba(24,24,27,0.75); border-color: rgba(255,255,255,0.15); box-shadow: 0 16px 40px rgba(0,0,0,0.5); }
    .count { color: #818cf8; }
    .date { color: hsl(215 20% 72%); }
    .badge { background: rgba(129,140,248,0.16); color: #a5b4fc; }
  }
</style>
</head>
<body>
<main class="panel">
  <div class="row"><div class="mark">T</div><div class="brand">TimeMark</div></div>
  <span class="badge">${typeLabel}</span>
  <h1>${name}</h1>
  <p class="count">${countdown}</p>
  ${dateText ? `<p class="date">${dateText}</p>` : ''}
</main>
</body>
</html>
`;
}

/** Generic 404 document — deliberately leaks nothing about any event. */
export function renderNotFoundHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>TimeMark</title>
<meta name="robots" content="noindex, nofollow, noarchive"/>
</head>
<body>
<h1>TimeMark</h1>
<p>分享链接无效或已失效。</p>
</body>
</html>
`;
}

interface ShareRow {
  name: string | null;
  type: string | null;
  date: Date | string | null;
  next_occurrence: Date | string | null;
  recurring_config: unknown;
}

/**
 * pg returns DATE columns as JS Date objects built at LOCAL midnight
 * (postgres-date uses `new Date(y, m, d)`), so the TZ-correct inverse uses
 * LOCAL getters. `String(date)` would yield the human form ("Mon Oct 05"),
 * and getUTC* / toISOString would shift the day under a positive UTC offset.
 */
function toYmdColumn(value: unknown): string {
  if (value == null || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

function parseRecurring(value: unknown): { enabled?: boolean; frequency?: string } | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as { enabled?: boolean; frequency?: string };
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value as { enabled?: boolean; frequency?: string };
  return null;
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Token lookup is parameterised and returns nothing when unknown/revoked. */
export async function loadSharedEvent(token: string | undefined): Promise<ShareRow | null> {
  if (!token || token.length < 8 || token.length > 200) return null;
  const result = await query(
    `SELECT ${SHARE_COLUMNS} FROM events WHERE share_token = $1 LIMIT 1`,
    [token],
  );
  return (result.rows[0] as ShareRow | undefined) ?? null;
}

export function toOgInput(row: ShareRow, nowYmd = todayYmd()): OgInput {
  const date = toYmdColumn(row.date);
  const next = resolveNextGregorianOccurrence(date || nowYmd, nowYmd, {
    eventType: row.type ?? undefined,
    recurringConfig: parseRecurring(row.recurring_config),
    nextOccurrence: toYmdColumn(row.next_occurrence) || null,
  });
  const days = diffCalendarDays(nowYmd, next);
  return { name: row.name ?? 'TimeMark', type: row.type ?? 'other', date, days };
}

export function resolveOrigin(c: Context): string {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host');
  if (host) return `${proto || 'https'}://${host}`;
  const configured = process.env.CORS_ORIGIN?.split(',')[0]?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  try {
    return new URL(c.req.url).origin;
  } catch {
    return 'https://timemark.app';
  }
}

const ogRoutes = new Hono();

ogRoutes.get('/image/:token', async (c) => {
  const token = c.req.param('token');
  const row = await loadSharedEvent(token);
  if (!row) return c.body(null, 404);

  const svg = renderOgSvg(toOgInput(row));
  const etag = `"${createHash('sha256').update(svg).digest('hex').slice(0, 16)}"`;
  if (c.req.header('if-none-match') === etag) {
    return c.body(null, 304, { ETag: etag });
  }
  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300, s-maxage=300',
    ETag: etag,
  });
});

const serveSharePage = async (c: Context) => {
  const token = c.req.param('token');
  const row = await loadSharedEvent(token);
  if (!row) return c.html(renderNotFoundHtml(), 404);
  const origin = resolveOrigin(c);
  return c.html(renderShareHtml({ ...toOgInput(row), token: token as string, origin }), 200);
};

ogRoutes.get('/share/:token', serveSharePage);

export default ogRoutes;
