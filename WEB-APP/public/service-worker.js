//Le service worker gère le cache pour une expérience hors ligne fluide et des mises à jour efficaces.
//Il pré-cache les ressources essentielles, nettoie les anciens caches lors de l'activation, 
//et utilise des stratégies de cache adaptées pour les différentes requêtes (manifest, navigation, assets). 
//Un canal de message permet à la page de forcer l'activation d'un worker en attente pour une mise à jour rapide.


const CACHE_NAME = 'plant-pwa-v5';
// Fichiers cœur de l'application (app shell) pré-cachés.
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
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
  const isAppShellAsset =
    url.pathname === '/script.js' ||
    url.pathname === '/style.css';

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

  if (isAppShellAsset) {
    // JS/CSS du shell: réseau d'abord pour éviter les incohérences de version.
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

self.addEventListener('notificationclick', (event) => {
  // Ramene l'utilisateur vers l'application lors d'un clic notification.
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) {
        const targetUrl = event.notification?.data?.url || '/';
        return clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
