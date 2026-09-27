#!/usr/bin/env node
/**
 * Vendors the `chinese-days` dataset (MIT, https://github.com/vsme/chinese-days)
 * into `shared/src/data/` at BUILD time.
 *
 * Pinned release: chinese-days@1.5.9 (data coverage 2004-01-01 .. 2026-12-31).
 *
 * Sources, tried in order:
 *   1. jsDelivr pinned CDN files (the canonical plan source:
 *      https://cdn.jsdelivr.net/npm/chinese-days@1.5.9/dist/chinese-days.json)
 *   2. https://registry.npmmirror.com tarball for the same pinned version
 *   3. https://registry.npmjs.org tarball for the same pinned version
 *
 * Every artifact is verified against the pinned sha256 BEFORE it is written:
 * the dataset JSON itself, and (for tarball sources) the tarball bytes.
 * A tarball from either registry carries byte-identical files to jsDelivr
 * because jsDelivr mirrors npm package contents; the identical dataset sha256
 * proves it regardless of which mirror answered.
 *
 * Usage:
 *   node scripts/fetch-chinese-days.mjs            # ensure vendored (verify, download if missing)
 *   node scripts/fetch-chinese-days.mjs --check    # offline verification only (never touches network)
 *   node scripts/fetch-chinese-days.mjs --force    # re-download even if the vendored copy verifies
 *
 * Exit codes: 0 = vendored + verified; 1 = blocked (no valid vendored file and no reachable source).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'shared', 'src', 'data');
const OUT_JSON = path.join(DATA_DIR, 'chinese-days.json');
const OUT_LICENSE = path.join(DATA_DIR, 'LICENSE.chinese-days');
const OUT_META = path.join(DATA_DIR, 'chinese-days.meta.json');

/** Pinned release + checksums. Changing the dataset REQUIRES updating these pins. */
const PIN = {
  package: 'chinese-days',
  version: '1.5.9',
  repo: 'https://github.com/vsme/chinese-days',
  license: 'MIT',
  /** sha256 of dist/chinese-days.json inside chinese-days@1.5.9 */
  dataSha256: 'f3fa629113ef1e3118a12f411ae1307e6dd7d7142dbf39ac6b98ad35091afc54',
  /** sha256 of the npm tarball chinese-days-1.5.9.tgz */
  tarballSha256: 'e4a1f4a5cefce4309c2266ba0ebe4d6dd9793d4422a6b0c608def1fb3040232d',
  /** sha256 of the MIT LICENSE file shipped in chinese-days@1.5.9 */
  licenseSha256: '729c1349bbec847a466bf86be721e28bc341e39ecb99f743e13598a98217525d',
  /** set in the tarball at package/dist/chinese-days.json */
  tarballDataPath: 'package/dist/chinese-days.json',
  tarballLicensePath: 'package/LICENSE',
};

const CDN_JSON_URL = `https://cdn.jsdelivr.net/npm/${PIN.package}@${PIN.version}/dist/chinese-days.json`;
const CDN_LICENSE_URL = `https://cdn.jsdelivr.net/npm/${PIN.package}@${PIN.version}/LICENSE`;
const TARBALL_URLS = [
  `https://registry.npmmirror.com/${PIN.package}/-/${PIN.package}-${PIN.version}.tgz`,
  `https://registry.npmjs.org/${PIN.package}/-/${PIN.package}-${PIN.version}.tgz`,
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchBuffer(url, timeoutMs = 30000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimal ustar reader — enough for npm tarballs (we only need regular files). */
function untarGz(buffer) {
  const tar = gunzipSync(buffer);
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    if (type === '0' || type === '\0') files.set(rawName, tar.subarray(dataStart, dataStart + size));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function parseDataset(raw) {
  const parsed = JSON.parse(raw.toString('utf8'));
  for (const key of ['holidays', 'workdays', 'inLieuDays']) {
    if (!parsed[key] || typeof parsed[key] !== 'object') {
      throw new Error(`dataset is missing the "${key}" map`);
    }
  }
  const dates = [
    ...Object.keys(parsed.holidays),
    ...Object.keys(parsed.workdays),
    ...Object.keys(parsed.inLieuDays),
  ].sort();
  if (dates.length === 0) throw new Error('dataset contains no dates');
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))]
    .map(Number)
    .sort((a, b) => a - b);
  return {
    parsed,
    minDate: dates[0],
    maxDate: dates[dates.length - 1],
    years,
    counts: {
      holidays: Object.keys(parsed.holidays).length,
      workdays: Object.keys(parsed.workdays).length,
      inLieuDays: Object.keys(parsed.inLieuDays).length,
    },
  };
}

function verifyVendored() {
  if (!existsSync(OUT_JSON) || !existsSync(OUT_META)) return null;
  const raw = readFileSync(OUT_JSON);
  const digest = sha256(raw);
  if (digest !== PIN.dataSha256) return null;
  try {
    const dataset = parseDataset(raw);
    const meta = JSON.parse(readFileSync(OUT_META, 'utf8'));
    return { raw, digest, dataset, meta };
  } catch {
    return null;
  }
}

function writeMeta(source, sourceUrl, extra = {}) {
  const { dataset } = extra;
  const meta = {
    package: PIN.package,
    version: PIN.version,
    repo: PIN.repo,
    license: PIN.license,
    datasetFile: 'chinese-days.json',
    datasetSha256: PIN.dataSha256,
    licenseFile: 'LICENSE.chinese-days',
    licenseSha256: PIN.licenseSha256,
    source,
    sourceUrl,
    tarballSha256: source === 'cdn-jsdelivr' ? null : PIN.tarballSha256,
    yearsCovered: dataset.years,
    minDate: dataset.minDate,
    maxDate: dataset.maxDate,
    counts: dataset.counts,
    note: 'Vendored by scripts/fetch-chinese-days.mjs. Do not hand-edit; re-run the script (checksum-pinned).',
  };
  writeFileSync(OUT_META, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

async function download() {
  const errors = [];

  // 1) canonical jsDelivr pinned file
  try {
    const raw = await fetchBuffer(CDN_JSON_URL);
    const digest = sha256(raw);
    if (digest !== PIN.dataSha256) {
      throw new Error(`sha256 mismatch from jsDelivr: got ${digest}, expected ${PIN.dataSha256}`);
    }
    const dataset = parseDataset(raw);
    let license = null;
    try {
      const licenseRaw = await fetchBuffer(CDN_LICENSE_URL);
      if (sha256(licenseRaw) !== PIN.licenseSha256) {
        throw new Error('LICENSE sha256 mismatch');
      }
      license = licenseRaw;
    } catch (error) {
      console.warn(
        `[chinese-days] WARNING: LICENSE could not be vendored from jsDelivr (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return { raw, dataset, source: 'cdn-jsdelivr', sourceUrl: CDN_JSON_URL, license };
  } catch (error) {
    errors.push(`jsDelivr: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2) npm registry tarballs (jsDelivr was unreachable / corrupt)
  for (const url of TARBALL_URLS) {
    try {
      const tarball = await fetchBuffer(url, 60000);
      const tarballDigest = sha256(tarball);
      if (tarballDigest !== PIN.tarballSha256) {
        throw new Error(`tarball sha256 mismatch: got ${tarballDigest}, expected ${PIN.tarballSha256}`);
      }
      const files = untarGz(tarball);
      const raw = files.get(PIN.tarballDataPath);
      if (!raw) throw new Error(`tarball is missing ${PIN.tarballDataPath}`);
      const digest = sha256(raw);
      if (digest !== PIN.dataSha256) {
        throw new Error(`dataset sha256 mismatch: got ${digest}, expected ${PIN.dataSha256}`);
      }
      const dataset = parseDataset(raw);
      const license = files.get(PIN.tarballLicensePath) ?? null;
      if (license && sha256(license) !== PIN.licenseSha256) {
        throw new Error('LICENSE sha256 mismatch inside tarball');
      }
      return { raw, dataset, source: 'npm-registry-tarball', sourceUrl: url, license };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const blocker = errors.join(' | ');
  throw new Error(
    `BLOCKED: chinese-days@${PIN.version} could not be fetched and verified.\n` +
      `  Tried: ${[CDN_JSON_URL, ...TARBALL_URLS].join(', ')}\n` +
      `  Errors: ${blocker}\n` +
      `  To complete from a networked machine: node scripts/fetch-chinese-days.mjs --force`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const force = args.includes('--force');

  const vendored = force ? null : verifyVendored();
  if (vendored) {
    console.log(
      `[chinese-days] vendored copy verified (sha256 ${vendored.digest.slice(0, 12)}..., ` +
        `years ${vendored.meta.yearsCovered[0]}-${vendored.meta.yearsCovered.at(-1)}, ` +
        `${vendored.dataset.counts.holidays} holidays / ${vendored.dataset.counts.workdays} workdays / ${vendored.dataset.counts.inLieuDays} in-lieu days)`,
    );
    return;
  }

  if (checkOnly) {
    console.error(
      `[chinese-days] CHECK FAILED: ${OUT_JSON} is missing or does not match the pinned sha256 ${PIN.dataSha256}.\n` +
        `  Run: node scripts/fetch-chinese-days.mjs --force`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await download();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT_JSON, result.raw);
  if (result.license) writeFileSync(OUT_LICENSE, result.license);
  writeMeta(result.source, result.sourceUrl, { dataset: result.dataset });
  console.log(
    `[chinese-days] vendored chinese-days@${PIN.version} from ${result.source}\n` +
      `  -> ${path.relative(ROOT, OUT_JSON)} (sha256 ${PIN.dataSha256.slice(0, 12)}...)\n` +
      `  -> ${path.relative(ROOT, OUT_META)}\n` +
      `  coverage: ${result.dataset.minDate} .. ${result.dataset.maxDate} (years ${result.dataset.years[0]}-${result.dataset.years.at(-1)})`,
  );
}

main().catch((error) => {
  console.error(`[chinese-days] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
