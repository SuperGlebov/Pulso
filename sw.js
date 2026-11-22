// Atualizar VERSION sempre que os ficheiros da app mudam.
const VERSION = 'pulso-1.0.0';
const SHELL = ['./', './index.html', './dsp.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const HEAVY = ['./mp/vision_bundle.mjs', './mp/vision_wasm_internal.js', './mp/vision_wasm_internal.wasm', './mp/blaze_face_short_range.tflite'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll([...SHELL, ...HEAVY])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // MediaPipe e ícones: cache primeiro. App e modelo: rede primeiro, cache se offline.
  const cacheFirst = url.pathname.includes('/mp/') || url.pathname.endsWith('.png');
  if (cacheFirst) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  } else {
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const cp = r.clone(); caches.open(VERSION).then(c => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
