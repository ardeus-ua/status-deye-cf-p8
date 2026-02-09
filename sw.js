/**
 * Service Worker для PWA та офлайн кешування
 * Мінімізує запити при поганому з'єднанні
 */

const CACHE_NAME = 'battery-status-v1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png'
];

// Час кешування API відповідей (5 хвилин)
const API_CACHE_TTL = 5 * 60 * 1000;

// Встановлення - кешуємо статичні ресурси
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Активація - видаляємо старі кеші
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// Стратегія fetch: Network First для API, Cache First для статики
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // API запити - Network First з fallback на кеш
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(request)
                .then(response => {
                    // Клонуємо відповідь для кешування
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME)
                        .then(cache => {
                            cache.put(request, responseClone);
                        });
                    return response;
                })
                .catch(() => {
                    // Офлайн - повертаємо з кешу
                    return caches.match(request);
                })
        );
        return;
    }

    // Статичні ресурси - Cache First
    event.respondWith(
        caches.match(request)
            .then(cached => {
                if (cached) {
                    // Оновлюємо кеш у фоні
                    fetch(request).then(response => {
                        caches.open(CACHE_NAME)
                            .then(cache => cache.put(request, response));
                    }).catch(() => { });
                    return cached;
                }
                return fetch(request);
            })
    );
});
