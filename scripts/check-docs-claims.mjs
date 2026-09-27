#!/usr/bin/env node
/**
 * Docs/code contradiction guard (todo 38).
 *
 * Fails when:
 *  1. A doc claims the notification send path does not enqueue retries
 *     (`尚未在失败时自动入队` / `不会自动入队` / `不自动入队` in docs/ or root *.md).
 *  2. `docs/OPTIMIZATION_PLAN.md` stops documenting the real retry behaviour
 *     (`notification_queue`, 5m/30m/2h/6h backoff, `/api/cron/retry-notifications`).
 *  3. A row of the OPTIMIZATION_PLAN "后续优化建议" table is neither marked
 *     `已完成` nor `未完成`.
 *  4. A README.md 更新日志 version row is missing a date (or v2.17.0 is gone).
 *  5. A CHANGELOG.md version block header is missing a date.
 *
 * Usage: node scripts/check-docs-claims.mjs [rootDir]
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
// 1. No doc may claim failure does not enqueue a retry.
// ---------------------------------------------------------------------------
const FORBIDDEN_CLAIMS = ['尚未在失败时自动入队', '不会自动入队', '不自动入队'];

const scanTargets = [
  ...collectMarkdown(path.join(rootDir, 'docs')),
  ...readdirSync(rootDir)
    .filter((entry) => entry.endsWith('.md') && statSync(path.join(rootDir, entry)).isFile())
    .map((entry) => path.join(rootDir, entry)),
];

const violations = [];
for (const file of scanTargets) {
  const content = readFileSync(file, 'utf8');
  for (const claim of FORBIDDEN_CLAIMS) {
    if (content.includes(claim)) violations.push(`${path.relative(rootDir, file)}: "${claim}"`);
  }
}
check(
  'no doc claims the send path skips retry enqueueing',
  violations.length === 0,
  violations.join('; '),
);

// ---------------------------------------------------------------------------
// 2. OPTIMIZATION_PLAN must describe the real retry enqueueing.
// ---------------------------------------------------------------------------
const plan = read('docs/OPTIMIZATION_PLAN.md') ?? '';
check('OPTIMIZATION_PLAN mentions notification_queue', plan.includes('notification_queue'));
check(
  'OPTIMIZATION_PLAN documents the 5m/30m/2h/6h backoff',
  /5\s*分钟[\s\S]{0,40}?30\s*分钟[\s\S]{0,40}?2\s*小时[\s\S]{0,40}?6\s*小时/.test(plan),
);
check(
  'OPTIMIZATION_PLAN documents /api/cron/retry-notifications',
  plan.includes('/api/cron/retry-notifications'),
);

// ---------------------------------------------------------------------------
// 3. Follow-up table rows annotated done or outstanding.
// ---------------------------------------------------------------------------
const followUpStart = plan.indexOf('## 后续优化建议');
const followUpEnd = followUpStart === -1 ? -1 : plan.indexOf('\n---', followUpStart);
const followUpBlock =
  followUpStart === -1 ? '' : plan.slice(followUpStart, followUpEnd === -1 ? undefined : followUpEnd);

const tableRows = followUpBlock
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.startsWith('|'))
  .filter((line) => !line.includes('优先级'))
  .filter((line) => !/^\|[\s|:-]+\|$/.test(line));

check('OPTIMIZATION_PLAN follow-up table has rows', tableRows.length >= 6, `rows=${tableRows.length}`);

const unmarkedRows = tableRows.filter((row) => !row.includes('已完成') && !row.includes('未完成'));
check(
  'every follow-up table row is marked 已完成/未完成',
  unmarkedRows.length === 0,
  unmarkedRows.join(' | '),
);

for (const topic of ['HttpOnly', '冲突检测', '渠道配置合并']) {
  const row = tableRows.find((candidate) => candidate.includes(topic));
  check(`follow-up row "${topic}" is annotated 已完成`, Boolean(row && row.includes('已完成')));
}

// ---------------------------------------------------------------------------
// 4. README changelog rows must carry a date.
// ---------------------------------------------------------------------------
const readme = read('README.md') ?? '';
const readmeChangelogStart = readme.indexOf('## 📝 更新日志');
const readmeChangelog = readmeChangelogStart === -1 ? '' : readme.slice(readmeChangelogStart);
const DATE_RE = /^20\d{2}-\d{2}(-\d{2})?$/;

const versionRows = readmeChangelog
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.startsWith('| **v') || line.startsWith('| v'));

check('README changelog has version rows', versionRows.length > 0, `rows=${versionRows.length}`);

const missingDates = [];
for (const row of versionRows) {
  const cells = row.split('|').map((cell) => cell.trim());
  const version = cells[1];
  const date = cells[2];
  if (!DATE_RE.test(date ?? '')) missingDates.push(`${version || '?'} -> "${date ?? ''}"`);
}
check('every README changelog row has a date', missingDates.length === 0, missingDates.join('; '));
check(
  'README changelog contains v2.17.0 with a date',
  versionRows.some((row) => {
    const cells = row.split('|').map((cell) => cell.trim());
    return /v2\.17\.0/.test(cells[1] ?? '') && DATE_RE.test(cells[2] ?? '');
  }),
);

// ---------------------------------------------------------------------------
// 5. CHANGELOG.md version blocks must carry a date.
// ---------------------------------------------------------------------------
const changelog = read('CHANGELOG.md') ?? '';
const changelogHeaders = changelog
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^##\s+v\d/.test(line));

check('CHANGELOG.md has version blocks', changelogHeaders.length > 0, `blocks=${changelogHeaders.length}`);
const datelessHeaders = changelogHeaders.filter((header) => !/\(20\d{2}-\d{2}(-\d{2})?\)/.test(header));
check('every CHANGELOG.md version block has a date', datelessHeaders.length === 0, datelessHeaders.join('; '));
check(
  'CHANGELOG.md contains a v2.17.0 block with a date',
  changelogHeaders.some((header) => /v2\.17\.0/.test(header) && /\(20\d{2}-\d{2}(-\d{2})?\)/.test(header)),
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
