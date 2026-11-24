/* sw.js — Gestión de Territorios Vista Al Mar
 * - index.html (navegación): Network-First con tiempo límite; si falla la red, usa la copia en caché.
 * - Recursos estáticos (mismo origen y CDNs conocidos): Cache-First.
 * - Supabase (auth, REST, realtime, storage) y cualquier petición con credenciales: NUNCA se interceptan ni se guardan.
 */
const VERSION = 'vdm-v4';
const CACHE_SHELL = VERSION + '-shell';
const CACHE_STATIC = VERSION + '-static';
const MAX_STATIC = 80;
const NETWORK_TIMEOUT_MS = 5000;

const INDEX_URL = new URL('./index.html', self.registration.scope).href;
const SHELL_URLS = [INDEX_URL];
const STATIC_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

const esSupabase = (url) =>
    /(^|\.)supabase\.(co|in|net)$/i.test(url.hostname) ||
    /supabase/i.test(url.hostname) ||
    /\/(auth|rest|realtime|storage|functions|graphql)\/v1(\/|$)/.test(url.pathname);

const cacheable = (res) => {
    if (!res) return false;
    if (res.type === 'opaque') return true;
    if (!res.ok) return false;
    return !/no-store|private/i.test(res.headers.get('Cache-Control') || '');
};

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_SHELL)
            .then((cache) => Promise.all(SHELL_URLS.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_SHELL && k !== CACHE_STATIC).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function fetchConLimite(req, ms) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    return fetch(req, ctrl ? { signal: ctrl.signal } : undefined).finally(() => { if (timer) clearTimeout(timer); });
}

async function networkFirstIndex(req) {
    const cache = await caches.open(CACHE_SHELL);
    try {
        const res = await fetchConLimite(req, NETWORK_TIMEOUT_MS);
        if (cacheable(res) && res.type !== 'opaque') cache.put(INDEX_URL, res.clone()).catch(() => {});
        return res;
    } catch (err) {
        const copia = (await cache.match(INDEX_URL)) || (await cache.match(req, { ignoreSearch: true }));
        if (copia) return copia;
        return new Response('Sin conexión y sin copia guardada de la aplicación.', {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
}

async function recortar(cache) {
    const keys = await cache.keys();
    if (keys.length > MAX_STATIC) await Promise.all(keys.slice(0, keys.length - MAX_STATIC).map((k) => cache.delete(k)));
}

async function cacheFirst(req) {
    const cache = await caches.open(CACHE_STATIC);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
        const res = await fetch(req);
        if (cacheable(res)) { cache.put(req, res.clone()).then(() => recortar(cache)).catch(() => {}); }
        return res;
    } catch (err) {
        return Response.error();
    }
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    let url;
    try { url = new URL(req.url); } catch (e) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    // Nunca interceptar Supabase ni peticiones autenticadas: sin caché de sesiones ni datos privados
    if (esSupabase(url) || req.headers.has('authorization') || req.headers.has('apikey')) return;

    const mismoOrigen = url.origin === self.location.origin;
    if (mismoOrigen && url.pathname.endsWith('/sw.js')) return;

    const esIndex = mismoOrigen && (req.mode === 'navigate' || req.destination === 'document' ||
        /\/$/.test(url.pathname) || /\/index\.html$/.test(url.pathname));

    if (esIndex) { event.respondWith(networkFirstIndex(req)); return; }
    if (mismoOrigen || STATIC_HOSTS.includes(url.hostname)) { event.respondWith(cacheFirst(req)); }
});
