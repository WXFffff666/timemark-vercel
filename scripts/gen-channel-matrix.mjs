#!/usr/bin/env node
/**
 * 生成 docs/CHANNEL_MATRIX.md —— 渠道目录唯一数据源的可视化产物。
 *
 * 数据来源（运行时真值，全部现场解析，无硬编码）：
 *   - backend/src/services/notifications/channels.config.ts  → getSupportedChannelTemplates()
 *   - backend/src/services/notifications/supported-channels.ts → UNSUPPORTED_CHANNEL_IDS / SERVERLESS_NOTES
 *   - backend/src/services/notifications/test-connection.ts   → 连接测试分支（解析 case 标签）
 *   - backend/src/db/migrate.ts                               → 当前 schema 版本
 *
 * 用法：node scripts/gen-channel-matrix.mjs
 * 幂等：输出不含时间戳/随机数，连续运行两次不会产生 diff。
 * 退出码：文档计数/schema 版本锚点与生成值不一致时返回 1（防止文档静默漂移）。
 *
 * 说明：README 中 Docker 姊妹项目的 “38 个渠道” 不在校验范围内——那是
 * timemark-docker 仓库的计数（38 = 11+11+5+5+6，含插件类渠道），无法由本仓库生成。
 */

import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTIFICATIONS_DIR = path.join(ROOT, 'backend', 'src', 'services', 'notifications');
const TEST_CONNECTION_PATH = path.join(NOTIFICATIONS_DIR, 'test-connection.ts');
const MIGRATE_PATH = path.join(ROOT, 'backend', 'src', 'db', 'migrate.ts');
const MATRIX_REL_PATH = 'docs/CHANNEL_MATRIX.md';
const MATRIX_PATH = path.join(ROOT, MATRIX_REL_PATH);

const COLUMNS = new Set(['webhook', 'token', 'secret', 'chat_id']);

if (typeof registerHooks !== 'function' || Number(process.versions.node.split('.')[0]) < 22) {
  console.error(
    `scripts/gen-channel-matrix.mjs 需要 Node.js >= 22.15（module.registerHooks + TypeScript 类型剥离）。当前：${process.versions.node}`,
  );
  process.exit(1);
}

// 把 TS 源码里的 `./foo.js` 说明符解析到 `./foo.ts`，其余解析交给 Node 默认逻辑。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // 不是 TS 项目内的相对引用（例如真实存在的 .js 文件），按原样解析
      }
    }
    return nextResolve(specifier, context);
  },
});

async function importTs(filePath) {
  try {
    return await import(pathToFileURL(filePath).href);
  } catch (error) {
    const hint =
      '无法直接加载 TypeScript。请使用 Node >= 22.18（默认开启类型剥离），或对 Node 22.15–22.17 添加 --experimental-strip-types。';
    console.error(`${hint}\n原始错误：${error?.message || error}`);
    throw error;
  }
}

const config = await importTs(path.join(NOTIFICATIONS_DIR, 'channels.config.ts'));
const support = await importTs(path.join(NOTIFICATIONS_DIR, 'supported-channels.ts'));

const supported = config.getSupportedChannelTemplates();
const unsupportedIds = [...support.UNSUPPORTED_CHANNEL_IDS];
const serverlessNotes = support.SERVERLESS_NOTES || {};

// ---------- test-connection.ts 分支解析 ----------

const testSource = fs.readFileSync(TEST_CONNECTION_PATH, 'utf8');

function extractCaseIds(functionName) {
  const marker = `function ${functionName}(`;
  const start = testSource.indexOf(marker);
  if (start === -1) {
    throw new Error(`test-connection.ts 中未找到 ${functionName}，无法推导测试分支`);
  }
  const body = testSource.slice(start);
  const next = body.slice(1).search(/\n(?:export )?(?:async )?function /);
  const scope = next === -1 ? body : body.slice(0, next + 1);
  const ids = new Set();
  for (const match of scope.matchAll(/case '([A-Za-z0-9_]+)':/g)) {
    ids.add(match[1]);
  }
  return ids;
}

const webhookCases = extractCaseIds('testWebhookChannel');
const tokenCases = extractCaseIds('testTokenChannel');
const pluginCases = extractCaseIds('testPluginChannel');

function testInfoOf(channel) {
  const cases =
    channel.configMethod === 'webhook'
      ? webhookCases
      : channel.configMethod === 'token'
        ? tokenCases
        : pluginCases;
  if (cases.has(channel.id)) {
    return { provider: true, label: `✅ \`test-connection.ts\` → \`${channel.configMethod === 'webhook' ? 'testWebhookChannel' : channel.configMethod === 'token' ? 'testTokenChannel' : 'testPluginChannel'}\`` };
  }
  if (channel.configMethod === 'webhook') {
    return { provider: false, label: '⚠️ 仅通用 webhook 测试（无 provider 专属校验）' };
  }
  return { provider: false, label: '❌ 无连接测试' };
}

function columnOf(field) {
  if (field.column) return field.column;
  return COLUMNS.has(field.name) ? field.name : '—';
}

const esc = (value) => String(value ?? '').replace(/\|/g, '\\|');
const isRequired = (field) => field.required === true;

// ---------- 渲染 CHANNEL_MATRIX.md ----------

const webhookCount = supported.filter((c) => c.configMethod === 'webhook').length;
const tokenCount = supported.filter((c) => c.configMethod === 'token').length;
const providerTestCount = supported.filter((c) => testInfoOf(c).provider).length;
const officialUrlOf = (channel) => channel.officialUrl || channel.docsUrl || '';

function renderChannelRow(channel, index) {
  const required = channel.fields
    .filter(isRequired)
    .map((field) => `\`${field.name}\` → \`${columnOf(field)}\``)
    .join('、');
  return `| ${index} | \`${channel.id}\` | ${esc(channel.name)}${channel.nameEn ? ` / ${esc(channel.nameEn)}` : ''} | \`${channel.configMethod}\` | ${required || '—'} | ${testInfoOf(channel).label} | ${officialUrlOf(channel) ? `<${officialUrlOf(channel)}>` : '—'} |`;
}

const channelRows = supported.map((channel, index) => renderChannelRow(channel, index + 1));

const fieldRows = supported.flatMap((channel) =>
  channel.fields.map(
    (field) =>
      `| \`${channel.id}\` | \`${field.name}\` | \`${columnOf(field)}\` | ${isRequired(field) ? '是' : '否'} | ${esc(field.label)} | ${field.labelEn ? esc(field.labelEn) : '—'} |`,
  ),
);

const unsupportedRows = unsupportedIds.map(
  (id) => `| \`${id}\` | ${esc(serverlessNotes[id] || 'Serverless 不可用')} |`,
);

// ---------- schema 版本（migrate.ts）----------

const migrateSource = fs.readFileSync(MIGRATE_PATH, 'utf8');
const schemaVersion = Math.max(
  ...[...migrateSource.matchAll(/version:\s*(\d+)/g)].map((match) => Number(match[1])),
);

const matrix = `# 通知渠道矩阵（CHANNEL_MATRIX）

> ⚠️ 本文件由 \`scripts/gen-channel-matrix.mjs\` 自动生成，请勿手工修改。
> 唯一数据源：\`backend/src/services/notifications/channels.config.ts\`（\`getSupportedChannelTemplates()\`）。
> 连接测试列由 \`test-connection.ts\` 的真实分支解析得到；官方地址优先取模板 \`officialUrl\`，缺省回退 \`docsUrl\`。

**云端可用渠道：${supported.length} 个**（webhook ${webhookCount} · token ${tokenCount}）· **Serverless 不可用：${unsupportedIds.length} 个** · **当前 schema：v${schemaVersion}**

## 1. 云端渠道总表（${supported.length}）

| # | ID | 名称 | configMethod | 必填字段 → DB 列 | 真实连接测试 | 官方地址 |
|---|----|------|--------------|------------------|--------------|----------|
${channelRows.join('\n')}

## 2. 字段 → notification_accounts 列（含可选字段，共 ${fieldRows.length} 项）

| 渠道 | 字段 | → DB 列 | 必填 | 标签 | 英文标签 |
|------|------|---------|------|------|----------|
${fieldRows.join('\n')}

## 3. Serverless 不可用渠道（${unsupportedIds.length}）

| ID | 原因 |
|----|------|
${unsupportedRows.join('\n')}

## 4. 权威计数（生成值）

| 项 | 值 |
|----|----|
| 云端渠道总数 | ${supported.length} |
| webhook 渠道 | ${webhookCount} |
| token 渠道 | ${tokenCount} |
| 有 provider 专属连接测试 | ${providerTestCount} |
| Serverless 不可用 | ${unsupportedIds.length} |
| schema 版本 | v${schemaVersion} |
`;

const previous = fs.existsSync(MATRIX_PATH) ? fs.readFileSync(MATRIX_PATH, 'utf8') : null;
if (previous !== matrix) {
  fs.writeFileSync(MATRIX_PATH, matrix, 'utf8');
}
console.log(
  `✓ ${MATRIX_REL_PATH} ${previous === matrix ? '无变化' : '已更新'}：cloud=${supported.length} (webhook=${webhookCount}, token=${tokenCount}), providerTest=${providerTestCount}, unsupported=${unsupportedIds.length}, schema=v${schemaVersion}`,
);

// ---------- 文档计数 / schema 版本校验 ----------

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function checkDoc(relPath, rules) {
  const content = readRepoFile(relPath);
  const problems = [];
  for (const rule of rules) {
    const matches = [...content.matchAll(rule.pattern)];
    if (matches.length === 0) {
      problems.push(`${relPath}: 未找到计数锚点 ${rule.label}（pattern ${rule.pattern}），文档可能已被改写`);
      continue;
    }
    for (const match of matches) {
      const value = Number(match[1]);
      if (value !== rule.expected()) {
        problems.push(
          `${relPath}: 「${match[0]}」= ${value}，但权威值为 ${rule.expected()}（${rule.label}）`,
        );
      }
    }
  }
  return problems;
}

const docChecks = [
  checkDoc('README.md', [
    { label: '渠道章节标题', pattern: /云端可用 (\d+) 个/g, expected: () => supported.length },
    { label: '版本对比表（Vercel 列）', pattern: /(\d+) 个 HTTP 渠道（Webhook\/Token，云端可用）/g, expected: () => supported.length },
    { label: 'Docker 对比表（Vercel 列）', pattern: /(\d+) 个云端可用 HTTP 渠道/g, expected: () => supported.length },
    { label: '提醒配置表', pattern: /(\d+) 个 HTTP 渠道任意组合/g, expected: () => supported.length },
    { label: '特性一览 / 标题', pattern: /\| (\d+) 个通知渠道 \|/g, expected: () => supported.length },
    { label: 'Webhook 类表头', pattern: /Webhook 类（(\d+) 个）/g, expected: () => webhookCount },
    { label: 'Token 类表头', pattern: /Token 类（(\d+) 个）/g, expected: () => tokenCount },
    { label: 'schema 版本（自动迁移范围）', pattern: /（v1–v(\d+)）/g, expected: () => schemaVersion },
    { label: 'schema 版本（自检）', pattern: /结构版本 v(\d+)/g, expected: () => schemaVersion },
  ]),
  checkDoc('docs/CHANNEL_COMPATIBILITY.md', [
    { label: '云端渠道计数', pattern: /\*\*(\d+) channels\*\* remain available/g, expected: () => supported.length },
  ]),
  checkDoc('FREE_TIER_DEPLOY.md', [
    { label: 'schema 版本（迁移范围）', pattern: /执行 v1[–-]v(\d+) 增量迁移/g, expected: () => schemaVersion },
    { label: 'schema 版本（部署向导）', pattern: /「数据库结构版本」为 \*\*v(\d+)\*\*/g, expected: () => schemaVersion },
    { label: 'schema 版本（系统自检）', pattern: /结构版本（\*\*v(\d+)\*\*）/g, expected: () => schemaVersion },
  ]),
  checkDoc('docs/INTEGRATIONS.md', [
    { label: 'schema 版本（部署向导）', pattern: /当前期望 \*\*v(\d+)\*\*/g, expected: () => schemaVersion },
  ]),
];

const problems = docChecks.flat();
if (problems.length > 0) {
  console.error('✗ 文档计数 / schema 版本校验失败：');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `✓ 文档计数校验通过：README.md / docs/CHANNEL_COMPATIBILITY.md / FREE_TIER_DEPLOY.md / docs/INTEGRATIONS.md（渠道 ${supported.length}，schema v${schemaVersion}）`,
  );
}
