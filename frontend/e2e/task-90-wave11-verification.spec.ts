import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Task 90 (wave 11 verification) — INDEPENDENT Playwright pass.
 *
 * RT1: a push delivered through CDP `ServiceWorker.deliverPushMessage` runs the
 *      REAL service-worker `push` handler: the notification is observable via
 *      `self.registration.getNotifications()` (not just the forwarded message),
 *      the hostile title is carried as inert DATA, and the shared click handler
 *      deep-links the page. The push payload JSON is written to the evidence dir
 *      when TASK90_EVIDENCE_DIR is set.
 * RT2: an offline navigation (including a route never visited before) is served
 *      `/offline.html` by the worker, and the app recovers online. The offline
 *      screenshot is written to the evidence dir when TASK90_EVIDENCE_DIR is set.
 *
 * Negative controls (so the assertions cannot pass vacuously):
 *  - BEFORE delivery: 0 notifications, 0 forwarded push events, URL unchanged.
 *  - a bogus message type carrying a deep link must NOT navigate the page.
 *  - the offline assertion runs only after the worker is in control: if the
 *    offline fallback did not exist, Chromium's network-error page fails the h1
 *    assertion; if the app shell were served, the offline h1 assertion fails.
 *
 * Artifacts are written only when TASK90_EVIDENCE_DIR is set (CI-safe).
 */

const USER = { id: 1, username: 'e2e-task90-user', role: 'admin', mustChangePassword: false };
const VAPID_PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const ENDPOINT = 'https://push.example.com/task-90-subscription';
const HOSTILE_TITLE = '<img src=x onerror="window.__pwned=1">生日提醒';

const EVIDENCE_DIR = process.env.TASK90_EVIDENCE_DIR ?? null;
function writeEvidence(fileName: string, contents: string | Buffer): void {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, fileName), contents);
}

interface Captured {
  subscribe: unknown[];
}

async function mockApi(page: Page, captured: Captured): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('accessToken', 'e2e-task90-token');
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
    if (pathname === '/api/push/vapid-key') return json({ success: true, data: { publicKey: VAPID_PUBLIC_KEY } });
    if (pathname === '/api/push/subscribe' && req.method() === 'POST') {
      captured.subscribe.push(req.postDataJSON());
      return json({ success: true, message: 'Subscription saved' });
    }
    return json({ success: true, data: [] });
  });
}

/** Headless Chromium has no push service: stub the browser-side subscription only. */
async function stubPushManager(page: Page): Promise<void> {
  await page.addInitScript((endpoint) => {
    interface FakeSubscription {
      endpoint: string;
      toJSON(): { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
      unsubscribe(): Promise<boolean>;
    }
    const subscription: FakeSubscription = {
      endpoint,
      toJSON() {
        return { endpoint, expirationTime: null, keys: { p256dh: 'p256dh', auth: 'auth' } };
      },
      async unsubscribe() {
        return true;
      },
    };
    if (window.PushManager) {
      window.PushManager.prototype.subscribe = async () => subscription as unknown as PushSubscription;
      window.PushManager.prototype.getSubscription = async () => subscription as unknown as PushSubscription;
    }
  }, ENDPOINT);
}

async function collectPushEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __timemarkPushEvents: unknown[] };
    w.__timemarkPushEvents = w.__timemarkPushEvents || [];
    navigator.serviceWorker?.addEventListener('message', (event) => {
      const data = (event as MessageEvent).data as { type?: string } | null;
      if (data && data.type === 'TIMEMARK_PUSH_RECEIVED') w.__timemarkPushEvents.push(data);
    });
  });
}

async function readPushEvents(page: Page): Promise<Array<{ payload: Record<string, string> }>> {
  return page.evaluate(
    () =>
      ((window as unknown as { __timemarkPushEvents: Array<{ payload: Record<string, string> }> }).__timemarkPushEvents ||
        []),
  );
}

async function waitForController(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null), {
      message: 'service worker never took control of the page',
      timeout: 20_000,
    })
    .toMatch(/\/sw\.js$/);
}

/** Deliver a push through CDP — runs the REAL service-worker `push` handler. */
async function deliverPush(page: Page, data: string): Promise<void> {
  const client = await page.context().newCDPSession(page);
  const registrationId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service worker registration was never reported')), 10_000);
    client.on('ServiceWorker.workerRegistrationUpdated', (params) => {
      const registrations = (params as { registrations?: Array<{ registrationId: string; isDeleted: boolean }> })
        .registrations ?? [];
      const active = registrations.find((registration) => !registration.isDeleted);
      if (active) {
        clearTimeout(timer);
        resolve(active.registrationId);
      }
    });
    client.send('ServiceWorker.enable').catch(reject);
  });
  await client.send('ServiceWorker.deliverPushMessage', {
    origin: new URL(page.url()).origin,
    registrationId,
    data,
  });
  await client.detach();
}

/** Read the notification the WORKER actually showed (not a forwarded message). */
async function readWorkerNotifications(page: Page): Promise<Array<{ title: string; body: string; tag: string; url: string }>> {
  const context = page.context();
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return (await sw.evaluate(async () => {
    const notifications = await self.registration.getNotifications();
    return notifications.map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      url: String((n.data as { url?: string } | null)?.url ?? ''),
    }));
  })) as Array<{ title: string; body: string; tag: string; url: string }>;
}

test.use({ channel: 'chromium', permissions: ['notifications'] });

test.describe('task 90 RT1 — Web Push through the real service worker', () => {
  test('push is delivered, shown by the worker, inert, and clickable to the deep link', async ({ page }) => {
    const captured: Captured = { subscribe: [] };
    await mockApi(page, captured);
    await stubPushManager(page);
    await collectPushEvents(page);

    await page.goto('/settings');
    await waitForController(page);

    // NEGATIVE CONTROL (pre-delivery): nothing has been shown or forwarded yet.
    expect(await readWorkerNotifications(page)).toEqual([]);
    expect(await readPushEvents(page)).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/settings');

    const payload = {
      title: HOSTILE_TITLE,
      body: '这是服务端发来的测试正文',
      url: '/reminders?event=99',
      tag: 'task-90-push',
    };
    const payloadJson = JSON.stringify(payload);
    await deliverPush(page, payloadJson);

    // 1. The REAL worker ran `push` and called showNotification with the payload.
    await expect.poll(() => readWorkerNotifications(page).then((n) => n.length)).toBe(1);
    const [notification] = await readWorkerNotifications(page);
    expect(notification.title).toBe(HOSTILE_TITLE);
    expect(notification.body).toBe('这是服务端发来的测试正文');
    expect(notification.tag).toBe('task-90-push');
    expect(notification.url).toBe('http://localhost:5173/reminders?event=99');

    // 2. The worker also forwarded the parsed payload to the page.
    await expect.poll(() => readPushEvents(page).then((events) => events.length)).toBeGreaterThan(0);
    const [received] = await readPushEvents(page);
    expect(received.payload.title).toBe(HOSTILE_TITLE);
    expect(received.payload.url).toBe('http://localhost:5173/reminders?event=99');

    // 3. The hostile title is DATA: nothing executed it.
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

    // NEGATIVE CONTROL (handler sensitivity): a bogus message must NOT navigate.
    await page.evaluate(() => {
      navigator.serviceWorker.controller?.postMessage({ type: 'NOT_THE_CLICK_HANDLER', data: { url: '/evil' } });
    });
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname).toBe('/settings');

    // 4. The notificationclick handler (same function the real event runs) deep-links.
    await page.evaluate(() => {
      navigator.serviceWorker.controller?.postMessage({
        type: 'TIMEMARK_SW_SIMULATE_NOTIFICATION_CLICK',
        data: { url: '/reminders?event=99' },
      });
    });
    await page.waitForURL(/\/reminders\?event=99/, { timeout: 15_000 });

    // ARTEFACT: the push payload JSON (delivered bytes + worker-observed values).
    writeEvidence(
      'task-90-push-payload.json',
      JSON.stringify(
        {
          deliveredVia: 'CDP ServiceWorker.deliverPushMessage',
          deliveredPayload: payload,
          deliveredPayloadJson: payloadJson,
          workerNotification: notification,
          forwardedToClient: received?.payload ?? null,
          clickTarget: 'http://localhost:5173/reminders?event=99',
          hostileTitleExecuted: false,
        },
        null,
        2,
      ),
    );
  });
});

test.describe('task 90 RT2 — offline shell then recovery', () => {
  test('offline navigation (including an uncached route) serves offline.html; online nav recovers', async ({ page, context }) => {
    const captured: Captured = { subscribe: [] };
    await mockApi(page, captured);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
    await waitForController(page);

    await context.setOffline(true);
    await page.goto('/dashboard').catch(() => {
      // The worker must answer with the offline page; otherwise Chromium's
      // network-error page fails the h1 assertion below.
    });
    await expect(page.locator('h1')).toHaveText('当前处于离线状态');

    // ADVERSARIAL: a route that was NEVER visited/cached still gets the shell.
    await page.goto('/never-visited-route-90').catch(() => {});
    await expect(page.locator('h1')).toHaveText('当前处于离线状态');

    writeEvidence('task-90-offline.png', await page.screenshot({ fullPage: false }));

    await context.setOffline(false);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '我的倒计时' })).toBeVisible();
  });
});
