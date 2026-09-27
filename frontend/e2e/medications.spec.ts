import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  AdherenceReport,
  MedicationDoseRecord,
  MedicationForm,
  MedicationRecord,
  RefillItem,
} from '@timemark/shared';

/**
 * 用药页（plan todo 75）端到端。
 *
 * - happy：新建（含 is_critical）→ 记一次服用 + 一次跳过 → 环百分比 → 补货提醒 → 下载报告。
 * - failure/adversarial：
 *   - 环百分比断言有牙齿（写错数字会被抓）。
 *   - 空 schedule_times（PRN）、0 剂量日（除零）、null dosage、API 500、10 个药品。
 *   - 10 个药品 @390x844 无横向溢出（打印 scrollWidth）。
 *   - prompt injection：HTML/script 名称按文本渲染。
 *   - PDF 不可用时优雅回退 HTML。
 * - axe：390x844 与 1440x900 零 critical；visual：浅 / 深色截图。
 *
 * dev build 请求 http://localhost:3000/api（跨域），mock 必须回 CORS 头。
 */

const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.omo', 'evidence');
const USER = { id: 1, username: 'e2e-medications-user', role: 'admin', mustChangePassword: false };
const TODAY = '2026-03-10';

interface MockState {
  medications: MedicationRecord[];
  doses: MedicationDoseRecord[];
  requests: string[];
  createBodies: Record<string, unknown>[];
  logCalls: number;
  snoozeCalls: number;
}

interface SetupOptions {
  medications?: MedicationRecord[];
  doses?: MedicationDoseRecord[];
  theme?: 'light' | 'dark';
  listError?: boolean;
  todayError?: boolean;
  reportPdfError?: boolean;
  profileId?: number;
}

function medication(partial: Partial<MedicationRecord> & { id: number; name: string }): MedicationRecord {
  const now = new Date().toISOString();
  return {
    user_id: 1,
    profile_id: null,
    dosage: null,
    form: 'tablet' as MedicationForm,
    schedule_times: [],
    schedule_days: null,
    start_date: TODAY,
    end_date: null,
    stock_quantity: null,
    stock_unit: null,
    units_per_dose: 1,
    refill_threshold: null,
    prescriber: null,
    pharmacy: null,
    notes: null,
    is_active: true,
    is_critical: false,
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

function doseRow(id: number, medicationId: number, scheduledFor: string, status: MedicationDoseRecord['status'] = 'pending'): MedicationDoseRecord {
  return {
    id,
    medication_id: medicationId,
    user_id: 1,
    scheduled_for: scheduledFor,
    logged_at: null,
    status,
    note: null,
    created_at: new Date().toISOString(),
  };
}

/** HH:mm (Asia/Shanghai) -> UTC ISO，匹配后端物化剂量时的时刻表达。 */
function isoForTime(time: string): string {
  return new Date(`${TODAY}T${time}:00+08:00`).toISOString();
}

async function setup(page: Page, options: SetupOptions = {}): Promise<MockState> {
  const state: MockState = {
    medications: (options.medications ?? []).map((m) => ({ ...m })),
    doses: (options.doses ?? []).map((d) => ({ ...d })),
    requests: [],
    createBodies: [],
    logCalls: 0,
    snoozeCalls: 0,
  };
  let nextMedId = state.medications.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  let nextDoseId = state.doses.reduce((max, row) => Math.max(max, row.id), 0) + 1;

  await page.addInitScript(
    ({ token, themeName, selectedProfileId }) => {
      localStorage.setItem('accessToken', token);
      if (themeName) localStorage.setItem('theme', themeName);
      if (selectedProfileId) localStorage.setItem('timemark.profileId', String(selectedProfileId));
    },
    { token: 'e2e-medications-token', themeName: options.theme ?? '', selectedProfileId: options.profileId ?? 0 },
  );

  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': 'http://localhost:5173',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function medById(id: number): MedicationRecord | undefined {
    return state.medications.find((m) => m.id === id);
  }

  function todayPayload() {
    return state.doses
      .map((dose) => {
        const med = medById(dose.medication_id);
        if (!med) return null;
        return {
          ...dose,
          medication: {
            id: med.id,
            name: med.name,
            dosage: med.dosage,
            form: med.form,
            units_per_dose: med.units_per_dose,
            stock_unit: med.stock_unit,
            is_critical: med.is_critical,
            profile_id: med.profile_id,
          },
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }

  function refillPayload(): RefillItem[] {
    const items: RefillItem[] = [];
    for (const med of state.medications) {
      if (med.stock_quantity == null) continue;
      const perDay = med.schedule_times.length * ((med.schedule_days?.length ?? 7) / 7);
      const days = perDay > 0 ? med.stock_quantity / (med.units_per_dose * perDay) : null;
      const daysOfSupply = days == null ? null : Math.round(days * 100) / 100;
      const belowThreshold = med.refill_threshold != null && med.stock_quantity < med.refill_threshold;
      const belowDays = daysOfSupply != null && daysOfSupply < 7;
      if (!belowThreshold && !belowDays) continue;
      items.push({
        medicationId: med.id,
        name: med.name,
        profile_id: med.profile_id,
        stockQuantity: med.stock_quantity,
        stockUnit: med.stock_unit,
        unitsPerDose: med.units_per_dose,
        refillThreshold: med.refill_threshold,
        daysOfSupply,
        reason: belowThreshold && belowDays ? 'both' : belowThreshold ? 'threshold' : 'days_of_supply',
      });
    }
    return items;
  }

  function adherencePayload(from: string, to: string): AdherenceReport {
    type Bucket = { name: string; taken: number; skipped: number; missed: number };
    const perMed = new Map<number, Bucket>();
    const overall = { taken: 0, skipped: 0, missed: 0 };
    for (const dose of state.doses) {
      if (dose.status === 'pending') continue;
      const med = medById(dose.medication_id);
      if (!med) continue;
      const entry = perMed.get(med.id) ?? { name: med.name, taken: 0, skipped: 0, missed: 0 };
      entry[dose.status] += 1;
      overall[dose.status] += 1;
      perMed.set(med.id, entry);
    }
    const finalize = (bucket: Bucket, streakBase: number) => {
      const total = bucket.taken + bucket.skipped + bucket.missed;
      return {
        taken: bucket.taken,
        skipped: bucket.skipped,
        missed: bucket.missed,
        total,
        percentage: total > 0 ? Math.round((bucket.taken / total) * 100) : 0,
        currentStreak: total > 0 && bucket.skipped === 0 && bucket.missed === 0 ? streakBase : 0,
      };
    };
    const medications = [...perMed.entries()].map(([medicationId, bucket]) => ({
      medicationId,
      name: bucket.name,
      ...finalize(bucket, 1),
    }));
    return { from, to, overall: finalize(overall, 1), medications };
  }

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const pathname = url.pathname;
    state.requests.push(`${method} ${pathname}${url.search}`);

    if (pathname === '/api/auth/session') return json(route, { success: true, data: USER });
    if (pathname === '/api/auth/refresh') return json(route, { success: false, error: 'Unauthorized' }, 401);
    if (pathname === '/api/auth/turnstile-config') return json(route, { success: true, data: { siteKey: null, enabled: false } });
    if (pathname === '/api/config') return json(route, { success: true, data: { timezone: 'Asia/Shanghai' } });
    if (pathname === '/api/profiles') {
      const profiles = options.profileId
        ? [{ id: options.profileId, name: '我', avatar_emoji: null, relation: null, kind: 'self', birth_date: null, lunar_birthday: null, timezone: null, sort_order: 0, is_active: true, created_at: null, updated_at: null }]
        : [];
      return json(route, { success: true, data: profiles });
    }

    if (pathname === '/api/medications/report' && method === 'GET') {
      const format = url.searchParams.get('format') ?? 'html';
      if (options.reportPdfError && format === 'pdf') {
        return route.fulfill({
          status: 501,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, error: 'pdf unavailable' }),
        });
      }
      const body = format === 'csv' ? 'medication,taken\n降压药,1\n' : '<html><body>用药报告</body></html>';
      return route.fulfill({
        status: 200,
        headers: {
          ...cors,
          'Content-Type': format === 'csv' ? 'text/csv' : 'text/html',
          'Content-Disposition': `attachment; filename="report.${format}"`,
        },
        body,
      });
    }

    if (pathname === '/api/medications/today' && method === 'GET') {
      if (options.todayError) return json(route, { success: false, error: 'today boom' }, 500);
      return json(route, { success: true, data: todayPayload() });
    }
    if (pathname === '/api/medications/adherence' && method === 'GET') {
      const from = url.searchParams.get('from') ?? TODAY;
      const to = url.searchParams.get('to') ?? TODAY;
      return json(route, { success: true, data: adherencePayload(from, to) });
    }
    if (pathname === '/api/medications/refills' && method === 'GET') {
      return json(route, { success: true, data: refillPayload() });
    }

    if (pathname === '/api/medications' && method === 'GET') {
      if (options.listError) return json(route, { success: false, error: 'list boom' }, 500);
      return json(route, { success: true, data: state.medications });
    }

    if (pathname === '/api/medications' && method === 'POST') {
      const body: Record<string, unknown> = req.postDataJSON() ?? {};
      state.createBodies.push(body);
      const times = Array.isArray(body.scheduleTimes) ? (body.scheduleTimes as string[]) : [];
      const created = medication({
        id: nextMedId++,
        name: String(body.name ?? ''),
        dosage: body.dosage == null ? null : String(body.dosage),
        form: typeof body.form === 'string' ? (body.form as MedicationForm) : 'tablet',
        schedule_times: [...times].sort(),
        schedule_days: Array.isArray(body.scheduleDays) ? (body.scheduleDays as number[]) : null,
        start_date: typeof body.startDate === 'string' ? body.startDate : TODAY,
        end_date: typeof body.endDate === 'string' ? body.endDate : null,
        stock_quantity: typeof body.stockQuantity === 'number' ? body.stockQuantity : null,
        stock_unit: body.stockUnit == null ? null : String(body.stockUnit),
        units_per_dose: typeof body.unitsPerDose === 'number' ? body.unitsPerDose : 1,
        refill_threshold: typeof body.refillThreshold === 'number' ? body.refillThreshold : null,
        is_active: body.isActive !== false,
        is_critical: body.isCritical === true,
        profile_id: typeof body.profileId === 'number' ? body.profileId : null,
      });
      state.medications.push(created);
      for (const time of created.schedule_times) {
        state.doses.push(doseRow(nextDoseId++, created.id, isoForTime(time)));
      }
      return json(route, { success: true, data: created }, 201);
    }

    const medMatch = /^\/api\/medications\/(\d+)$/.exec(pathname);
    if (medMatch && method === 'PATCH') {
      const med = medById(Number(medMatch[1]));
      if (!med) return json(route, { success: false, error: '药品不存在' }, 404);
      const body: Record<string, unknown> = req.postDataJSON() ?? {};
      if (typeof body.name === 'string') med.name = body.name;
      if (typeof body.isCritical === 'boolean') med.is_critical = body.isCritical;
      if (typeof body.isActive === 'boolean') med.is_active = body.isActive;
      med.updated_at = new Date().toISOString();
      return json(route, { success: true, data: med });
    }
    if (medMatch && method === 'DELETE') {
      state.medications = state.medications.filter((m) => m.id !== Number(medMatch[1]));
      state.doses = state.doses.filter((d) => d.medication_id !== Number(medMatch[1]));
      return json(route, { success: true });
    }

    const logMatch = /^\/api\/doses\/(\d+)\/log$/.exec(pathname);
    if (logMatch && method === 'POST') {
      state.logCalls += 1;
      const dose = state.doses.find((d) => d.id === Number(logMatch[1]));
      if (!dose) return json(route, { success: false, error: '剂量不存在' }, 404);
      const body: Record<string, unknown> = req.postDataJSON() ?? {};
      const nextStatus = body.status === 'skipped' ? 'skipped' : 'taken';
      const previous = dose.status;
      dose.status = nextStatus;
      dose.logged_at = new Date().toISOString();
      const med = medById(dose.medication_id);
      if (med && med.stock_quantity != null) {
        if (nextStatus === 'taken' && previous !== 'taken') med.stock_quantity = Math.max(0, med.stock_quantity - med.units_per_dose);
        if (nextStatus === 'skipped' && previous === 'taken') med.stock_quantity += med.units_per_dose;
      }
      return json(route, { success: true, data: { dose, stockQuantity: med?.stock_quantity ?? null } });
    }

    const snoozeMatch = /^\/api\/doses\/(\d+)\/snooze$/.exec(pathname);
    if (snoozeMatch && method === 'POST') {
      state.snoozeCalls += 1;
      const dose = state.doses.find((d) => d.id === Number(snoozeMatch[1]));
      if (!dose) return json(route, { success: false, error: '剂量不存在' }, 404);
      if (dose.status !== 'pending') return json(route, { success: false, error: '该剂量已记录' }, 409);
      return json(route, { success: true, data: { doseId: dose.id, snoozedUntil: new Date(Date.now() + 600_000).toISOString() } });
    }

    return json(route, { success: false, error: 'not found' }, 404);
  });

  return state;
}

async function expectRing(page: Page, expected: Partial<Record<string, number>>): Promise<void> {
  const ring = page.getByTestId('medication-ring');
  for (const [key, value] of Object.entries(expected)) {
    const attr = key === 'takenPct' ? 'data-taken-pct' : key === 'skippedPct' ? 'data-skipped-pct' : key === 'missedPct' ? 'data-missed-pct' : `data-${key}`;
    await expect(ring).toHaveAttribute(attr, String(value));
  }
}

function writeEvidence(fileName: string, payload: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, `${fileName}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

test('medications happy path: create (critical) -> log taken + skipped -> ring 50/50 -> refill warning -> download report', async ({ page }) => {
  test.setTimeout(120_000);
  const state = await setup(page);

  await page.goto('/medications');
  await expect(page.getByRole('heading', { name: '用药提醒' })).toBeVisible();
  await expect(page.getByTestId('medication-empty')).toBeVisible();

  await page.getByLabel('新建药品').click();
  await page.getByLabel('药品名称').fill('降压药');
  await page.getByLabel('剂量说明').fill('5mg');
  for (const time of ['08:00', '14:00']) {
    await page.getByLabel('服药时刻', { exact: true }).fill(time);
    await page.getByLabel('添加服药时刻').click();
  }
  await page.getByLabel('库存数量').fill('5');
  await page.getByLabel('库存单位').fill('片');
  await page.getByLabel('补货阈值').fill('10');
  // is_critical 控件必须显式出现在创建表单里。
  await expect(page.getByTestId('med-is-critical')).toBeVisible();
  await page.getByTestId('med-is-critical').click();
  await page.getByLabel('保存药品').click();

  await expect(page.getByTestId('med-row-1')).toBeVisible();
  // 创建请求带 isCritical=true 且带上两个时刻。
  expect(state.createBodies).toHaveLength(1);
  expect(state.createBodies[0].isCritical).toBe(true);
  expect(state.createBodies[0].scheduleTimes).toEqual(['08:00', '14:00']);

  // 两条今日剂量 + 关键标记。
  await expect(page.getByTestId('dose-row-1')).toBeVisible();
  await expect(page.getByTestId('dose-row-2')).toBeVisible();
  await expect(page.getByTestId('dose-row-1').getByText('关键')).toBeVisible();

  await expectRing(page, { taken: 0, skipped: 0, pending: 2, total: 2, takenPct: 0 });
  await expect(page.getByTestId('bucket-morning')).toHaveAttribute('data-count', '1');
  await expect(page.getByTestId('bucket-afternoon')).toHaveAttribute('data-count', '1');

  // snooze：10 分钟后再提醒，剂量保持 pending。
  await page.getByTestId('dose-snooze-2').click();
  await expect(page.getByRole('status')).toContainText('10 分钟后提醒');
  expect(state.snoozeCalls).toBe(1);
  await expect(page.getByTestId('dose-status-2')).toHaveAttribute('data-status', 'pending');

  // tap-to-log：一条服用，一条跳过。
  await page.getByTestId('dose-taken-1').click();
  await expectRing(page, { taken: 1, pending: 1, total: 2, takenPct: 50 });
  await expect(page.getByTestId('dose-status-1')).toHaveAttribute('data-status', 'taken');

  await page.getByTestId('dose-skipped-2').click();
  await expectRing(page, { taken: 1, skipped: 1, pending: 0, total: 2, takenPct: 50, skippedPct: 50, missedPct: 0 });
  await expect(page.getByTestId('dose-status-2')).toHaveAttribute('data-status', 'skipped');
  expect(state.logCalls).toBe(2);

  // 补货提醒：库存 5 < 阈值 10（且可维持天数 < 7，reason=both）。
  await expect(page.getByTestId('refill-warning-1')).toBeVisible();
  await expect(page.getByTestId('refill-warning-1')).toHaveAttribute('data-reason', 'both');

  // 依从性标签页：周环 + 连胜 + 下载报告。
  await page.getByRole('tab', { name: '依从性' }).click();
  await expect(page.getByTestId('adherence-donut')).toHaveAttribute('data-total', '2');
  await expect(page.getByTestId('adherence-donut')).toHaveAttribute('data-percentage', '50');
  await expect(page.getByTestId('adherence-streak')).toHaveAttribute('data-streak', '0');

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('download-report').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^medications-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.html$/);
  await expect(page.getByRole('status')).toContainText('报告已下载（HTML）');

  writeEvidence('task-75-happy-path', {
    createBody: state.createBodies[0],
    logCalls: state.logCalls,
    requests: state.requests,
    savedFilename: download.suggestedFilename(),
  });
});

test('profile-aware: the selected profile id reaches every medications API and the create payload', async ({ page }) => {
  const state = await setup(page, {
    profileId: 7,
    medications: [medication({ id: 1, name: '家庭用药', schedule_times: ['08:00'], profile_id: 7 })],
    doses: [doseRow(1, 1, isoForTime('08:00'))],
  });

  await page.goto('/medications');
  await expect(page.getByRole('heading', { name: '用药提醒' })).toBeVisible();
  await expect(page.getByTestId('dose-row-1')).toBeVisible();

  const listCalls = state.requests.filter((r) => r.startsWith('GET /api/medications'));
  expect(listCalls.some((r) => r.startsWith('GET /api/medications?active=true') && r.includes('profileId=7'))).toBe(true);
  expect(listCalls.some((r) => r.startsWith('GET /api/medications/today') && r.includes('profileId=7'))).toBe(true);
  expect(listCalls.some((r) => r.startsWith('GET /api/medications/refills') && r.includes('profileId=7'))).toBe(true);
  expect(listCalls.some((r) => r.startsWith('GET /api/medications/adherence') && r.includes('profileId=7'))).toBe(true);

  await page.getByLabel('新建药品').click();
  await page.getByLabel('药品名称').fill('新的家庭用药');
  await page.getByLabel('保存药品').click();
  await expect(page.getByTestId('med-row-2')).toBeVisible();
  expect(state.createBodies).toHaveLength(1);
  expect(state.createBodies[0].profileId).toBe(7);

  writeEvidence('task-75-profile-propagation', { listCalls, createProfileId: state.createBodies[0].profileId });
});

test('adversarial: the ring percentage assertions have teeth (a wrong value fails them)', async ({ page }) => {
  await setup(page, {
    medications: [medication({ id: 1, name: '降压药', schedule_times: ['08:00', '14:00'], stock_quantity: 5, stock_unit: '片', refill_threshold: 10 })],
    doses: [
      doseRow(1, 1, isoForTime('08:00'), 'taken'),
      doseRow(2, 1, isoForTime('14:00'), 'skipped'),
    ],
  });

  await page.goto('/medications');
  await expect(page.getByRole('heading', { name: '用药提醒' })).toBeVisible();
  await expect(page.getByTestId('dose-row-1')).toBeVisible();

  // 真实值：taken=1 / skipped=1 / total=2 -> 50%。
  await expectRing(page, { taken: 1, skipped: 1, total: 2, takenPct: 50, skippedPct: 50 });

  let wrongThrew = false;
  try {
    await expectRing(page, { takenPct: 40 });
  } catch {
    wrongThrew = true;
  }
  expect(wrongThrew).toBe(true);

  writeEvidence('task-75-negative-controls', {
    actualTakenPct: await page.getByTestId('medication-ring').getAttribute('data-taken-pct'),
    wrongRingAssertionThrew: wrongThrew,
  });
});

test('adversarial malformed: empty schedule_times (PRN), zero-dose day (no divide-by-zero) and a null dosage render safely', async ({ page }) => {
  await setup(page, {
    medications: [
      medication({ id: 1, name: '按需止痛药', schedule_times: [], dosage: null }),
      medication({ id: 2, name: '未来药', schedule_times: ['09:00'] }),
    ],
    doses: [],
  });

  await page.goto('/medications');
  await expect(page.getByRole('heading', { name: '用药提醒' })).toBeVisible();
  await expect(page.getByTestId('med-row-1')).toBeVisible();
  await expect(page.getByTestId('med-row-1').getByText('按需（PRN）')).toBeVisible();

  // 0 剂量日：环 total=0，百分比 0（不是 NaN）。
  await expectRing(page, { total: 0, taken: 0, skipped: 0, missed: 0, takenPct: 0, missedPct: 0, skippedPct: 0 });
  await expect(page.getByTestId('bucket-morning')).toHaveAttribute('data-count', '0');

  writeEvidence('task-75-malformed-prn-zero-dose', {
    ringTotal: await page.getByTestId('medication-ring').getAttribute('data-total'),
    ringTakenPct: await page.getByTestId('medication-ring').getAttribute('data-taken-pct'),
  });
});

test('adversarial malformed: an API 500 keeps the heading and shows an alert instead of crashing', async ({ page }) => {
  await setup(page, { listError: true });
  await page.goto('/medications');
  await expect(page.getByRole('heading', { name: '用药提醒' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('list boom');
  await expect(page.locator('h1', { hasText: '用药提醒' })).toBeVisible();
});

test('adversarial prompt injection: a hostile medication name renders as inert text', async ({ page }) => {
  const hostile = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
  await setup(page, {
    medications: [medication({ id: 1, name: hostile, schedule_times: ['08:00'] })],
    doses: [doseRow(1, 1, isoForTime('08:00'))],
  });

  await page.goto('/medications');
  await expect(page.getByRole('heading', { name: '用药提醒' })).toBeVisible();
  const main = page.locator('#main-content');
  await expect(main).toContainText('<img');
  await expect(main.locator('img')).toHaveCount(0);
  await expect(main.locator('script')).toHaveCount(0);
  const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
  expect(xss).toBeUndefined();
});

test('failure scenario: 10 medications at 390x844 have NO horizontal overflow (measured scrollWidth)', async ({ page }) => {
  test.setTimeout(90_000);
  const meds: MedicationRecord[] = [];
  const doses: MedicationDoseRecord[] = [];
  for (let i = 1; i <= 10; i += 1) {
    meds.push(
      medication({
        id: i,
        name: `药品名称很长的测试用药 ${i} 号`,
        dosage: '10mg',
        schedule_times: ['08:00', '12:30', '19:00'],
        stock_quantity: i,
        stock_unit: '片',
        refill_threshold: 20,
      }),
    );
    for (const [j, time] of ['08:00', '12:30', '19:00'].entries()) {
      doses.push(doseRow(i * 10 + j, i, isoForTime(time), i % 2 === 0 ? 'pending' : 'taken'));
    }
  }
  await setup(page, { medications: meds, doses });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/medications');
  await expect(page.getByRole('heading', { name: '用药提醒' })).toBeVisible();
  await expect(page.getByTestId('med-row-10')).toBeVisible();
  await expect(page.getByTestId('dose-row-100')).toBeVisible();

  const widths = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  writeEvidence('task-75-overflow-390', widths);

  expect(widths.docScrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);
  expect(widths.bodyScrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);
});

test('report: a PDF 501 falls back to HTML gracefully', async ({ page }) => {
  await setup(page, {
    reportPdfError: true,
    medications: [medication({ id: 1, name: '降压药', schedule_times: ['08:00'] })],
    doses: [doseRow(1, 1, isoForTime('08:00'), 'taken')],
  });

  await page.goto('/medications');
  await expect(page.getByRole('heading', { name: '用药提醒' })).toBeVisible();
  await page.getByRole('tab', { name: '依从性' }).click();
  await page.getByLabel('报告格式').selectOption('pdf');

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('download-report').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  await expect(page.getByRole('status')).toContainText('PDF 暂不可用，已改为下载 HTML 报告');
});

for (const viewport of [
  { id: '390x844', width: 390, height: 844 },
  { id: '1440x900', width: 1440, height: 900 },
] as const) {
  test(`a11y medications: zero critical Axe violations at ${viewport.id}`, async ({ page }) => {
    test.setTimeout(90_000);
    await setup(page, {
      medications: [
        medication({ id: 1, name: '降压药', schedule_times: ['08:00', '14:00'], stock_quantity: 5, stock_unit: '片', refill_threshold: 10 }),
        medication({ id: 2, name: '维生素', schedule_times: ['20:00'] }),
      ],
      doses: [doseRow(1, 1, isoForTime('08:00'), 'taken'), doseRow(2, 1, isoForTime('14:00')), doseRow(3, 2, isoForTime('20:00'))],
    });

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/medications');
    await expect(page.getByRole('heading', { name: '用药提醒' })).toBeVisible();
    await expect(page.getByTestId('dose-row-1')).toBeVisible();
    await page.waitForTimeout(600);

    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((v) => v.impact === 'critical');
    writeEvidence(`task-75-axe-medications-${viewport.id}`, {
      viewport: viewport.id,
      violationCounts: {
        total: results.violations.length,
        critical: critical.length,
        serious: results.violations.filter((v) => v.impact === 'serious').length,
        moderate: results.violations.filter((v) => v.impact === 'moderate').length,
        minor: results.violations.filter((v) => v.impact === 'minor').length,
      },
      violations: results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => ({ target: n.target, html: n.html })),
      })),
    });
    expect(critical, `critical violations: ${JSON.stringify(critical.map((v) => v.id))}`).toEqual([]);
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`medications visual snapshot (${theme}) with prefers-reduced-motion`, async ({ page }) => {
    test.setTimeout(90_000);
    await setup(page, {
      theme,
      medications: [
        medication({ id: 1, name: '降压药', schedule_times: ['08:00', '14:00'], stock_quantity: 5, stock_unit: '片', refill_threshold: 10 }),
        medication({ id: 2, name: '维生素 D', schedule_times: ['20:00'], stock_quantity: 100, stock_unit: '粒' }),
      ],
      doses: [
        doseRow(1, 1, isoForTime('08:00'), 'taken'),
        doseRow(2, 1, isoForTime('14:00'), 'skipped'),
        doseRow(3, 2, isoForTime('20:00')),
      ],
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/medications');
    await expect(page.getByRole('heading', { name: '用药提醒' })).toBeVisible();
    await expect(page.getByTestId('dose-row-1')).toBeVisible();
    await page.waitForTimeout(400);

    const duration = await page.getByTestId('dose-taken-3').evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(duration)).toBeLessThan(0.05);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `task-75-medications-${theme}.png`), fullPage: true });
  });
}
