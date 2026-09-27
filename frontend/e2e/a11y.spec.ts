import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Todo 43: baseline accessibility audit (Axe) on the five core pages at
 * 390x844 (mobile) and 1440x900 (desktop). The suite asserts ZERO
 * critical-impact violations per page/viewport; the full raw Axe JSON is
 * written under .omo/evidence/task-43-axe-raw/ for the evidence file.
 */

const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.omo', 'evidence');
const RAW_DIR = path.join(EVIDENCE_DIR, 'task-43-axe-raw');

const USER = { id: 1, username: 'e2e-a11y-user', role: 'admin', mustChangePassword: false };

const VIEWPORTS = [
  { id: '390x844', width: 390, height: 844 },
  { id: '1440x900', width: 1440, height: 900 },
] as const;

const PAGES = [
  { path: '/dashboard', heading: '我的倒计时', anonymous: false },
  { path: '/settings', heading: '系统设置', anonymous: false },
  { path: '/channels', heading: '通知渠道', anonymous: false },
  { path: '/todos', heading: '近期待办', anonymous: false },
  { path: '/expiry', heading: '到期中心', anonymous: false },
  { path: '/inventory', heading: '库存', anonymous: false },
  { path: '/maintenance', heading: '保养', anonymous: false },
  { path: '/documents', heading: '证件保险箱', anonymous: false },
  { path: '/habits', heading: '习惯打卡', anonymous: false },
  // todo 63: the contacts page hosts the CRM detail drawer (its open-state scan lives in
  // contacts-detail.spec.ts, which also runs Axe at both viewports for the drawer itself).
  { path: '/contacts', heading: '固定联系人', anonymous: false },
  { path: '/login', heading: /TimeMark/i, anonymous: true },
] as const;

/** Dev builds call the API cross-origin (http://localhost:3000/api) — fulfilled mocks need CORS headers. */
async function mockApi(page: Page, authenticated: boolean) {
  await page.addInitScript((token) => {
    if (token) localStorage.setItem('accessToken', token);
  }, authenticated ? 'e2e-a11y-token' : '');
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const cors: Record<string, string> = {
      'Access-Control-Allow-Origin': 'http://localhost:5173',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const { pathname } = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (pathname === '/api/auth/session') {
      return authenticated ? json({ success: true, data: USER }) : json({ success: false, error: 'Unauthorized' }, 401);
    }
    if (pathname === '/api/auth/refresh') return json({ success: false, error: 'Unauthorized' }, 401);
    if (pathname === '/api/auth/turnstile-config') return json({ success: true, data: { siteKey: null, enabled: false } });
    return json({ success: true, data: [] });
  });
}

interface AxeNodeLite {
  html: string;
  target: unknown[];
  failureSummary?: string;
}
interface AxeViolationLite {
  id: string;
  impact?: string | null;
  help: string;
  nodes: readonly AxeNodeLite[];
}

function summarize(violations: readonly AxeViolationLite[]) {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: v.nodes.map((n) => ({ target: n.target, html: n.html, failureSummary: n.failureSummary })),
  }));
}

for (const viewport of VIEWPORTS) {
  for (const target of PAGES) {
    test(`a11y: ${target.path} @ ${viewport.id} has zero critical Axe violations`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockApi(page, !target.anonymous);

      await page.goto(target.path);
      await expect(page.getByRole('heading', { name: target.heading }).first()).toBeVisible({ timeout: 30_000 });
      // Let lazy chunks + framer-motion entrance animations settle before scanning.
      await page.waitForTimeout(750);

      const results = await new AxeBuilder({ page }).analyze();
      const slug = `${target.path.replace(/^\//, '').replace(/\//g, '-')}-${viewport.id}`;
      mkdirSync(RAW_DIR, { recursive: true });
      writeFileSync(
        path.join(RAW_DIR, `${slug}.json`),
        JSON.stringify(
          {
            page: target.path,
            viewport: viewport.id,
            url: page.url(),
            axeVersion: results.testEngine.version,
            violationCounts: {
              total: results.violations.length,
              critical: results.violations.filter((v) => v.impact === 'critical').length,
              serious: results.violations.filter((v) => v.impact === 'serious').length,
              moderate: results.violations.filter((v) => v.impact === 'moderate').length,
              minor: results.violations.filter((v) => v.impact === 'minor').length,
            },
            violations: summarize(results.violations),
          },
          null,
          2,
        ),
      );

      const critical = results.violations.filter((v) => v.impact === 'critical');
      expect(
        critical,
        `critical Axe violations on ${target.path} @ ${viewport.id}:\n${JSON.stringify(summarize(critical), null, 2)}`,
      ).toEqual([]);
    });
  }
}
