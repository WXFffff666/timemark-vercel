import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * Todo 37 + checkbox 85: the service worker must be version-aware and must
 * never be able to serve a stale HTML shell / stale asset bundle.
 *
 * Happy path: the app registers `/sw.js`, the worker claims the page, the
 * running worker's `CACHE_VERSION` matches the served script, and a reload
 * still renders the current bundle.
 *
 * Failure scenario: a stale `/index.html` is seeded into a legacy cache
 * (`v1`) and into a cache named after the current `CACHE_VERSION` *before* the
 * new worker activates. After activation those caches must be gone and the
 * reload must show the real app — never `<html>stale</html>`. The versioned
 * static cache introduced by checkbox 85 may only keep the offline fallback.
 *
 * Stale-version scenario (checkbox 85): an older versioned cache
 * (`timemark-static-v3`) is deleted on activation; only the current
 * `STATIC_CACHE` survives and it already holds `/offline.html`.
 */

const USER = { id: 1, username: 'e2e-sw-user', role: 'admin', mustChangePassword: false };

/** Dev builds call the API cross-origin (http://localhost:3000/api) — fulfilled mocks need CORS headers. */
async function mockApi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('accessToken', 'e2e-sw-token');
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
      route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (pathname === '/api/auth/session') return json({ success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') return json({ success: true, data: { siteKey: null, enabled: false } });
    return json({ success: true, data: [] });
  });
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

function extractCacheVersion(source: string): string {
  return extractConstant(source, 'CACHE_VERSION');
}

async function waitForController(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null), {
      message: 'service worker never took control of the page',
      timeout: 20_000,
    })
    .toMatch(/\/sw\.js$/);
}

/** Ask the *running* worker for its CACHE_VERSION via MessageChannel. */
async function runningWorkerVersion(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const controller = navigator.serviceWorker.controller;
        if (!controller) {
          reject(new Error('no active service worker controller'));
          return;
        }
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error('TIMEMARK_SW_GET_VERSION timed out')), 5_000);
        channel.port1.onmessage = (event: MessageEvent) => {
          clearTimeout(timer);
          resolve(String((event.data as { cacheVersion?: string }).cacheVersion ?? ''));
        };
        controller.postMessage({ type: 'TIMEMARK_SW_GET_VERSION' }, [channel.port2]);
      }),
  );
}

test('service worker takes control, is version-aware and serves the current bundle after a reload', async ({ page }) => {
  const expectedVersion = extractCacheVersion(readSwSource());
  await mockApi(page);

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();

  await waitForController(page);

  // The served script and the running worker agree on the cache version.
  const servedSource = await page.evaluate(async () => (await fetch('/sw.js')).text());
  expect(extractCacheVersion(servedSource)).toBe(expectedVersion);
  expect(await runningWorkerVersion(page)).toBe(expectedVersion);

  await page.reload();
  await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(await runningWorkerVersion(page)).toBe(expectedVersion);
});

test('seeded stale HTML caches are wiped on activation and can never be served', async ({ page }) => {
  const expectedVersion = extractCacheVersion(readSwSource());
  const staticCache = extractConstant(readSwSource(), 'STATIC_CACHE');
  await mockApi(page);

  // Static page that does not boot the app, so nothing registers the worker yet.
  await page.goto('/offline.html');

  const seeded = await page.evaluate(async (currentCache) => {
    // Legacy cache ('v1') + a cache that misleadingly uses the current
    // CACHE_VERSION name. Neither is the live STATIC_CACHE.
    const names = ['v1', currentCache, `${currentCache}-evil`];
    for (const name of names) {
      const cache = await caches.open(name);
      await cache.put(
        '/index.html',
        new Response('<html><body>stale</body></html>', { headers: { 'Content-Type': 'text/html' } }),
      );
    }
    return await caches.keys();
  }, expectedVersion);
  expect(seeded.sort()).toEqual(['v1', expectedVersion, `${expectedVersion}-evil`].sort());

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
  await waitForController(page);

  // activate() deletes every cache that is not the live versioned static cache.
  await expect
    .poll(() => page.evaluate(() => caches.keys()), { timeout: 15_000 })
    .toEqual([staticCache]);

  // No HTML may be cached anywhere — the seeded stale shell is never served.
  const cachedHtml = await page.evaluate(() => caches.match('/index.html').then((hit) => !!hit));
  expect(cachedHtml).toBe(false);

  await page.reload();
  await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('stale');
  expect(await runningWorkerVersion(page)).toBe(expectedVersion);
});

test('an older versioned cache is deleted on activation; the current static cache holds offline.html', async ({ page }) => {
  const expectedVersion = extractCacheVersion(readSwSource());
  const staticCache = extractConstant(readSwSource(), 'STATIC_CACHE');
  await mockApi(page);

  await page.goto('/offline.html');
  const seeded = await page.evaluate(async () => {
    const cache = await caches.open('timemark-static-v3');
    await cache.put('/index.html', new Response('<html><body>old version</body></html>'));
    await cache.put('/offline.html', new Response('<html><body>old offline</body></html>'));
    return await caches.keys();
  });
  expect(seeded).toContain('timemark-static-v3');

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
  await waitForController(page);

  await expect
    .poll(() => page.evaluate(() => caches.keys()), { timeout: 15_000 })
    .toEqual([staticCache]);

  // The live cache contains the real offline fallback, not the stale one.
  const offlineText = await page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    const hit = await cache.match('/offline.html');
    return hit ? await hit.text() : null;
  }, staticCache);
  expect(offlineText).toContain('当前处于离线状态');
  expect(await runningWorkerVersion(page)).toBe(expectedVersion);
});
