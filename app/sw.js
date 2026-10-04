/* Service worker: precaches the app shell, serves it cache-first, and
 * waits for the page to say SKIP_WAITING before taking over (so an update
 * never swaps code out from under an in-progress set).
 *
 * VERSION must change on every deploy. The deploy workflow stamps BUILD
 * with the commit SHA automatically; bump VERSION by hand for local testing.
 */
const VERSION = '1.0.0';
const BUILD = 'dev';
const CACHE = `wl-shell-${VERSION}-${BUILD}`;

const SHELL = [
  './',
  './app.js',
  './styles.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // cache: 'reload' bypasses the HTTP cache so a new version never precaches stale files.
      cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('wl-shell-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only the app's own static files. API calls (Apps Script, /api/*) go straight to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./', { cacheName: CACHE }).then((hit) => hit || fetch(req)),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((hit) => hit || fetch(req)),
  );
});

// Rest alert from the Worker. iOS requires every push to show a notification.
self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Rest over', {
    body: 'Time for your next set',
    tag: 'rest',        // each alert replaces the previous one
    renotify: true,     // ...and still buzzes
    icon: 'icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return self.clients.openWindow('./');
  })());
});
