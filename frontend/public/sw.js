/**
 * TimeMark service worker — offline-safe shell + Web Push (checkboxes 84/85).
 *
 * Caching rules:
 * - ONE versioned cache (`STATIC_CACHE`) holds the offline fallback page and
 *   runtime copies of same-origin static assets (scripts/styles/images/fonts).
 * - API responses are NEVER intercepted and NEVER cached (`/api/*` is skipped).
 * - The app shell HTML is NEVER cached; navigations are network-first and fall
 *   back to `/offline.html` when the network is unavailable.
 * - `activate` deletes every cache that is not the current `STATIC_CACHE`, so an
 *   older worker version can never serve stale content.
 *
 * Push rules:
 * - `push` shows the notification and forwards the parsed payload to open
 *   clients (`TIMEMARK_PUSH_RECEIVED`) so the app/e2e can observe it.
 * - `notificationclick` deep-links to `payload.url` (same-origin only).
 * - `TIMEMARK_SW_SIMULATE_NOTIFICATION_CLICK` invokes the exact same click
 *   handler; Playwright/CDP cannot synthesize a real notification click.
 */

const CACHE_VERSION = 'timemark-v4';
const STATIC_CACHE = 'timemark-static-v4';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(STATIC_CACHE);
        await cache.add(OFFLINE_URL);
      } catch {
        // Precache is best-effort: a failed install must not brick the worker.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isCacheableAsset(request, url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false; // API responses are never cached
  return ['script', 'style', 'image', 'font', 'manifest'].includes(request.destination);
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: STATIC_CACHE });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok && response.type === 'basic') {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function navigationResponse(request) {
  try {
    // Network first. The response is intentionally NOT written to the cache:
    // HTML must never be served stale.
    return await fetch(request);
  } catch {
    const offline = await caches.match(OFFLINE_URL, { cacheName: STATIC_CACHE });
    if (offline) return offline;
    throw new Error('offline and no cached fallback');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never intercept (thus never cache) API

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (isCacheableAsset(request, url)) {
    event.respondWith(cacheFirst(request));
  }
});

/** Same-origin guard for deep links coming from push payloads. */
function sanitizeNotificationUrl(raw) {
  try {
    const target = new URL(String(raw || '/reminders'), self.location.origin);
    if (target.origin !== self.location.origin) return self.location.origin + '/reminders';
    return target.href;
  } catch {
    return self.location.origin + '/reminders';
  }
}

async function notifyClients(payload) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    client.postMessage({ type: 'TIMEMARK_PUSH_RECEIVED', payload });
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload = { title: 'TimeMark', body: '你有一条新提醒', url: '/reminders' };
      try {
        const data = event.data ? event.data.json() : null;
        if (data && typeof data === 'object') payload = { ...payload, ...data };
      } catch {
        try {
          if (event.data) payload.body = event.data.text();
        } catch {
          // keep defaults
        }
      }
      // Strings only — rendered by the browser as plain text, never executed.
      const title = String(payload.title || 'TimeMark');
      const body = String(payload.body || '');
      const target = sanitizeNotificationUrl(payload.url);
      await self.registration.showNotification(title, {
        body,
        icon: typeof payload.icon === 'string' ? payload.icon : '/favicon.svg',
        badge: typeof payload.badge === 'string' ? payload.badge : '/favicon.svg',
        tag: typeof payload.tag === 'string' ? payload.tag : 'timemark',
        data: { url: target },
      });
      await notifyClients({ ...payload, title, body, url: target });
    })(),
  );
});

/**
 * Focus an existing window and navigate it to the deep link, or open a new one.
 * Shared by the real `notificationclick` event and the e2e message hook.
 *
 * `navigate()` runs before `focus()`: in headless test runs `focus()` can
 * resolve to null (a no-op), which must not swallow the deep link.
 */
async function handleNotificationClick(data) {
  const url = sanitizeNotificationUrl(data && data.url);
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    try {
      if ('navigate' in client && client.url !== url) {
        const navigated = await client.navigate(url);
        if (navigated) {
          if ('focus' in navigated) {
            try {
              await navigated.focus();
            } catch {
              // Focus is best-effort; the deep link already happened.
            }
          }
          return;
        }
      } else if ('focus' in client) {
        await client.focus();
        return;
      }
    } catch {
      // try the next client / the openWindow fallback
    }
  }
  await self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event.notification.data || {}));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'TIMEMARK_SW_GET_VERSION') {
    const reply = { type: 'TIMEMARK_SW_VERSION', cacheVersion: CACHE_VERSION };
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(reply);
    } else if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(reply);
    }
    return;
  }
  // E2E hook: Playwright cannot synthesize a real notificationclick; this calls
  // the exact same handler the real event uses.
  if (event.data && event.data.type === 'TIMEMARK_SW_SIMULATE_NOTIFICATION_CLICK') {
    event.waitUntil(handleNotificationClick(event.data.data || {}));
  }
});
