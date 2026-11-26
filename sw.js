/* ==========================================================================
 * sw.js — Service Worker · Gestión de Territorios Vista Al Mar
 *
 * Estrategia:
 *  - Archivos propios (index.html, styles.css, supabase.js, app.js, icono.png):
 *    RED PRIMERO (siempre intenta traer la última versión) y, si no hay red o tarda
 *    demasiado, usa la copia guardada. Así la app abre sin conexión y las
 *    actualizaciones llegan en cuanto hay internet.
 *  - Librerías y fuentes de CDN (supabase-js, html2canvas, Google Fonts):
 *    CACHÉ PRIMERO + actualización en segundo plano (la app abre sin conexión).
 *  - Supabase (API, login, sincronización) y cualquier otro dominio: NO se intercepta.
 *
 * AL PUBLICAR CAMBIOS: sube VERSION (aquí) y el "?v=" de index.html al mismo valor.
 * Se activa solo (skipWaiting + claim) y también responde al mensaje 'SKIP_WAITING'
 * que envía el botón "Actualizar app" de la configuración.
 * ========================================================================== */

const VERSION = '2026.11.25';
const PREFIJO_CACHE = 'territorios-vdm-';
const CACHE = PREFIJO_CACHE + VERSION;

const BASE = new URL('./', self.location.href).href;          // carpeta donde está sw.js
const NUCLEO = ['', 'index.html', 'styles.css', 'supabase.js', 'app.js', 'icono.png'].map(p => BASE + p);
const HOSTS_CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const ESPERA_RED_MS = 4000;                                     // si la red tarda más, se usa la copia guardada

// Clave de caché sin "?v=..." para que cada archivo tenga una sola copia
const claveDe = url => { const u = new URL(url); return u.origin + u.pathname; };

/* ---------- Instalación: guarda el núcleo (tolerante: un fallo no impide instalar) ---------- */
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await Promise.allSettled(NUCLEO.map(async url => {
            const resp = await fetch(new Request(url, { cache: 'reload' }));
            if (resp && resp.ok) await cache.put(claveDe(url), resp);
        }));
        await self.skipWaiting();
    })());
});

/* ---------- Activación: limpia cachés antiguas de ESTA app y toma el control ---------- */
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const nombres = await caches.keys();
        await Promise.all(nombres.filter(n => n.startsWith(PREFIJO_CACHE) && n !== CACHE).map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('message', event => {
    const d = event.data;
    if (d === 'SKIP_WAITING' || (d && d.type === 'SKIP_WAITING')) self.skipWaiting();
});

/* ---------- Peticiones ---------- */
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    if (url.origin === self.location.origin) {
        if (!url.href.startsWith(BASE)) return;                  // fuera de la carpeta de la app
        event.respondWith(redPrimero(req));
    } else if (HOSTS_CDN.includes(url.hostname)) {
        event.respondWith(cachePrimeroYRefresca(event, req));
    }
    // Supabase y demás dominios: el navegador los gestiona directamente
});

async function redPrimero(req) {
    const cache = await caches.open(CACHE);
    const clave = claveDe(req.url);
    const buscarCopia = async () =>
        (await cache.match(clave)) ||
        (req.mode === 'navigate' ? ((await cache.match(BASE + 'index.html')) || (await cache.match(BASE))) : undefined);

    // no-cache: revalida contra el servidor (evita servir archivos viejos de la caché HTTP del navegador)
    const red = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(resp => {
        if (resp && resp.ok) cache.put(clave, resp.clone());
        return resp;
    });
    const limite = new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('lento')), ESPERA_RED_MS));
    try {
        return await Promise.race([red, limite]);
    } catch (e) {
        const copia = await buscarCopia();
        if (copia) { red.catch(() => {}); return copia; }
        return red;                                              // sin copia: esperar a la red (o fallar como siempre)
    }
}

async function cachePrimeroYRefresca(event, req) {
    const cache = await caches.open(CACHE);
    const copia = await cache.match(req.url);
    const actualizar = fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }))
        .catch(() => fetch(req))
        .then(resp => { if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req.url, resp.clone()); return resp; })
        .catch(() => null);
    if (copia) { event.waitUntil(actualizar); return copia; }
    return (await actualizar) || Response.error();
}
