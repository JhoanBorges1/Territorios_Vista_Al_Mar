// Service Worker ligero para Territorios VDM.
// No cachea nada: solo permite la instalación como PWA y deja pasar todo a la red.
self.addEventListener('install', function () {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
    var req = event.request;

    // Todo lo que no sea GET va directo a la red (escrituras a Supabase, etc.)
    if (req.method !== 'GET') return;

    var url = new URL(req.url);

    // Supabase siempre directo a la red, sin interferencia del SW
    if (url.hostname.endsWith('.supabase.co')) return;

    // Resto de peticiones GET: pasan a la red tal cual
    event.respondWith(fetch(req));
});
