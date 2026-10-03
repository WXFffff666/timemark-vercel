import { expect, test, type Page } from '@playwright/test';

/**
 * Checkbox 84 acceptance — browser Web Push end-to-end (VAPID, NOT FCM).
 *
 * Chromium is granted the notifications permission. `PushManager.subscribe` is
 * stubbed (headless Chromium has no real push service) but the SERVICE WORKER
 * is real: the push is delivered through CDP
 * `ServiceWorker.deliverPushMessage`, the worker's `push` handler runs
 * `showNotification` and forwards the payload to clients, and the
 * `notificationclick` handler (invoked through the same shared function, since
 * Playwright cannot synthesize a real notification click) deep-links the page.
 *
 * A hostile title is carried through verbatim as DATA — no script execution.
 *
 * `channel: 'chromium'` (full Chromium / new headless) is required because the
 * headless *shell* hard-denies notification permission; the new headless mode
 * supports granted notifications and real `showNotification`.
 */

test.use({ channel: 'chromium', permissions: ['notifications'] });

const USER = { id: 1, username: 'e2e-push-user', role: 'admin', mustChangePassword: false };
const VAPID_PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const ENDPOINT = 'https://push.example.com/e2e-subscription-1';
const HOSTILE_TITLE = '<img src=x onerror="window.__pwned=1">生日提醒';

interface PushRecord {
  endpoint: string;
  expirationTime: null;
  keys: { p256dh: string; auth: string };
}

interface Captured {
  subscribe: PushRecord[];
  unsubscribe: unknown[];
  tests: number;
}

async function mockApi(page: Page, captured: Captured): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('accessToken', 'e2e-push-token');
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
      captured.subscribe.push(req.postDataJSON() as PushRecord);
      return json({ success: true, message: 'Subscription saved' });
    }
    if (pathname === '/api/push/unsubscribe') {
      captured.unsubscribe.push(req.postDataJSON());
      return json({ success: true });
    }
    if (pathname === '/api/push/test') {
      captured.tests += 1;
      return json({ success: true, data: { sent: 1, removed: 0, failed: 0 } });
    }
    return json({ success: true, data: [] });
  });
}

/** Headless Chromium has no push service: stub the browser-side subscription. */
async function stubPushManager(page: Page): Promise<void> {
  await page.addInitScript((endpoint) => {
    interface FakeSubscription {
      endpoint: string;
      expirationTime: null;
      options: { userVisibleOnly: boolean; applicationServerKey: null };
      keys: { p256dh: string; auth: string };
      toJSON(): { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
      unsubscribe(): Promise<boolean>;
      getKey(): Promise<null>;
    }
    let created = false;
    const subscription: FakeSubscription = {
      endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey: null },
      keys: { p256dh: 'p256dh-from-browser', auth: 'auth-from-browser' },
      toJSON() {
        return {
          endpoint,
          expirationTime: null,
          keys: { p256dh: this.keys.p256dh, auth: this.keys.auth },
        };
      },
      async unsubscribe() {
        created = false;
        return true;
      },
      async getKey() {
        return null;
      },
    };
    if (window.PushManager) {
      window.PushManager.prototype.subscribe = async () => {
        created = true;
        return subscription as unknown as PushSubscription;
      };
      window.PushManager.prototype.getSubscription = async () =>
        created ? (subscription as unknown as PushSubscription) : null;
    }
  }, ENDPOINT);
}

/** Collect TIMEMARK_PUSH_RECEIVED messages the worker sends to clients. */
async function collectPushEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __timemarkPushEvents: unknown[] };
    w.__timemarkPushEvents = w.__timemarkPushEvents || [];
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const data = (event as MessageEvent).data as { type?: string } | null;
        if (data && data.type === 'TIMEMARK_PUSH_RECEIVED') {
          w.__timemarkPushEvents.push(data);
        }
      });
    }
  });
}

async function readPushEvents(page: Page): Promise<Array<{ payload: Record<string, string> }>> {
  return page.evaluate(
    () =>
      ((window as unknown as { __timemarkPushEvents: Array<{ payload: Record<string, string> }> })
        .__timemarkPushEvents || []),
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

/** Deliver a push through CDP — this runs the REAL service-worker `push` handler. */
async function deliverPush(page: Page, data: string): Promise<void> {
  const client = await page.context().newCDPSession(page);
  const registrationId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service worker registration was never reported')), 10_000);
    client.on('ServiceWorker.workerRegistrationUpdated', (params) => {
      const registrations =
        (params as { registrations?: Array<{ registrationId: string; isDeleted: boolean }> }).registrations ?? [];
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

async function enableBrowserPush(page: Page): Promise<void> {
  const toggle = page.getByRole('switch', { name: '浏览器推送' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByText('已开启浏览器推送')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
}

test('subscribes with VAPID, posts the subscription and sends a test push', async ({ page }) => {
  const captured: Captured = { subscribe: [], unsubscribe: [], tests: 0 };
  await mockApi(page, captured);
  await stubPushManager(page);
  await collectPushEvents(page);

  await page.goto('/settings');
  await enableBrowserPush(page);

  expect(captured.subscribe).toHaveLength(1);
  expect(captured.subscribe[0]).toEqual({
    endpoint: ENDPOINT,
    expirationTime: null,
    keys: { p256dh: 'p256dh-from-browser', auth: 'auth-from-browser' },
  });

  await page.getByRole('button', { name: '发送测试通知' }).click();
  await expect(page.getByText(/测试通知已发送/)).toBeVisible();
  expect(captured.tests).toBe(1);
});

test('receives a push through the service worker: payload asserted, hostile title inert, click deep-links', async ({ page }) => {
  const captured: Captured = { subscribe: [], unsubscribe: [], tests: 0 };
  await mockApi(page, captured);
  await stubPushManager(page);
  await collectPushEvents(page);

  await page.goto('/settings');
  await enableBrowserPush(page);
  await waitForController(page);

  const payload = {
    title: HOSTILE_TITLE,
    body: '这是服务端发来的测试正文',
    url: '/reminders?event=99',
    tag: 'e2e-push',
  };
  await deliverPush(page, JSON.stringify(payload));

  await expect.poll(() => readPushEvents(page).then((events) => events.length)).toBeGreaterThan(0);
  const [received] = await readPushEvents(page);
  expect(received.payload.title).toBe(HOSTILE_TITLE);
  expect(received.payload.body).toBe('这是服务端发来的测试正文');
  expect(received.payload.url).toBe('http://localhost:5173/reminders?event=99');
  expect(received.payload.tag).toBe('e2e-push');

  // The hostile title is carried as data — nothing executed it.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

  // notificationclick path (shared handler): focus the client and deep-link.
  await page.evaluate(() => {
    navigator.serviceWorker.controller?.postMessage({
      type: 'TIMEMARK_SW_SIMULATE_NOTIFICATION_CLICK',
      data: { url: '/reminders?event=99' },
    });
  });
  await page.waitForURL(/\/reminders\?event=99/, { timeout: 15_000 });
});

test('a non-JSON push payload falls back to a text body', async ({ page }) => {
  const captured: Captured = { subscribe: [], unsubscribe: [], tests: 0 };
  await mockApi(page, captured);
  await stubPushManager(page);
  await collectPushEvents(page);

  await page.goto('/settings');
  await enableBrowserPush(page);
  await waitForController(page);

  await deliverPush(page, 'plain-text-push');
  await expect.poll(() => readPushEvents(page).then((events) => events.length)).toBeGreaterThan(0);
  const [received] = await readPushEvents(page);
  expect(received.payload.body).toBe('plain-text-push');
});

test('unsubscribing DELETEs the stored subscription', async ({ page }) => {
  const captured: Captured = { subscribe: [], unsubscribe: [], tests: 0 };
  await mockApi(page, captured);
  await stubPushManager(page);
  await collectPushEvents(page);

  await page.goto('/settings');
  await enableBrowserPush(page);

  const toggle = page.getByRole('switch', { name: '浏览器推送' });
  await toggle.click();
  await expect(page.getByText('已关闭浏览器推送')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  expect(captured.unsubscribe).toEqual([{ endpoint: ENDPOINT }]);
});

/**
 * 「延后」按钮的凭证刷新契约。
 *
 * access cookie 只有 15 分钟（记住我 1 小时），而推送通知是在应用关着时送达的 ——
 * 不换一次凭证就必然 401，按钮等于永远点不动。所以 401 必须：换 refresh cookie
 * → 重试 snooze 一次 → 成功。这里把 snooze 第一次答 401、第二次答 200，断言
 * 「恰好两次 snooze + 恰好一次 refresh」，同时钉住不会重试成风暴。
 */
async function mockSnoozeApi(page: Page, snooze: string[], state: { refreshes: number }): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('accessToken', 'e2e-push-token');
  });
  // service worker 发出的请求不会被 page.route 拦到，必须挂在 context 上
  await page.context().route('**/api/**', (route) => {
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
      route.fulfill({
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    if (pathname === '/api/auth/session') return json({ success: true, data: USER });
    if (pathname === '/api/auth/turnstile-config') return json({ success: true, data: { siteKey: null, enabled: false } });
    if (pathname === '/api/auth/refresh') {
      state.refreshes += 1;
      return json({ success: true, data: USER });
    }
    if (/^\/api\/events\/\d+\/snooze$/.test(pathname)) {
      snooze.push(req.postData() ?? '');
      // 第一次 401（access cookie 过期），换过凭证之后成功
      return snooze.length === 1
        ? json({ success: false, error: 'Unauthorized' }, 401)
        : json({ success: true, data: { snoozedUntil: '2026-10-05T02:10:00.000Z' } });
    }
    return json({ success: true, data: [] });
  });
}

async function gotoControlledPage(page: Page): Promise<void> {
  await stubPushManager(page);
  await collectPushEvents(page);
  await page.goto('/settings');
  await waitForController(page);
}

test('the snooze action refreshes an expired access cookie and retries exactly once', async ({ page }) => {
  const snooze: string[] = [];
  const state = { refreshes: 0 };
  await mockSnoozeApi(page, snooze, state);
  await gotoControlledPage(page);

  await page.evaluate(() =>
    navigator.serviceWorker.controller?.postMessage({ type: 'TIMEMARK_SW_SIMULATE_SNOOZE', data: { eventId: 99 } }),
  );

  await expect.poll(() => snooze.length, { timeout: 20_000 }).toBe(2);
  expect(state.refreshes).toBe(1);
  // 两次都是同一个事件、同一个 10 分钟
  expect(snooze).toEqual([JSON.stringify({ minutes: 10 }), JSON.stringify({ minutes: 10 })]);

  // 不许重试成风暴：再多等一会儿，调用次数不应继续增长
  await page.waitForTimeout(1_000);
  expect(snooze).toHaveLength(2);
  expect(state.refreshes).toBe(1);
});
