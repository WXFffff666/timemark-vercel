#!/usr/bin/env node
/**
 * Cron topology + deployment-config guard (plan checkbox 87).
 *
 * Sibling of scripts/check-docs-claims.mjs — same report/exit-code style.
 *
 * Fails when:
 *  1. `vercel.json` does not parse as JSON (a trailing comma must fail loudly).
 *  2. The API function (`api/index.js`) `maxDuration` is not 300 (the Vercel Hobby max).
 *  3. A `vercel.json` cron expression could run more than once per day — Vercel Hobby
 *     rejects sub-daily expressions at deploy time, so the only safe precision is
 *     "once per day or sparser" (fixed minute + fixed hour fields).
 *  4. A `vercel.json` cron path does not target `/api/cron/*`.
 *  5. `docs/CRON.md` is missing or has no route table carrying a frequency column.
 *  6. The route list in `docs/CRON.md` is not EXACTLY the list of routes extracted from
 *     `backend/src/routes/cron.ts` — missing routes and unexpected routes are named.
 *  7. A documented cron route has an empty frequency cell (fails NAMING that route),
 *     or a route is documented more than once.
 *  8. Any doc claims a sub-daily schedule runs on Vercel's built-in cron. Detection is
 *     line-scoped: a line that mentions Vercel AND a sub-daily cadence is a violation
 *     unless it also carries an escape — an external scheduler (cron-job.org / 外部 /
 *     external), a limitation phrasing (无法/不能/失败/not supported/…), an at-most-daily
 *     phrasing (once per day / 每天 1 次 / …), or a "not scheduled / not used" phrasing.
 *     `vercel.json` itself cannot express sub-daily at all (check 3 enforces that).
 *  9. The deployment contracts touched by checkbox 87/88 regress: the `/share/:token`
 *     rewrite must exist, target the API function, and precede the SPA catch-all; the
 *     `/api/(.*)` rewrite, the SPA fallback, the CSP header and the X-Robots-Tag
 *     noindex header must all survive; `docs/CRON.md` must document the share rewrite
 *     and the `/embed/:token` exemption.
 *
 * Usage: node scripts/check-cron-docs.mjs [rootDir]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..'));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
}

function read(relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : null;
}

function collectMarkdown(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      found.push(...collectMarkdown(fullPath));
    } else if (entry.endsWith('.md')) {
      found.push(fullPath);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1-4. vercel.json parsing, function budget, cron safety.
// ---------------------------------------------------------------------------
const vercelRaw = read('vercel.json');
let vercel = null;
let vercelError = 'vercel.json is missing';
if (vercelRaw !== null) {
  try {
    vercel = JSON.parse(vercelRaw);
    vercelError = '';
  } catch (error) {
    vercelError = error instanceof Error ? error.message : String(error);
  }
}
check('vercel.json parses as JSON', vercel !== null, vercelError);

const apiFunction = vercel?.functions?.['api/index.js'];
check(
  'vercel.json sets functions["api/index.js"].maxDuration to 300',
  apiFunction?.maxDuration === 300,
  `actual=${JSON.stringify(apiFunction?.maxDuration)}`,
);

const crons = Array.isArray(vercel?.crons) ? vercel.crons : [];
check('vercel.json declares at least one cron entry', crons.length > 0);

const subDailyCrons = [];
const offPathCrons = [];
for (const entry of crons) {
  const schedule = String(entry?.schedule ?? '').trim();
  const fields = schedule.split(/\s+/);
  const fixedMinute = fields.length === 5 && /^\d+$/.test(fields[0] ?? '');
  const fixedHour = fields.length === 5 && /^\d+$/.test(fields[1] ?? '');
  if (!fixedMinute || !fixedHour) {
    subDailyCrons.push(`${entry?.path} -> "${entry?.schedule}"`);
  }
  if (!String(entry?.path ?? '').startsWith('/api/cron/')) {
    offPathCrons.push(String(entry?.path));
  }
}
check(
  'every vercel.json cron runs at most once per day (Hobby rejects sub-daily)',
  subDailyCrons.length === 0,
  subDailyCrons.join('; '),
);
check('every vercel.json cron path targets /api/cron/*', offPathCrons.length === 0, offPathCrons.join('; '));

// ---------------------------------------------------------------------------
// 5-7. docs/CRON.md route table parity with backend/src/routes/cron.ts.
// ---------------------------------------------------------------------------
const cronSource = read('backend/src/routes/cron.ts');
const codeRoutes = new Set();
if (cronSource) {
  for (const match of cronSource.matchAll(/cronRoutes\.(?:get|post|put|delete|patch)\(\s*'\/([a-z0-9-]+)'/g)) {
    codeRoutes.add(match[1]);
  }
}
check(
  'backend/src/routes/cron.ts exposes cron routes',
  codeRoutes.size > 0,
  `extracted=${codeRoutes.size}`,
);

const cronDoc = read('docs/CRON.md');
check('docs/CRON.md exists', cronDoc !== null, cronDoc === null ? 'docs/CRON.md not found' : '');

const docLines = (cronDoc ?? '').split(/\r?\n/);
let headerIndex = -1;
for (let i = 0; i < docLines.length; i += 1) {
  const line = docLines[i].trim();
  if (!line.startsWith('|')) continue;
  if (line.includes('频率') && (line.includes('路由') || line.includes('URL'))) {
    headerIndex = i;
    break;
  }
}
check(
  'docs/CRON.md has a cron route table with a frequency column',
  headerIndex !== -1,
  headerIndex === -1 ? 'no table header containing both 路由/URL and 频率' : '',
);

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const docRoutes = new Map();
const duplicateRoutes = [];
const emptyFrequencyRoutes = [];
if (headerIndex !== -1) {
  const headerCells = splitRow(docLines[headerIndex]);
  const routeCol = headerCells.findIndex((cell) => cell.includes('路由') || cell.includes('URL'));
  const frequencyCol = headerCells.findIndex((cell) => cell.includes('频率'));

  for (let i = headerIndex + 1; i < docLines.length; i += 1) {
    const line = docLines[i].trim();
    if (!line.startsWith('|')) break;
    if (/^\|[\s|:-]+\|$/.test(line)) continue;

    const cells = splitRow(line);
    const routeCell = cells[routeCol] ?? '';
    const routeMatch = routeCell.match(/\/api\/cron\/([a-z0-9-]+)/);
    if (!routeMatch) continue;
    const route = routeMatch[1];

    if (docRoutes.has(route)) {
      duplicateRoutes.push(route);
      continue;
    }
    const frequency = (cells[frequencyCol] ?? '').replace(/`/g, '').trim();
    docRoutes.set(route, frequency);
    if (!frequency) emptyFrequencyRoutes.push(route);
  }
}

const missingFromDoc = [...codeRoutes].filter((route) => !docRoutes.has(route)).sort();
const unexpectedInDoc = [...docRoutes.keys()].filter((route) => !codeRoutes.has(route)).sort();
check(
  'docs/CRON.md documents every cron route in backend/src/routes/cron.ts',
  missingFromDoc.length === 0,
  missingFromDoc.map((route) => `/api/cron/${route}`).join('; '),
);
check(
  'docs/CRON.md documents no route missing from backend/src/routes/cron.ts',
  unexpectedInDoc.length === 0,
  unexpectedInDoc.map((route) => `/api/cron/${route}`).join('; '),
);
check(
  'every documented cron route has a frequency',
  emptyFrequencyRoutes.length === 0,
  emptyFrequencyRoutes.map((route) => `/api/cron/${route}`).join('; '),
);
check(
  'no cron route is documented more than once',
  duplicateRoutes.length === 0,
  duplicateRoutes.map((route) => `/api/cron/${route}`).join('; '),
);

// ---------------------------------------------------------------------------
// 8. No doc may claim a sub-daily schedule runs on Vercel's built-in cron.
// ---------------------------------------------------------------------------
const SUB_DAILY_RE =
  /(每分钟|每秒|每小时|分钟级|每\s*\d+\s*(?:分钟|小时|秒)|every\s+\d+\s*(?:min\b|minute|hour|second)|every\s+(?:minute|hour)|hourly|minutely|\*\/\d+\s+\*\s+\*\s+\*\s+\*)/i;
const VERCEL_RE = /vercel/i;
const ESCAPE_RE =
  /(cron-job\.org|cronjob\.org|外部|external|not used|未使用|未调度|不参与|不再|无法|不能|不支持|做不到|失败|fail|impossible|cannot|can't|won't|not supported|once per day|每天[^|\n]{0,8}(?:1|一)\s*次|每日一次|一天一次|最小间隔|minimum interval)/i;

const scanTargets = [
  ...collectMarkdown(path.join(rootDir, 'docs')),
  ...readdirSync(rootDir)
    .filter((entry) => entry.endsWith('.md') && statSync(path.join(rootDir, entry)).isFile())
    .map((entry) => path.join(rootDir, entry)),
];

const claimViolations = [];
for (const file of scanTargets) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (SUB_DAILY_RE.test(line) && VERCEL_RE.test(line) && !ESCAPE_RE.test(line)) {
      claimViolations.push(`${path.relative(rootDir, file)}:${index + 1}: ${line.trim().slice(0, 160)}`);
    }
  });
}
check(
  'no doc claims a sub-daily schedule runs on Vercel built-in cron',
  claimViolations.length === 0,
  claimViolations.join(' | '),
);

// ---------------------------------------------------------------------------
// 9. The checkbox 87/88 deployment contracts.
// ---------------------------------------------------------------------------
const rewrites = Array.isArray(vercel?.rewrites) ? vercel.rewrites : [];
const shareRewriteIndex = rewrites.findIndex((rewrite) => String(rewrite?.source ?? '').startsWith('/share/'));
const spaRewriteIndex = rewrites.findIndex((rewrite) => rewrite?.destination === '/index.html');
const apiRewriteIndex = rewrites.findIndex((rewrite) => rewrite?.source === '/api/(.*)');
const shareRewrite = shareRewriteIndex === -1 ? null : rewrites[shareRewriteIndex];

check(
  'vercel.json rewrites /share/:token to the API function',
  Boolean(shareRewrite) && shareRewrite.destination === '/api/index' && /^\/share\/:[a-z]+$/.test(String(shareRewrite.source)),
  shareRewrite ? `source=${shareRewrite.source} destination=${shareRewrite.destination}` : 'no /share/* rewrite',
);
check(
  'the /share/:token rewrite precedes the SPA catch-all',
  shareRewriteIndex !== -1 && spaRewriteIndex !== -1 && shareRewriteIndex < spaRewriteIndex,
  `shareIndex=${shareRewriteIndex} spaIndex=${spaRewriteIndex}`,
);
check(
  'the /api/(.*) rewrite and the SPA fallback are preserved',
  apiRewriteIndex !== -1 && spaRewriteIndex !== -1,
  `apiIndex=${apiRewriteIndex} spaIndex=${spaRewriteIndex}`,
);

const serializedHeaders = JSON.stringify(vercel?.headers ?? []);
check(
  'the CSP header is preserved in vercel.json',
  serializedHeaders.includes('Content-Security-Policy') && serializedHeaders.includes("default-src 'self'"),
);
check(
  'the X-Robots-Tag noindex header is preserved in vercel.json',
  serializedHeaders.includes('X-Robots-Tag') && serializedHeaders.includes('noindex'),
);
check(
  'docs/CRON.md documents the share rewrite and the /embed/:token exemption',
  (cronDoc ?? '').includes('/share/:token') && (cronDoc ?? '').includes('/embed/:token'),
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
for (const item of checks) {
  const mark = item.ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${item.name}${item.ok || !item.detail ? '' : ` — ${item.detail}`}`);
}

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed (root: ${rootDir})`);
process.exit(failed.length === 0 ? 0 : 1);
