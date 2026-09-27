#!/usr/bin/env node
/**
 * Build-time generator for the vendored PDF report font (checkbox 74).
 *
 * The doctor-ready report must render Chinese without any network access at
 * request time, so the CJK font is subset ONCE here and committed as a base64
 * module (`src/assets/pdf-font-subset.ts`), which keeps local dev, vitest and
 * the esbuild-bundled Vercel function identical (no runtime fs/loader tricks).
 *
 * Source font: Noto Sans SC Regular (SIL OFL 1.1) from the noto-cjk project
 *   https://github.com/notofonts/noto-cjk (release Sans2.004, 18_NotoSansSC.zip)
 * Subsetting: fontTools `pyftsubset` (pip install fonttools brotli)
 *
 * Usage:
 *   node scripts/build-pdf-font-subset.mjs --source C:/path/NotoSansSC-Regular.otf
 *
 * The emitted subset covers ASCII + Latin-1 + the full GB2312 repertoire
 * (decoded via TextDecoder('gb2312')) + every fixed character used by the
 * report templates, with hinting stripped to keep the asset small.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourcePath = argValue('--source');
if (!sourcePath) {
  console.error('usage: node scripts/build-pdf-font-subset.mjs --source <NotoSansSC-Regular.otf>');
  process.exit(2);
}
const outPath = argValue('--out') ?? join(backendRoot, 'src/assets/pdf-font-subset.ts');

/** Fixed strings used by the report HTML / PDF / tests - every character must exist in the subset. */
const REPORT_STRINGS = [
  '用药依从性报告患者档案全部档案报告期间日期范围依从率',
  '已服用跳过漏服未记录无记录补货提醒库存预计可维持天数低库存',
  '药品名称剂型规格用法计划时刻开始日期结束日期状态启用停用',
  '每日明细合计次数百分比连续达标天数生成仅供参考不构成医疗建议',
  '星期一星期二星期三星期四星期五星期六星期日共条',
  '本报告仅统计已结算剂量（已服/跳过/漏服），不做任何医疗判断',
].join('');

const chars = new Set();

// ASCII printable
for (let cp = 0x20; cp <= 0x7e; cp += 1) chars.add(String.fromCodePoint(cp));

// Latin-1 supplement + the punctuation the report actually uses
for (let cp = 0xa0; cp <= 0xff; cp += 1) chars.add(String.fromCodePoint(cp));
for (const cp of [
  0x2013, 0x2014, 0x2015, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x2027,
  0x2212, 0x2248, 0x2264, 0x2265, 0x25a0, 0x25cf, 0x2713, 0x2717,
  0x3000, 0x3001, 0x3002, 0x3008, 0x3009, 0x300a, 0x300b, 0x3010, 0x3011,
  0xff01, 0xff05, 0xff08, 0xff09, 0xff0c, 0xff0e, 0xff1a, 0xff1b, 0xff1d, 0xff1f, 0xff5e,
]) {
  chars.add(String.fromCodePoint(cp));
}

// Full GB2312 repertoire (the decoder alias covers GBK's two-byte A1..F7 range too)
const gbDecoder = new TextDecoder('gb2312');
for (let b1 = 0xa1; b1 < 0xf8; b1 += 1) {
  for (let b2 = 0xa1; b2 < 0xff; b2 += 1) {
    const decoded = gbDecoder.decode(new Uint8Array([b1, b2]));
    if (decoded && !decoded.includes('\uFFFD')) chars.add(decoded);
  }
}

for (const ch of REPORT_STRINGS) chars.add(ch);

const work = mkdtempSync(join(tmpdir(), 'timemark-font-'));
const textFile = join(work, 'charset.txt');
const subsetFile = join(work, 'subset.otf');
writeFileSync(textFile, [...chars].sort().join(''), 'utf8');

console.log(`[font-subset] charset=${chars.size} chars`);
execFileSync(
  'python',
  [
    '-m', 'fontTools.subset', sourcePath,
    `--text-file=${textFile}`,
    `--output-file=${subsetFile}`,
    '--no-hinting',
    '--desubroutinize',
    '--layout-features=',
    '--name-IDs=1,2,3,4,5,6',
    '--drop-tables+=GSUB,GPOS,GDEF,DSIG',
  ],
  { stdio: 'inherit' },
);

const sourceBytes = readFileSync(sourcePath);
const subsetBytes = readFileSync(subsetFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const chunkSize = 1023;
const chunks = [];
for (let i = 0; i < subsetBytes.length; i += chunkSize) {
  chunks.push(subsetBytes.subarray(i, i + chunkSize).toString('base64'));
}

const header = `/**
 * GENERATED FILE - do not edit by hand. Noto Sans SC subset for the medication
 * adherence report (checkbox 74). Regenerate with:
 *   node backend/scripts/build-pdf-font-subset.mjs --source <NotoSansSC-Regular.otf>
 *
 * Source: Noto Sans SC Regular (sil OFL 1.1, license in ./LICENSE-NotoSansSC.txt)
 *   notofonts/noto-cjk release Sans2.004 / 18_NotoSansSC.zip
 * Source sha256: ${sha(sourceBytes)}
 * Subset  sha256: ${sha(subsetBytes)}
 * Subset  bytes:  ${subsetBytes.length}
 * Repertoire: ASCII + Latin-1 + GB2312 + report template characters, hinting stripped.
 */
`;

const moduleSource = `${header}
export const PDF_FONT_OTF_BASE64: string = [
${chunks.map((chunk) => `  '${chunk}',`).join('\n')}
].join('');
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, moduleSource, 'utf8');
console.log(`[font-subset] wrote ${outPath} (${moduleSource.length} bytes source)`);