#!/usr/bin/env node
/**
 * Build-time STATIC SEARCH INDEX (plan todo 76c).
 *
 * Indexes every static corpus with MiniSearch and emits ONE JSON file that the
 * client lazy-loads — so static lookups cost zero runtime queries to the API:
 *
 *   - statutory holidays / 调休 (shared/src/data/chinese-days.json)
 *   - 节气 / 黄历 rules        (shared/src/data/almanac-rules.json)
 *   - notification templates  (shared/dist/templates.js, …/notification-presets.js)
 *   - relationship mappings   (shared/dist/relationship.js)
 *   - help/docs               (docs/*.md, section-level snippets)
 *
 * The serialized index is asserted against a size budget:
 *   <= 200 KiB uncompressed AND <= 50 KiB gzipped (defaults).
 * The build FAILS (exit 1) when either budget is exceeded.
 * Override for diagnostics/negative-control only:
 *   --max-uncompressed-kb=N --max-gzip-kb=N
 *
 * Emitted to frontend/public/search-index.json so both `vite` (dev/e2e) and
 * `vite build` serve it as a static asset.
 *
 * Prerequisite: `pnpm --filter @timemark/shared build` (the templates/relations
 * corpora are imported from the compiled shared package, same as the frontend app).
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const OUT_FILE = path.join(FRONTEND, 'public', 'search-index.json');
const DOCS_DIR = path.join(ROOT, 'docs');
const SHARED_DIST = path.join(ROOT, 'shared', 'dist');

/** Section snippet length for help/docs (the full docs stay on disk; the index is discovery). */
const DOC_SNIPPET_CHARS = 120;

const require = createRequire(path.join(FRONTEND, 'package.json'));
const MiniSearch = require('minisearch');
const { tokenize } = await import(pathToFileURL(path.join(FRONTEND, 'src', 'lib', 'search-tokenizer.mjs')).href);

const INDEX_OPTIONS = {
  fields: ['title', 'text'],
  storeFields: ['kind', 'title'],
  idField: 'id',
  tokenize,
};

function parseArg(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(name.length + 3));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid --${name}: ${arg}`);
  return value;
}

function readJson(file, label) {
  if (!existsSync(file)) throw new Error(`${label} missing at ${path.relative(ROOT, file)}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function importShared(moduleName) {
  const file = path.join(SHARED_DIST, `${moduleName}.js`);
  if (!existsSync(file)) {
    throw new Error(
      `shared build missing: ${path.relative(ROOT, file)} — run \`pnpm --filter @timemark/shared build\` first`,
    );
  }
  return import(pathToFileURL(file).href);
}

function buildHolidayDocs(dataset, documents) {
  // Group consecutive statutory-holiday days sharing a name into one 假期块 (155 docs
  // for 2004-2026 instead of 619 day-docs) — lookup by name, not by date, is the job
  // of a search index (exact date status comes from @timemark/shared/chinese-days).
  const dates = Object.keys(dataset.holidays).sort();
  let block = null;
  const blocks = [];
  for (const date of dates) {
    const [en, zh] = dataset.holidays[date].split(',');
    const time = Date.parse(`${date}T00:00:00Z`);
    if (block && block.zh === zh && time - block.lastTime === 86_400_000) {
      block.end = date;
      block.lastTime = time;
      block.days += 1;
    } else {
      block = { zh, en, start: date, end: date, lastTime: time, days: 1 };
      blocks.push(block);
    }
  }
  for (const b of blocks) {
    const inLieu = dataset.inLieuDays[b.start] ? ' 补休' : '';
    documents.push({
      id: `holiday:${b.start}`,
      kind: 'holiday',
      title: `${b.start}~${b.end} ${b.zh}`,
      text: `${b.en} ${b.zh} 法定节假日 放假${b.days}天${inLieu}`,
    });
  }
  for (const [date, raw] of Object.entries(dataset.workdays)) {
    const [en, zh] = raw.split(',');
    documents.push({
      id: `workday:${date}`,
      kind: 'workday',
      title: `${date} ${zh} 调休上班`,
      text: `${en} ${zh} 调休 补班`,
    });
  }
}

function buildAlmanacDocs(rules, documents) {
  for (const term of rules.solarTerms) {
    documents.push({ id: `solar-term:${term.name}`, kind: 'solar-term', title: `节气 ${term.name}`, text: term.description });
  }
  for (const star of rules.zhiXing) {
    documents.push({ id: `zhixing:${star.name}`, kind: 'almanac-rule', title: `值星 ${star.name}`, text: star.meaning });
  }
  for (const rule of rules.almanacRules) {
    documents.push({ id: `rule:${rule.name}`, kind: 'almanac-rule', title: rule.name, text: rule.description });
  }
  for (const position of rules.auspiciousPositions) {
    documents.push({ id: `position:${position.name}`, kind: 'almanac-rule', title: position.name, text: position.description });
  }
}

function buildTemplateDocs(templates, presets, documents) {
  for (const [i, template] of templates.PRESET_TEMPLATES.entries()) {
    documents.push({
      id: `template:${template.id}:${i}`,
      kind: 'template',
      title: template.name,
      text: `${template.description ?? ''} ${template.content}`,
    });
  }
  for (const preset of presets.NOTIFICATION_PRESET_LIST) {
    documents.push({
      id: `preset:${preset.id}`,
      kind: 'preset',
      title: preset.label,
      text: `${preset.description} ${preset.tiers.map((tier) => tier.channels.join(' ')).join(' ')}`,
    });
  }
}

function buildRelationDocs(relationship, documents) {
  for (const relation of relationship.COMMON_RELATIONS) {
    documents.push({
      id: `relation:${relation.from}`,
      kind: 'relation',
      title: `${relation.from} → ${relation.to}`,
      text: `称呼映射 关系 ${relation.from} ${relation.to}`,
    });
  }
  for (const relation of relationship.PRESET_RELATIONS) {
    documents.push({
      id: `relation-type:${relation.value}`,
      kind: 'relation',
      title: relation.label,
      text: `关系类型 ${relation.label}`,
    });
  }
}

function buildDocDocs(documents) {
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const text = readFileSync(path.join(DOCS_DIR, file), 'utf8');
    text.split(/^## /m).forEach((section, i) => {
      const heading = section.split('\n')[0].trim();
      const body = section
        .replace(/[#>*`|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, DOC_SNIPPET_CHARS);
      if (!body) return;
      documents.push({
        id: `doc:${file}:${i}`,
        kind: 'doc',
        title: `${file} ${heading}`,
        text: body,
      });
    });
  }
  return files.length;
}

async function buildPayload() {
  const dataset = readJson(path.join(ROOT, 'shared', 'src', 'data', 'chinese-days.json'), 'chinese-days dataset');
  const almanacRules = readJson(path.join(ROOT, 'shared', 'src', 'data', 'almanac-rules.json'), 'almanac rules');
  const templates = await importShared('templates');
  const presets = await importShared('notification-presets');
  const relationship = await importShared('relationship');

  const documents = [];
  buildHolidayDocs(dataset, documents);
  buildAlmanacDocs(almanacRules, documents);
  buildTemplateDocs(templates, presets, documents);
  buildRelationDocs(relationship, documents);
  const docFileCount = buildDocDocs(documents);

  const index = new MiniSearch(INDEX_OPTIONS);
  index.addAll(documents);
  const serialized = index.toJSON();
  const payload = {
    meta: {
      generator: 'scripts/build-search-index.mjs',
      corpora: ['holidays', 'workdays', 'solar-terms', 'almanac-rules', 'templates', 'presets', 'relations', 'docs'],
      documents: documents.length,
      docFiles: docFileCount,
      tokenizer: 'cjk-bigram+latin',
      minisearch: readJson(path.join(FRONTEND, 'node_modules', 'minisearch', 'package.json'), 'minisearch package').version,
    },
    index: serialized,
  };
  const json = JSON.stringify(payload);
  return { payload, json };
}

async function main() {
  const maxUncompressedKb = parseArg('max-uncompressed-kb', 200);
  const maxGzipKb = parseArg('max-gzip-kb', 50);
  const checkOnly = process.argv.includes('--check');

  const { payload, json } = await buildPayload();
  const rawBytes = Buffer.byteLength(json);
  const gzipBytes = gzipSync(Buffer.from(json)).length;
  const rawKb = rawBytes / 1024;
  const gzipKb = gzipBytes / 1024;
  const limitRaw = maxUncompressedKb * 1024;
  const limitGzip = maxGzipKb * 1024;

  const stats = [
    `documents=${payload.meta.documents}`,
    `uncompressed=${rawKb.toFixed(1)}KiB (limit ${maxUncompressedKb}KiB)`,
    `gzip=${gzipKb.toFixed(1)}KiB (limit ${maxGzipKb}KiB)`,
  ];

  if (rawBytes > limitRaw || gzipBytes > limitGzip) {
    console.error(`[search-index] FAIL: ${stats.join(' | ')}`);
    throw new Error(
      `static search index exceeds budget (max ${maxUncompressedKb}KiB raw / ${maxGzipKb}KiB gzip)`,
    );
  }

  if (!checkOnly) {
    mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    const previous = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : null;
    if (previous !== json) writeFileSync(OUT_FILE, json);
  }
  console.log(`[search-index] OK: ${stats.join(' | ')} -> ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((error) => {
  console.error(`[search-index] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
