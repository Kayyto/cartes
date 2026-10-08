// Service worker de Cartes (v3).
// - Jamais de cache pour /api/* (données de la personne connectée) ni pour les pages de connexion.
// - Pages et fichiers : le réseau d'abord, la copie locale seulement hors ligne.
const CACHE_NAME = 'cartes-v3';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // toujours le réseau, jamais de cache
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match('./index.html')))
  );
});
