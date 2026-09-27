/**
 * TimeMark service worker — deliberately cache-free (safe mode, todo 37).
 *
 * Web Push was removed from the cloud (Vercel) edition; todo 84 will re-add the
 * push/notificationclick handlers. Until then this worker only needs to be
 * *safe*: it must never be able to serve a stale HTML shell or a stale hashed
 * asset bundle.
 *
 * Rules:
 * - `CACHE_VERSION` identifies this worker build. It is echoed back over
 *   `postMessage` so the e2e suite can assert the running worker matches the
 *   served script.
 * - `install` skips waiting so a new worker takes over immediately.
 * - `activate` deletes EVERY cache (this worker never writes one) and calls
 *   `clients.claim()` so already-open pages are controlled without a reload.
 * - `fetch` handles same-origin navigation with a plain network fetch. It never
 *   reads from and never writes to the Cache Storage, so a previously installed
 *   worker (or a seeded stale cache) can never win. Non-navigation requests are
 *   not intercepted at all.
 */

const CACHE_VERSION = 'timemark-v3';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (request.mode === 'navigate' && url.origin === self.location.origin) {
    // Network only. Never cache HTML, never read the cache — no stale bundle.
    event.respondWith(fetch(request));
  }

  // Everything else (hashed JS/CSS, API, cross-origin): default browser handling.
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'TIMEMARK_SW_GET_VERSION') {
    const reply = { type: 'TIMEMARK_SW_VERSION', cacheVersion: CACHE_VERSION };
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(reply);
    } else if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(reply);
    }
  }
});
