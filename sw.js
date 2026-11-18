// Cache first, refresh in the background: the app opens at once with no signal
// (inside a pyramid), and an update arrives on the launch after you were online.
const CACHE_NAME = 'pyramid-res-v3';
const ASSETS = ['./', './index.html', './app.js', './modes.js', './manifest.json', './icon.svg',
    './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
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
        const refresh = fetch(req, { cache: 'no-cache' })
            .then((res) => {
                if (res && res.ok) return cache.put(req, res.clone()).then(() => res);
                return res;
            });
        if (hit) {
            event.waitUntil(refresh.catch(() => undefined));
            return hit;
        }
        try {
            return await refresh;
        } catch (e) {
            if (req.mode === 'navigate') {
                const page = await cache.match('./index.html');
                if (page) return page;
            }
            return Response.error();
        }
    })());
});
