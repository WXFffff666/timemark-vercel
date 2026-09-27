import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * 证件保险箱（D2，todo 56）端到端。
 *
 * happy:
 * - 号码以掩码渲染（明文未出现），点「显示」一次性 reveal，关闭后明文从 DOM 消失；
 *   号码不写 localStorage / sessionStorage（也不写 store / 日志）。
 * - 上传小 PDF（frontend/e2e/fixtures/sample.pdf）→ 附件出现在对话框与行内。
 * failure:
 * - 超大文件（2 MB+）→ 行内错误 + **零** POST /api/attachments。
 * - `.exe` 重命名为 `.pdf` → 客户端魔数嗅探拦截（零网络）；同一字节直接 POST API →
 *   服务端忠实 mock 以 400 拒绝（复刻 backend `assertContentTypeMatches` 的 fail-closed 策略）。
 * - 零字节文件行内拒绝；无 expires_at 渲染「无到期日」而非 NaN；API 500 只显示错误不崩溃。
 *
 * dev build 跨域请求 `http://localhost:3000/api`，因此 mock 必须带 CORS 头。
 * 服务端行为由 mock 忠实复刻（backend todo 53 的真实单测另见 evidence 中的
 * `pnpm --filter backend exec vitest run src/test/attachments-routes.test.ts`）。
 */

const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.omo', 'evidence');
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const USER = { id: 1, username: 'e2e-documents-user', role: 'admin', mustChangePassword: false };
const NUMBER_MASK = '•••• •••• ••••';
const PLAINTEXT_NUMBER = 'E12345678';

interface DocRow {
  id: number;
  user_id: number;
  profile_id: number | null;
  kind: string;
  title: string;
  issuer: string | null;
  issued_at: string | null;
  expires_at: string | null;
  country: string | null;
  notes: string | null;
  reminder_config: null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  numberConfigured: boolean;
}

interface AttachmentRow {
  id: number;
  owner_type: string | null;
  owner_id: number | null;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
  download_url: string;
}

interface MockState {
  documents: DocRow[];
  attachments: AttachmentRow[];
  numbers: Map<number, string>;
  attachmentPostCalls: number;
  attachmentPostBodies: Array<Record<string, unknown>>;
  revealCalls: number;
  failList: boolean;
}

function seedDoc(overrides: Partial<DocRow> & { id: number; title: string }): DocRow {
  return {
    user_id: 1,
    profile_id: null,
    kind: 'passport',
    issuer: null,
    issued_at: null,
    expires_at: null,
    country: null,
    notes: null,
    reminder_config: null,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    numberConfigured: false,
    ...overrides,
  };
}

function seedAttachment(overrides: Partial<AttachmentRow> & { id: number; filename: string }): AttachmentRow {
  return {
    owner_type: 'document',
    owner_id: 1,
    content_type: 'application/pdf',
    byte_size: 225,
    sha256: '0'.repeat(64),
    created_at: new Date().toISOString(),
    download_url: `/api/attachments/${overrides.id}`,
    ...overrides,
  };
}

/** Mirrors backend/src/services/attachment.service.ts#sniffContentType. */
function sniff(bytes: Buffer): string | null {
  const startsWith = (sig: number[], offset = 0) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  const asciiAt = (offset: number, text: string) =>
    bytes.length >= offset + text.length &&
    [...text].every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));

  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiAt(0, 'RIFF') && asciiAt(8, 'WEBP')) return 'image/webp';
  if (!bytes.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return 'text/plain';
    } catch {
      return null;
    }
  }
  return null;
}

const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain'];
const MAX_BYTES = 2 * 1024 * 1024;

async function setup(
  page: Page,
  seed: { documents?: DocRow[]; attachments?: AttachmentRow[]; numbers?: Map<number, string>; failList?: boolean } = {},
  theme?: 'light' | 'dark',
): Promise<MockState> {
  const state: MockState = {
    documents: (seed.documents ?? []).map((row) => ({ ...row })),
    attachments: (seed.attachments ?? []).map((row) => ({ ...row })),
    numbers: new Map(seed.numbers ?? []),
    attachmentPostCalls: 0,
    attachmentPostBodies: [],
    revealCalls: 0,
    failList: seed.failList ?? false,
  };
  let nextAttachmentId = state.attachments.reduce((max, row) => Math.max(max, row.id), 0) + 1;

  await page.addInitScript(
    ({ token, themeName }) => {
      localStorage.setItem('accessToken', token);
      if (themeName) localStorage.setItem('theme', themeName);
    },
    { token: 'e2e-documents-token', themeName: theme ?? '' },
  );

  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': 'http://localhost:5173',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const pathname = url.pathname;

    if (pathname === '/api/auth/session') return json(route, { success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') return json(route, { success: true, data: { siteKey: null, enabled: false } });

    // ---- Documents ----
    if (pathname === '/api/documents/expiring') {
      const days = Number(url.searchParams.get('days') ?? '90') || 90;
      const limit = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const rows = state.documents.filter(
        (row) => row.is_active && row.expires_at != null && row.expires_at >= today && row.expires_at <= limit,
      );
      return json(route, { success: true, data: rows, days });
    }
    const numberMatch = /^\/api\/documents\/(\d+)\/number$/.exec(pathname);
    if (numberMatch && req.method() === 'GET') {
      state.revealCalls += 1;
      const id = Number(numberMatch[1]);
      const row = state.documents.find((candidate) => candidate.id === id);
      if (!row) return json(route, { success: false, error: '证件不存在' }, 404);
      if (!row.numberConfigured) return json(route, { success: false, error: '该证件未配置号码' }, 404);
      return json(route, { success: true, data: { number: state.numbers.get(id) ?? '' } });
    }
    const docMatch = /^\/api\/documents\/(\d+)$/.exec(pathname);
    if (docMatch) {
      const id = Number(docMatch[1]);
      const row = state.documents.find((candidate) => candidate.id === id);
      if (req.method() === 'GET') {
        return row ? json(route, { success: true, data: row }) : json(route, { success: false, error: '证件不存在' }, 404);
      }
      if (req.method() === 'PATCH') {
        if (!row) return json(route, { success: false, error: '证件不存在' }, 404);
        const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
        if (typeof body.title === 'string') row.title = body.title;
        if (typeof body.kind === 'string') row.kind = body.kind;
        if (body.documentNumber != null && String(body.documentNumber).trim()) row.numberConfigured = true;
        row.updated_at = new Date().toISOString();
        return json(route, { success: true, data: row });
      }
      if (req.method() === 'DELETE') {
        state.documents = state.documents.filter((candidate) => candidate.id !== id);
        return json(route, { success: true });
      }
    }
    if (pathname === '/api/documents' && req.method() === 'GET') {
      if (state.failList) return json(route, { success: false, error: '服务器内部错误' }, 500);
      const kind = url.searchParams.get('kind');
      const active = url.searchParams.get('active');
      const q = url.searchParams.get('q');
      let list = state.documents.slice();
      if (kind) list = list.filter((row) => row.kind === kind);
      if (active === 'true') list = list.filter((row) => row.is_active);
      if (active === 'false') list = list.filter((row) => !row.is_active);
      if (q) {
        const needle = q.toLowerCase();
        list = list.filter((row) => `${row.title} ${row.issuer ?? ''}`.toLowerCase().includes(needle));
      }
      return json(route, { success: true, data: list, pagination: { page: 1, limit: 200, total: list.length, totalPages: 1 } });
    }
    if (pathname === '/api/documents' && req.method() === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const id = state.documents.reduce((max, row) => Math.max(max, row.id), 0) + 1;
      const row = seedDoc({
        id,
        title: String(body.title ?? ''),
        kind: String(body.kind ?? 'other'),
        issuer: body.issuer == null ? null : String(body.issuer),
        issued_at: typeof body.issuedAt === 'string' ? body.issuedAt : null,
        expires_at: typeof body.expiresAt === 'string' ? body.expiresAt : null,
        country: body.country == null ? null : String(body.country),
        notes: body.notes == null ? null : String(body.notes),
        is_active: body.isActive !== false,
        numberConfigured: body.documentNumber != null && String(body.documentNumber).length > 0,
      });
      state.documents.push(row);
      if (row.numberConfigured) state.numbers.set(id, String(body.documentNumber));
      return json(route, { success: true, data: row }, 201);
    }

    // ---- Attachments ----
    if (pathname === '/api/attachments' && req.method() === 'GET') {
      const ownerType = url.searchParams.get('owner_type');
      const ownerId = url.searchParams.get('owner_id');
      let list = state.attachments.slice();
      if (ownerType) list = list.filter((row) => row.owner_type === ownerType);
      if (ownerId) list = list.filter((row) => row.owner_id === Number(ownerId));
      return json(route, { success: true, data: list, pagination: { page: 1, limit: 200, total: list.length, totalPages: 1 } });
    }
    if (pathname === '/api/attachments' && req.method() === 'POST') {
      state.attachmentPostCalls += 1;
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      state.attachmentPostBodies.push(body);
      const declared = String(body.contentType ?? '');
      const filename = String(body.filename ?? '');
      const raw = Buffer.from(String(body.dataBase64 ?? ''), 'base64');
      // Fail-closed mirror of the server, in the same order.
      if (raw.byteLength === 0) return json(route, { success: false, error: '不能上传空文件' }, 400);
      if (raw.byteLength > MAX_BYTES) return json(route, { success: false, error: '文件超过 2 MB 上限' }, 413);
      if (!ALLOWED.includes(declared)) {
        return json(route, { success: false, error: `不支持的内容类型: ${declared || '(空)'}（image/svg+xml 等脚本向量被拒绝）` }, 400);
      }
      const actual = sniff(raw);
      if (actual !== declared) {
        return json(
          route,
          {
            success: false,
            error: actual
              ? `声明的类型 ${declared} 与实际文件内容（${actual}）不一致`
              : `声明的类型 ${declared} 与实际文件内容不一致（无法识别实际类型）`,
          },
          400,
        );
      }
      const id = nextAttachmentId++;
      const row: AttachmentRow = {
        id,
        owner_type: 'document',
        owner_id: Number(body.ownerId),
        filename,
        content_type: declared,
        byte_size: raw.byteLength,
        sha256: '0'.repeat(64),
        created_at: new Date().toISOString(),
        download_url: `/api/attachments/${id}`,
      };
      state.attachments.push(row);
      return json(route, { success: true, data: row }, 201);
    }
    const attachmentMatch = /^\/api\/attachments\/(\d+)$/.exec(pathname);
    if (attachmentMatch && req.method() === 'DELETE') {
      const id = Number(attachmentMatch[1]);
      state.attachments = state.attachments.filter((row) => row.id !== id);
      return json(route, { success: true });
    }

    return json(route, { success: false, error: 'not found' }, 404);
  });

  return state;
}

test('documents happy path: masked number reveals once (never persisted) and a PDF attaches', async ({ page }) => {
  const today = new Date();
  const future = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const state = await setup(page, {
    documents: [
      seedDoc({ id: 1, title: '中国护照', kind: 'passport', expires_at: future, numberConfigured: true, issuer: 'NIA' }),
    ],
    numbers: new Map([[1, PLAINTEXT_NUMBER]]),
  });

  await page.goto('/documents');
  await expect(page.getByRole('heading', { name: '证件保险箱' })).toBeVisible();

  // Masked: the exact mask renders and the plaintext is NOWHERE in the DOM.
  const masked = page.getByTestId('document-number-1');
  await expect(masked).toHaveText(NUMBER_MASK);
  await expect(masked).toHaveAttribute('data-masked', 'true');
  expect(await page.content()).not.toContain(PLAINTEXT_NUMBER);

  // Reveal once.
  await page.getByLabel('显示 中国护照 的证件号码').click();
  await expect(page.getByTestId('revealed-number')).toHaveText(PLAINTEXT_NUMBER);
  expect(state.revealCalls).toBe(1);

  // The plaintext must not be persisted anywhere.
  const stored = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  expect(stored.local).not.toContain(PLAINTEXT_NUMBER);
  expect(stored.session).not.toContain(PLAINTEXT_NUMBER);

  // Closing the dialog clears the plaintext from the DOM.
  await page.getByLabel('关闭号码显示').click();
  await expect(page.getByTestId('revealed-number')).toHaveCount(0);
  expect(await page.content()).not.toContain(PLAINTEXT_NUMBER);

  // Upload a small, real PDF through the edit/upload dialog.
  await page.getByLabel('编辑 中国护照').click();
  await expect(page.getByLabel('证件号码', { exact: true })).toHaveAttribute('placeholder', '留空保持不变');
  await page.getByTestId('document-attachment-input').setInputFiles(path.join(FIXTURES_DIR, 'sample.pdf'));
  await expect(page.getByTestId('attachment-upload-list')).toContainText('sample.pdf');
  expect(state.attachmentPostCalls).toBe(1);

  // Close the dialog; the attachment is visible on the row too.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('document-attachments-1')).toContainText('sample.pdf');
  await expect(page.getByRole('status').filter({ hasText: '附件已上传' })).toBeVisible();
});

test('oversized file shows an inline error with ZERO network requests', async ({ page }) => {
  const state = await setup(page, { documents: [seedDoc({ id: 2, title: '驾照', kind: 'driver_license' })] });
  await page.goto('/documents');
  await expect(page.getByRole('heading', { name: '证件保险箱' })).toBeVisible();

  await page.getByLabel('编辑 驾照').click();
  // 2.5 MB of a valid PDF header: ONLY the size cap can stop it.
  const oversized = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2.5 * 1024 * 1024, 0x41)]);
  await page.getByTestId('document-attachment-input').setInputFiles({
    name: 'big.pdf',
    mimeType: 'application/pdf',
    buffer: oversized,
  });

  await expect(page.getByTestId('attachment-error')).toContainText('2 MB');
  // Proof the cap is CLIENT-side: no upload request was made at all.
  expect(state.attachmentPostCalls).toBe(0);
});

test('renamed .exe→.pdf is blocked client-side (zero network) AND rejected server-side', async ({ page }) => {
  const state = await setup(page, { documents: [seedDoc({ id: 3, title: '保单', kind: 'policy' })] });
  const evil = readFileSync(path.join(FIXTURES_DIR, 'renamed-evil.pdf'));

  await page.goto('/documents');
  await expect(page.getByRole('heading', { name: '证件保险箱' })).toBeVisible();

  await page.getByLabel('编辑 保单').click();
  await page.getByTestId('document-attachment-input').setInputFiles({
    name: 'evil.pdf',
    mimeType: 'application/pdf',
    buffer: evil,
  });
  await expect(page.getByTestId('attachment-error')).toContainText('不一致');
  expect(state.attachmentPostCalls).toBe(0);

  // Now bypass the UI entirely: POST the very same bytes straight at the API.
  const base64 = evil.toString('base64');
  const direct = await page.evaluate(async (payload) => {
    const res = await fetch('http://localhost:3000/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  }, { ownerType: 'document', ownerId: 3, filename: 'evil.pdf', contentType: 'application/pdf', dataBase64: base64 });

  expect(direct.status).toBe(400);
  expect(direct.body.error ?? '').toContain('不一致');
  expect(state.attachmentPostCalls).toBe(1);
});

test('malformed inputs: zero-byte rejected, null expiry renders 无到期日, API 500 does not crash', async ({ page }) => {
  const state = await setup(page, {
    documents: [
      seedDoc({ id: 4, title: '无到期证件', kind: 'certificate', expires_at: null }),
    ],
  });
  await page.goto('/documents');
  await expect(page.getByRole('heading', { name: '证件保险箱' })).toBeVisible();

  const countdown = page.getByTestId('document-countdown-4');
  await expect(countdown).toHaveText('无到期日');
  await expect(countdown).toHaveAttribute('data-kind', 'none');
  await expect(countdown).not.toContainText('NaN');

  await page.getByLabel('编辑 无到期证件').click();
  await page.getByTestId('document-attachment-input').setInputFiles({
    name: 'empty.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(0),
  });
  await expect(page.getByTestId('attachment-error')).toContainText('空文件');
  expect(state.attachmentPostCalls).toBe(0);

  // A 500 from the list endpoint surfaces as an alert; the page still renders.
  await page.keyboard.press('Escape');
  state.failList = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: '证件保险箱' })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('prompt injection: a hostile attachment filename renders as inert text (no HTML execution)', async ({ page }) => {
  const hostile = '<img src=x onerror="window.__xss=1">.pdf';
  await setup(page, {
    documents: [seedDoc({ id: 21, title: '注入测试', kind: 'other' })],
    attachments: [seedAttachment({ id: 71, filename: hostile, owner_id: 21 })],
  });

  await page.goto('/documents');
  await expect(page.getByTestId('attachment-name-71')).toHaveText(hostile);
  // No element was injected from the filename, and no handler ran.
  await expect(page.locator('[data-testid="attachment-row-71"] img')).toHaveCount(0);
  const xss = await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss);
  expect(xss).toBeUndefined();
});

for (const theme of ['light', 'dark'] as const) {
  test(`documents visual snapshot (${theme})`, async ({ page }) => {
    const today = new Date();
    const ymd = (offsetDays: number) => new Date(today.getTime() + offsetDays * 86400000).toISOString().slice(0, 10);
    await setup(
      page,
      {
        documents: [
          seedDoc({ id: 11, title: '中国护照', kind: 'passport', expires_at: ymd(200), numberConfigured: true, issuer: 'NIA', country: '中国' }),
          seedDoc({ id: 12, title: '机动车驾驶证', kind: 'driver_license', expires_at: ymd(5), numberConfigured: true }),
          seedDoc({ id: 13, title: '家庭财产保单', kind: 'policy', expires_at: ymd(-3), numberConfigured: false, issuer: 'XX 保险' }),
          seedDoc({ id: 14, title: '在职证明', kind: 'certificate', expires_at: null }),
        ],
        attachments: [seedAttachment({ id: 91, filename: 'passport-scan.pdf', owner_id: 11 })],
      },
      theme,
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/documents');
    await expect(page.getByRole('heading', { name: '证件保险箱' })).toBeVisible();
    await expect(page.getByTestId('document-item-11')).toBeVisible();
    await expect(page.getByTestId('document-attachments-11')).toContainText('passport-scan.pdf');
    await page.waitForTimeout(400);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-56-documents-${theme}.png`), fullPage: true });
  });
}
