const CACHE = 'pi-remote-shell-v11';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/helpers.js', '/seal.js', '/vendor/noble/chacha.js', '/vendor/noble/_arx.js', '/vendor/noble/_poly1305.js', '/vendor/noble/utils.js', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('pi-remote-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Credentials, API responses, and arbitrary resources never enter the shell cache.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname) || event.request.headers.has('Authorization')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, copy)));
    }
    return response;
  }).catch(async () => (await caches.match(url.pathname)) || Response.error()));
});
