import { test, expect, type Page } from '@playwright/test';

/**
 * Wave 10 todo 76 – statutory holidays / 调休 markers + the build-time static
 * search index.
 *
 * - 休/班 markers + holiday names render for October 2025 (National Day block and
 *   the compensated Sunday 2025-09-28 / Saturday 2025-10-11).
 * - A year outside the vendored range (2004-2026) shows the visible 数据未覆盖 state.
 * - The static search index is fetched lazily: zero requests until the first query.
 *
 * Dev builds call the API cross-origin (http://localhost:3000/api) — fulfilled
 * mocks need CORS headers (same pattern as upgrade-smoke.spec.ts).
 */

const USER = { id: 1, username: 'e2e-calendar-user', role: 'admin', mustChangePassword: false };

async function mockApi(page: Page) {
  await page.addInitScript(() => localStorage.setItem('accessToken', 'e2e-calendar-token'));
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
    const json = (body: unknown) =>
      route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (pathname === '/api/auth/session') return json({ success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') return json({ success: true, data: { siteKey: null, enabled: false } });
    return json({ success: true, data: [] });
  });
}

test.describe('calendar 休/班 holiday markers (todo 76)', () => {
  test('October 2025 shows 休 for National Day and 班 for compensated workdays', async ({ page }) => {
    await mockApi(page);
    // Fix the clock at a mid-October 2025 instant so the month view opens on 2025-10.
    await page.clock.setFixedTime(new Date('2025-10-15T12:00:00Z'));
    await page.goto('/calendar');

    await expect(page.getByRole('heading', { name: '日历' })).toBeVisible();
    await expect(page.getByText('2025年10月')).toBeVisible();

    // Legend (year colour legend) is rendered.
    const legend = page.getByTestId('holiday-legend');
    await expect(legend).toContainText('法定节假日');
    await expect(legend).toContainText('调休上班');
    await expect(legend).toContainText('2004-2026');

    // National Day 2025-10-01: 休 + holiday name.
    const nationalDay = page.locator('[data-date="2025-10-01"]');
    await expect(nationalDay).toContainText('休');
    await expect(nationalDay).toContainText('国庆节');

    // Second half of the block (2025-10-07) is still 休.
    await expect(page.locator('[data-date="2025-10-07"]')).toContainText('休');

    // Compensated workdays show 班 and never 休.
    const shiftSat = page.locator('[data-date="2025-10-11"]');
    await expect(shiftSat).toContainText('班');
    await expect(shiftSat).not.toContainText('休');

    // A plain weekday has no marker.
    const plainDay = page.locator('[data-date="2025-10-13"]');
    await expect(plainDay).not.toContainText('休');
    await expect(plainDay).not.toContainText('班');

    // Double-click a holiday enters the day view and shows the 休 marker there.
    await nationalDay.dblclick();
    await expect(page.getByTestId('day-holiday-marker')).toContainText('休');
    await expect(page.getByTestId('day-holiday-marker')).toContainText('国庆节');
  });

  test('a year outside 2004-2026 shows the 数据未覆盖 state instead of wrong markers', async ({ page }) => {
    await mockApi(page);
    await page.clock.setFixedTime(new Date('1999-06-15T12:00:00Z'));
    await page.goto('/calendar');

    await expect(page.getByRole('heading', { name: '日历' })).toBeVisible();
    await expect(page.getByText('1999年6月')).toBeVisible();
    const warning = page.getByTestId('coverage-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('数据未覆盖');
    await expect(warning).toContainText('2004-2026');

    // No legend and no 休/班 badges anywhere for an uncovered year.
    await expect(page.getByTestId('holiday-legend')).toHaveCount(0);
    await expect(page.locator('main').getByText('休', { exact: true })).toHaveCount(0);
    await expect(page.locator('main').getByText('班', { exact: true })).toHaveCount(0);
  });

  test('static search index is lazily fetched and returns holiday hits', async ({ page }) => {
    await mockApi(page);
    const indexRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('search-index.json')) indexRequests.push(req.url());
    });

    await page.clock.setFixedTime(new Date('2025-10-15T12:00:00Z'));
    await page.goto('/calendar');
    await expect(page.getByRole('heading', { name: '日历' })).toBeVisible();

    // Nothing fetched before the first interaction.
    await page.waitForTimeout(500);
    expect(indexRequests).toEqual([]);

    const box = page.getByTestId('static-search').getByRole('searchbox');
    await box.fill('国庆');
    const option = page.getByRole('option').first();
    await expect(option).toBeVisible();
    await expect(option).toContainText('国庆');
    expect(indexRequests.length).toBeGreaterThan(0);
  });
});
