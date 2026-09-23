const CACHE = 'order-desk-v1';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache POST/PATCH API calls

  const url = new URL(request.url);
  const isApiCall = ['/signup', '/login', '/orders', '/neworder', '/allclients', '/newclient', '/products', '/addproduct']
    .some(p => url.pathname === p || url.pathname.startsWith(p + '/'));

  if (isApiCall) {
    // API data is always live — network only, no caching of orders/clients/products
    event.respondWith(fetch(request).catch(() => new Response(
      JSON.stringify({ message: 'You are offline. Reconnect to load your data.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }

  // App shell: cache-first, falling back to network, so the UI opens instantly / offline
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
      return res;
    }).catch(() => cached))
  );
});
