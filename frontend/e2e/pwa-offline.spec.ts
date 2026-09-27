import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * Checkbox 85 acceptance — installable + offline-safe PWA.
 *
 * - the manifest is linked, served as a manifest and its `theme_color` matches
 *   the app's `--primary` CSS token
 * - Chrome's own installability checker (`Page.getInstallabilityErrors`) is
 *   clean
 * - going offline serves `/offline.html` for navigations, and the app recovers
 * - API responses are NEVER cached and an offline API fetch fails even when a
 *   stale API entry is manually seeded into the live cache
 * - the `beforeinstallprompt` affordance appears and prompts on click
 */

const USER = { id: 1, username: 'e2e-pwa-user', role: 'admin', mustChangePassword: false };

async function mockApi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('accessToken', 'e2e-pwa-token');
  });
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
      route.fulfill({
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    if (pathname === '/api/auth/session') return json({ success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') return json({ success: true, data: { siteKey: null, enabled: false } });
    // This probe must NOT be mocked: the offline-fetch assertion below needs a
    // real network attempt (which the offline context makes fail).
    if (pathname === '/api/offline-probe') return route.abort('internetdisconnected');
    return json({ success: true, data: [] });
  });
}

async function waitForController(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null), {
      message: 'service worker never took control of the page',
      timeout: 20_000,
    })
    .toMatch(/\/sw\.js$/);
}

function readSwSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../public/sw.js'),
    path.resolve(process.cwd(), 'public/sw.js'),
    path.resolve(process.cwd(), 'frontend/public/sw.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error(`sw.js not found; tried: ${candidates.join(', ')}`);
}

function extractConstant(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\s*=\\s*['"]([^'"]+)['"]`));
  if (!match) throw new Error(`${name} constant not found in sw.js`);
  return match[1];
}

function hslToHex(h: number, s: number, l: number): string {
  const saturation = s / 100;
  const lightness = l / 100;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g] = [c, x];
  else if (h < 120) [r, g] = [x, c];
  else if (h < 180) [g, b] = [c, x];
  else if (h < 240) [g, b] = [x, c];
  else if (h < 300) [r, b] = [x, c];
  else [r, b] = [c, x];
  const hex = (value: number) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

test.describe('PWA installable + offline-safe (checkbox 85)', () => {
  test('manifest is linked, served correctly and matches --primary', async ({ page }) => {
    await mockApi(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();

    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');

    const manifest = await page.evaluate(async () => {
      const response = await fetch('/manifest.webmanifest');
      return {
        contentType: response.headers.get('content-type') ?? '',
        body: (await response.json()) as Record<string, unknown>,
      };
    });
    expect(manifest.contentType).toContain('manifest');
    expect(manifest.body).toMatchObject({
      name: 'TimeMark',
      short_name: 'TimeMark',
      display: 'standalone',
      start_url: '/dashboard',
    });
    const icons = manifest.body.icons as Array<{ sizes: string; type: string }>;
    expect(icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(icons.map((icon) => icon.type)).toEqual(expect.arrayContaining(['image/png']));

    const primary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    );
    const [h, s, l] = primary.split(/\s+/).map((part) => parseFloat(part));
    expect(manifest.body.theme_color).toBe(hslToHex(h, s, l));
  });

  test('passes Chrome installability checks after the worker takes control', async ({ page }) => {
    await mockApi(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
    await waitForController(page);

    const client = await page.context().newCDPSession(page);
    let installabilityErrors: unknown[] = [];
    await expect
      .poll(
        async () => {
          const result = (await client.send('Page.getInstallabilityErrors')) as {
            installabilityErrors?: unknown[];
          };
          installabilityErrors = result.installabilityErrors ?? [];
          return installabilityErrors.length;
        },
        { message: 'Chrome still reports installability errors', timeout: 15_000 },
      )
      .toBe(0);
    expect(installabilityErrors, JSON.stringify(installabilityErrors)).toEqual([]);
    await client.detach();
  });

  test('offline navigation serves offline.html and the app recovers when back online', async ({ page, context }) => {
    await mockApi(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
    await waitForController(page);

    await context.setOffline(true);
    await page.goto('/dashboard').catch(() => {
      // The service worker must answer with the offline page; if it does not,
      // the assertion below fails on Chromium's network error page.
    });
    await expect(page.locator('h1')).toHaveText('当前处于离线状态');

    await context.setOffline(false);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
  });

  test('never caches API responses — a stale seeded API entry is not served offline', async ({ page, context }) => {
    const staticCache = extractConstant(readSwSource(), 'STATIC_CACHE');
    await mockApi(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
    await waitForController(page);

    // (a) after normal app usage no /api/ entry exists in ANY cache
    const apiEntries = await page.evaluate(async () => {
      const found: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (new URL(request.url).pathname.startsWith('/api/')) found.push(request.url);
        }
      }
      return found;
    });
    expect(apiEntries, 'API responses must never be cached').toEqual([]);

    // (b) negative control: seed a stale API response into the live cache.
    // The worker skips /api/* entirely, so an offline fetch must still fail —
    // and if a future change started serving cached API data this test fails.
    await page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName);
      await cache.put(
        '/api/offline-probe',
        new Response('{"success":true,"data":{"stale":true}}', {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }, staticCache);

    await context.setOffline(true);
    const result = await page.evaluate(async () => {
      try {
        const response = await fetch('/api/offline-probe');
        return { failed: false, text: await response.text() };
      } catch {
        return { failed: true, text: '' };
      }
    });
    expect(result.failed, 'offline API request must fail').toBe(true);
    expect(result.text).not.toContain('stale');
  });

  test('the install affordance appears on beforeinstallprompt and prompts on click', async ({ page }) => {
    await mockApi(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();

    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt') as Event & {
        prompt?: () => void;
        userChoice?: Promise<{ outcome: string }>;
      };
      event.prompt = () => {
        (window as unknown as { __installPrompted?: boolean }).__installPrompted = true;
      };
      event.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(event);
    });

    const banner = page.locator('#timemark-install-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('安装 TimeMark 到桌面');

    await page.getByRole('button', { name: '安装', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __installPrompted?: boolean }).__installPrompted ?? false))
      .toBe(true);
    await expect(banner).toHaveCount(0);
  });
});
