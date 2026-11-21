// Offline first. Every file is fetched once, together, when this worker installs,
// and is then served only from that cache: the app opens at once with no signal and
// can never be a mix of two versions. To release a change, change VERSION here and
// BUILD in app.js (and RELEASED in both): a changed sw.js is what makes a phone fetch the new set.
const VERSION = '2.2.1';
const RELEASED = '2026-11-21T17:50:00Z';   // when this version was published; the same value is in app.js
const CACHE_NAME = 'pyramid-res-' + VERSION;
const ASSETS = ['./', './index.html', './app.js', './modes.js', './records.js', './manifest.json', './icon.svg',
    './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
    // all or nothing: if one file fails, the old version stays in charge
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
            .then(() => self.skipWaiting())
            .catch((err) => caches.delete(CACHE_NAME).then(() => { throw err; }))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        try {
            return await fetch(req);
        } catch (e) {
            if (req.mode === 'navigate') {
                const page = await cache.match('./index.html');
                if (page) return page;
            }
            return Response.error();
        }
    })());
});
