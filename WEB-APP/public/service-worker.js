const CACHE_NAME = 'plant-pwa-v4';
// Fichiers cœur de l'application (app shell) pré-cachés.
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  // Installation SW: pré-cache de l'app shell puis activation accélérée.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Activation SW: nettoyage des anciens caches + prise de contrôle immédiate.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  // Canal de contrôle depuis la page pour activer un worker en attente.
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  // Stratégie réseau/cache selon le type de requête (assets, navigation, autres).
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  const isManifestOrIcon =
    url.pathname === '/manifest.webmanifest' ||
    url.pathname.startsWith('/icons/');

  if (isManifestOrIcon) {
    // Manifest/icônes: réseau d'abord pour capter les mises à jour visuelles.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  if (request.mode === 'navigate') {
    // Navigation HTML: réseau d'abord avec fallback sur l'index en cache.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    // Assets génériques: cache d'abord, sinon réseau puis mise en cache.
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          return response;
        })
        .catch(() => caches.match('/index.html'));
    })
  );
});
