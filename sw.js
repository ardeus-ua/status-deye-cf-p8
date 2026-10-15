/**
 * Service Worker для PWA та офлайн-режиму
 *
 * - Сторінка (навігація): спершу мережа, кеш — тільки без зв'язку. Інакше зі старого кешу могла
 *   відкритись застаріла сторінка зі старими посиланнями на іконки.
 * - app.js, manifest.json: так само — мережа, без зв'язку кеш (інакше нова сторінка могла б
 *   на одне відкриття отримати старий app.js).
 * - /api/: мережа, без зв'язку — остання відповідь з кешу.
 * - Іконки та інше не перехоплюємо: браузер і iOS беруть їх напряму.
 * У кеш кладемо тільки успішні відповіді потрібного типу: Cloudflare Pages на відсутній файл міг
 * віддати HTML з кодом 200, і такий «файл» більше не потрапить у кеш замість картинки чи скрипта.
 */

const CACHE_NAME = 'battery-status-p8-v3';
const PAGE = '/';
const STATIC_ASSETS = ['/app.js', '/manifest.json'];

function cacheable(request, response) {
    if (!response || !response.ok || response.type !== 'basic') return false;
    const type = response.headers.get('Content-Type') || '';
    const wantsHtml = request.mode === 'navigate' || new URL(request.url).pathname === PAGE;
    return wantsHtml ? type.includes('text/html') : !type.includes('text/html');
}

async function put(request, response) {
    if (!cacheable(request, response)) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
}

// Встановлення — кешуємо сторінку й статику (тільки валідні відповіді, в обхід HTTP-кешу)
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        await Promise.all([PAGE, ...STATIC_ASSETS].map(async path => {
            const request = new Request(path, { cache: 'reload' });
            try { await put(request, await fetch(request)); } catch (e) { }
        }));
        await self.skipWaiting();
    })());
});

// Активація — видаляємо старі кеші
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== location.origin) return;

    // Сторінка: мережа, без зв'язку — кеш
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(response => { put(new Request(PAGE), response.clone()); return response; })
                .catch(() => caches.match(PAGE))
        );
        return;
    }

    // API: мережа, без зв'язку — остання відповідь
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(request)
                .then(response => { put(request, response.clone()); return response; })
                .catch(() => caches.match(request))
        );
        return;
    }

    // app.js, manifest.json: мережа, без зв'язку — кеш
    if (STATIC_ASSETS.includes(url.pathname)) {
        event.respondWith(
            fetch(request)
                .then(response => { put(request, response.clone()); return response; })
                .catch(() => caches.match(request))
        );
    }
    // Іконки й решту не перехоплюємо
});
