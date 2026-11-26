/* ==========================================================================
 * app.js — Gestión de Territorios Vista Al Mar
 * Lógica principal: PWA (manifest, instalación, Service Worker), estado global,
 * validación, QR, preferencias, conductores/territorios, generación de agendas,
 * Contactar, historial, modo Exhibidores, modales, ayuda y renderizado de vistas.
 *
 * Se carga DESPUÉS de supabase.js (usa supabaseClient, _sesionActiva, _rol, _verBase,
 * sincronizarNube, leerNube, etc.). Todo está en ámbito global porque el HTML usa
 * manejadores inline (onclick="...").
 * ========================================================================== */

// === PWA: manifest dinámico, iconos, Service Worker e instalación (todo autocontenido) ===
var deferredPrompt = null;

function esAppInstalada() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}
function actualizarBotonInstalar() {
    var b = document.getElementById('btnInstalarApp');
    if (!b) return;
    b.classList.toggle('hidden', !deferredPrompt || esAppInstalada());
}
window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    actualizarBotonInstalar();
});
window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    actualizarBotonInstalar();
});
document.addEventListener('DOMContentLoaded', actualizarBotonInstalar);

async function instalarPWA() {
    if (!deferredPrompt) return;
    if (typeof cerrarMenu === 'function') cerrarMenu();
    var ev = deferredPrompt;
    deferredPrompt = null;
    try {
        ev.prompt();
        await ev.userChoice;
    } catch (err) { /* instalación cancelada o no disponible */ }
    actualizarBotonInstalar();
}

(function () {
    // Manifest dinámico: icono real ./icono.png (misma carpeta que index.html)
    if (location.protocol === 'http:' || location.protocol === 'https:') {
        try {
            var base = location.origin + location.pathname;
            var manifest = {
                name: 'Gestión de Territorios Vista Al Mar',
                short_name: 'Territorios VDM',
                start_url: base,
                scope: base.replace(/[^\/]*$/, ''),
                display: 'standalone',
                background_color: '#f8fafd',
                theme_color: '#0b57d0',
                icons: [
                    { src: new URL('./icono.png', location.href).href, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
                ]
            };
            var blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
            var l = document.createElement('link');
            l.rel = 'manifest';
            l.href = URL.createObjectURL(blob);
            document.head.appendChild(l);
        } catch (err) { /* manifest no disponible */ }
    }

    // Service Worker: archivo ./sw.js (publicar junto a index.html)
    var seguro = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (seguro && 'serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('./sw.js').catch(function () { /* sin Service Worker */ });
        });
    }
})();

// ==========================================================================
// APLICACIÓN
// ==========================================================================
// === MÓDULO 3: ESTADO GLOBAL, VALIDACIÓN Y CACHÉ LOCAL ===
let _ultAlertaInv = 0, _ultAvisoLector = 0;   // (_rol, _rolListo y _verBase se declaran en supabase.js)
function avisoLector() { if (Date.now() - _ultAvisoLector < 3000) return; _ultAvisoLector = Date.now(); mostrarToast('Tu cuenta es de solo lectura: no puedes modificar datos.', 'error'); }
function _bloqueadoLector() { if (puedeEditar()) return false; avisoLector(); return true; }

// Valida la estructura crítica antes de escribir en localStorage o Supabase
function validarEstadoApp(p) {
    const e = [], esObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (!esObj(p)) return { ok: false, errores: ['El estado no es un objeto válido.'] };
    const lista = (o, k, n) => { if (!Array.isArray(o[k])) { e.push(`«${n}» debe ser una lista`); return []; } return o[k]; };
    const objeto = (o, k, n) => { if (!esObj(o[k])) { e.push(`«${n}» debe ser un objeto`); return {}; } return o[k]; };
    const cond = lista(p, 'conductores', 'conductores y grupos'); lista(p, 'territorios', 'territorios'); lista(p, 'actividad', 'actividad');
    const bor = objeto(p, 'borradores', 'agendas'), his = objeto(p, 'historial', 'historial'); objeto(p, 'excepciones', 'excepciones'); objeto(p, 'config', 'configuración');
    cond.forEach((c, i) => { if (!esObj(c)) e.push(`conductor #${i + 1} incompleto`); else if (c.ausencias !== undefined && !Array.isArray(c.ausencias)) e.push(`ausencias de conductor #${i + 1} inválidas`); });
    Object.keys(bor).forEach(k => { if (!Array.isArray(bor[k])) e.push(`agenda «${k}» dañada`); });
    Object.keys(his).forEach(k => { if (!Array.isArray(his[k])) e.push(`historial «${k}» dañado`); });
    if (!esObj(p.exhibidores)) e.push('«exhibidores» debe ser un objeto');
    else { const x = p.exhibidores; lista(x, 'participantes', 'participantes de exhibidores'); lista(x, 'lugares', 'lugares de exhibidores'); objeto(x, 'agendas', 'agendas de exhibidores'); objeto(x, 'historial', 'historial de exhibidores'); objeto(x, 'config', 'configuración de exhibidores'); }
    if (p.version !== undefined && !Number.isFinite(p.version)) e.push('versión inválida');
    return { ok: e.length === 0, errores: e };
}
function alertaEstadoInvalido(errs) {
    if (Date.now() - _ultAlertaInv < 8000) return; _ultAlertaInv = Date.now();
    avisar('Se canceló el guardado para proteger tus datos: la información está incompleta o dañada. Detalle: ' + errs.slice(0, 4).join(' · '));
}

// === CSS PARA LAS VENTANAS DE EXPORTACIÓN (PDF) ===
// Los estilos viven en styles.css: se guarda el texto una vez cargada la página para inyectarlo
// en la ventana de impresión (funciona también sin conexión gracias al Service Worker).
let _cssTexto = '';
function cssDeLaApp() {
    if (_cssTexto) return _cssTexto;
    let out = '';
    Array.from(document.styleSheets).forEach(h => { try { out += Array.from(h.cssRules).map(r => r.cssText).join('\n') + '\n'; } catch (e) { /* hoja externa (fuentes): se omite */ } });
    return out || Array.from(document.querySelectorAll('style')).map(x => x.textContent).join('\n');
}
function precargarCSS() {
    const l = document.querySelector('link[rel="stylesheet"][href*="styles.css"]');
    if (!l || !window.fetch) return;
    fetch(l.href).then(r => r.ok ? r.text() : '').then(t => { if (t) _cssTexto = t; }).catch(() => {});
}
window.addEventListener('load', precargarCSS);

// Minimización de datos: ninguna exportación pública lleva teléfonos ni correos
function sinDatosContacto(s) {
    return String(s ?? '').replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '').replace(/(?<![\d-])(?:\+\d{1,3}[\s.-]?)?\(?\d{3,4}\)?[\s.-]?\d{3}[\s.-]?\d{3,4}(?![\d-])/g, '');
}
function purgarContactoDOM(el) {
    el.querySelectorAll('a[href^="tel:"],a[href^="mailto:"],a[href*="wa.me"],a[href*="whatsapp"]').forEach(a => a.remove());
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), ns = []; while (w.nextNode()) ns.push(w.currentNode);
    ns.forEach(n => { const t = sinDatosContacto(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; });
}

function togglePasswordVisibility() {
    const passInput = document.getElementById('auth-pass');
    const eyeIcon = document.getElementById('eye-icon');
    
    if (passInput.type === 'password') {
        passInput.type = 'text';
        eyeIcon.innerHTML = `
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                <line x1="1" y1="1" x2="23" y2="23"></line>
            `;
    } else {
        passInput.type = 'password';
        eyeIcon.innerHTML = `
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
            `;
    }
}

// === GENERADOR DE CÓDIGO QR (autocontenido, sin librerías externas; modo byte, corrección M, versiones 1-15) ===
const QR = (() => {
    const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
    const BLK = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];
    const MAXV = 15;
    const bit = (x, i) => ((x >>> i) & 1) !== 0;
    function raw(v) { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; }
    const dataCw = v => Math.floor(raw(v) / 8) - ECC[v] * BLK[v];
    function mul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; }
    function divisor(d) { const r = []; for (let i = 0; i < d - 1; i++) r.push(0); r.push(1); let root = 1; for (let i = 0; i < d; i++) { for (let j = 0; j < r.length; j++) { r[j] = mul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; } root = mul(root, 2); } return r; }
    function remainder(data, div) { const r = div.map(() => 0); data.forEach(b => { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= mul(c, f); }); }); return r; }
    function bytesUtf8(s) { return Array.from(new TextEncoder().encode(s)); }
    function codewords(bytes, v) {
        const bits = []; const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
        put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
        const cap = dataCw(v) * 8; put(0, Math.min(4, cap - bits.length)); put(0, (8 - bits.length % 8) % 8);
        for (let p = 0xEC; bits.length < cap; p ^= 0xEC ^ 0x11) put(p, 8);
        const out = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; out.push(b); }
        return out;
    }
    function interleave(data, v) {
        const nb = BLK[v], el = ECC[v], rc = Math.floor(raw(v) / 8), ns = nb - rc % nb, sl = Math.floor(rc / nb), div = divisor(el), blocks = [];
        for (let i = 0, k = 0; i < nb; i++) { const dat = data.slice(k, k + sl - el + (i < ns ? 0 : 1)); k += dat.length; const ecc = remainder(dat, div); if (i < ns) dat.push(0); blocks.push(dat.concat(ecc)); }
        const res = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== sl - el || j >= ns) res.push(b[i]); });
        return res;
    }
    function build(text) {
        const bytes = bytesUtf8(text); let v = 1;
        while (v <= MAXV && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataCw(v) * 8) v++;
        if (v > MAXV) return null;
        const size = v * 4 + 17, mod = [], fn = [];
        for (let i = 0; i < size; i++) { mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
        const setFn = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
        for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
        const finder = (x, y) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy; if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, d !== 2 && d !== 4); } };
        finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
        const na = v === 1 ? 0 : Math.floor(v / 7) + 2, step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (na * 2 - 2)) * 2, ap = [6];
        if (na) for (let p = size - 7; ap.length < na; p -= step) ap.splice(1, 0, p);
        ap.forEach((cy, i) => ap.forEach((cx, j) => { if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
        const drawFormat = mask => {
            const data = mask; let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            const bits = ((data << 10) | rem) ^ 0x5412;
            for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i)); setFn(8, 7, bit(bits, 6)); setFn(8, 8, bit(bits, 7)); setFn(7, 8, bit(bits, 8));
            for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i));
            for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i));
            for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i));
            setFn(8, size - 8, true);
        };
        drawFormat(0);
        if (v >= 7) { let rem = v; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25); const bits = (v << 12) | rem; for (let i = 0; i < 18; i++) { const c = bit(bits, i), a = size - 11 + i % 3, b = Math.floor(i / 3); setFn(a, b, c); setFn(b, a, c); } }
        const cw = interleave(codewords(bytes, v), v); let k = 0;
        for (let right = size - 1; right >= 1; right -= 2) { if (right === 6) right = 5; for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) { const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert; if (!fn[y][x] && k < cw.length * 8) { mod[y][x] = bit(cw[k >>> 3], 7 - (k & 7)); k++; } } }
        const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { let inv; switch (m) { case 0: inv = (x + y) % 2 === 0; break; case 1: inv = y % 2 === 0; break; case 2: inv = x % 3 === 0; break; case 3: inv = (x + y) % 3 === 0; break; case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break; case 5: inv = x * y % 2 + x * y % 3 === 0; break; case 6: inv = (x * y % 2 + x * y % 3) % 2 === 0; break; default: inv = ((x + y) % 2 + x * y % 3) % 2 === 0; } if (!fn[y][x] && inv) mod[y][x] = !mod[y][x]; } };
        const penalty = () => {
            let p = 0, dark = 0;
            const lines = []; for (let y = 0; y < size; y++) { lines.push(mod[y].map(b => b ? 1 : 0)); } for (let x = 0; x < size; x++) { lines.push(mod.map(r => r[x] ? 1 : 0)); }
            lines.forEach(l => { let run = 1; for (let i = 1; i <= l.length; i++) { if (i < l.length && l[i] === l[i - 1]) run++; else { if (run >= 5) p += 3 + (run - 5); run = 1; } } const s = l.join(''); [/10111010000/g, /00001011101/g].forEach(re => { const m = s.match(re); if (m) p += 40 * m.length; }); });
            for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; }
            mod.forEach(r => r.forEach(b => { if (b) dark++; }));
            p += (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
            return p;
        };
        let best = 0, bestP = Infinity;
        for (let m = 0; m < 8; m++) { applyMask(m); drawFormat(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } applyMask(m); }
        applyMask(best); drawFormat(best);
        return mod;
    }
    return { build };
})();

// === COMPARTIR QR ===
function urlApp() { return location.href.split('#')[0]; }
function dibujarQR(canvas, m, px) {
    const q = 4, n = m.length, cell = Math.max(1, Math.floor(px / (n + 2 * q))), size = cell * (n + 2 * q);
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size); g.fillStyle = '#000000';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) g.fillRect((x + q) * cell, (y + q) * cell, cell, cell);
}
function abrirCompartirQR() {
    cerrarMenu();
    const url = urlApp(), cv = document.getElementById('qrCanvas'), av = document.getElementById('qrAviso');
    document.getElementById('qrUrl').textContent = url;
    document.getElementById('btnQRCompartir').classList.toggle('hidden', !navigator.share);
    let aviso = '';
    const m = QR.build(url);
    if (m) { dibujarQR(cv, m, 560); cv.classList.remove('hidden'); }
    else { cv.classList.add('hidden'); aviso = 'El enlace es demasiado largo para generar el código QR.'; }
    if (/^(file|blob|about):/i.test(location.protocol) || /^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname)) aviso = 'Este enlace solo funciona en este dispositivo. Para que otra persona pueda abrirlo, usa la app desde su dirección publicada en internet.';
    av.textContent = aviso; av.classList.toggle('hidden', !aviso);
    openModal('modalQR');
}
async function copiarEnlaceApp() { if (await copiar(urlApp())) mostrarToast('Enlace copiado'); else mostrarToast('No se pudo copiar el enlace', 'error'); }
function compartirEnlaceApp() { if (navigator.share) navigator.share({ title: (config.titulo || 'Gestión de Territorios'), url: urlApp() }).catch(() => {}); }
function descargarQR() {
    const m = QR.build(urlApp()); if (!m) return mostrarToast('No se pudo generar el QR', 'error');
    const c = document.createElement('canvas'); dibujarQR(c, m, 1000);
    c.toBlob(b => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'QR_Territorios.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); mostrarToast('QR descargado'); });
}

// === ¿CÓMO USAR? ===
function abrirAyuda() {
    cerrarMenu();
    const cont = document.querySelector('#modalAyuda .modal-content'); if (cont) cont.scrollTop = 0;
    openModal('modalAyuda');
}

// === MENÚ, TEMA Y ZOOM ===
function toggleMenu(e) {
    if (e) e.stopPropagation();
    const abierto = document.getElementById('menuDropdown').classList.toggle('hidden') === false;
    document.getElementById('menuBtn').setAttribute('aria-expanded', abierto);
}
function cerrarMenu() {
    document.getElementById('menuDropdown').classList.add('hidden');
    document.getElementById('menuBtn').setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) cerrarMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarMenu(); });

function abrirConfiguracion() {
    cerrarMenu();
    initPreferencias(); poblarConfigUI(); exhPoblarCfg();
    document.getElementById('cfgBuscar').value = ''; filtrarConfig(''); document.getElementById('cfgAvisoRegla').classList.add('hidden');
    actualizarContadores(); actualizarEstadoSistema();
    openModal('modalConfig');
}

// === CONFIGURACIÓN: PREFERENCIAS, SECCIONES, AVISOS Y SISTEMA ===
const PREF_DEF = { tema: 'auto', zoom: 100, densidad: 'comoda', anim: 'activas' };
function leerPref(k) {
    try {
        if (k === 'tema') return localStorage.getItem('vdm_theme') || 'auto';
        if (k === 'zoom') return Math.round((parseFloat(localStorage.getItem('vdm_zoom')) || 1) * 100);
        if (k === 'densidad') return localStorage.getItem('vdm_densidad') === 'compacta' ? 'compacta' : 'comoda';
        if (k === 'anim') return localStorage.getItem('vdm_anim') === 'reducidas' ? 'reducidas' : 'activas';
    } catch (e) {}
    return PREF_DEF[k];
}
function marcarSeg(id, v) { document.querySelectorAll('#' + id + ' button').forEach(b => b.classList.toggle('active', b.dataset.v === v)); }
function aplicarDensidad(v) { if (v === 'compacta') document.documentElement.setAttribute('data-densidad', 'compacta'); else document.documentElement.removeAttribute('data-densidad'); marcarSeg('densSegmentado', v === 'compacta' ? 'compacta' : 'comoda'); }
function aplicarAnim(v) { if (v === 'reducidas') document.documentElement.setAttribute('data-anim', 'reducidas'); else document.documentElement.removeAttribute('data-anim'); marcarSeg('animSegmentado', v === 'reducidas' ? 'reducidas' : 'activas'); }
function marcarZoomUI(p) { document.querySelectorAll('#zoomChips button').forEach(b => b.classList.toggle('active', +b.dataset.z === p)); }
function marcarLocal() { try { localStorage.setItem('vdm_prefs_local', '1'); } catch (e) {} }
function setDensidad(v) { try { localStorage.setItem('vdm_densidad', v); } catch (e) {} aplicarDensidad(v); marcarLocal(); guardarPreferencias(); actualizarContadores(); }
function setAnim(v) { try { localStorage.setItem('vdm_anim', v); } catch (e) {} aplicarAnim(v); marcarLocal(); guardarPreferencias(); actualizarContadores(); }
// Las preferencias mandan en el dispositivo (localStorage, inmediato) y se copian al estado del usuario (config.preferencias) para nuevos dispositivos
let _prefT = null;
function guardarPreferencias() {
    clearTimeout(_prefT);
    _prefT = setTimeout(() => {
        if (!puedeEditar() || !_rolListo) return;
        const pr = { tema: leerPref('tema'), zoom: leerPref('zoom'), densidad: leerPref('densidad'), anim: leerPref('anim') };
        if (JSON.stringify(config.preferencias || {}) === JSON.stringify(pr)) return;
        config.preferencias = pr; guardarLocal();
    }, 600);
}
function adoptarPreferenciasNube() {
    const p = config && config.preferencias; if (!p) return;
    try { if (localStorage.getItem('vdm_prefs_local') === '1') return; } catch (e) { return; }
    try {
        if (p.tema === 'light' || p.tema === 'dark') localStorage.setItem('vdm_theme', p.tema);
        if (p.zoom >= 70 && p.zoom <= 160) { localStorage.setItem('vdm_zoom', p.zoom / 100); document.documentElement.style.setProperty('--zoom', p.zoom / 100); }
        if (p.densidad === 'compacta') localStorage.setItem('vdm_densidad', 'compacta');
        if (p.anim === 'reducidas') localStorage.setItem('vdm_anim', 'reducidas');
    } catch (e) {}
    initPreferencias();
}
function actualizarContadores() {
    let exhMod = 0, nExc = 0, reuMod = 0;
    try { exhMod = JSON.stringify(exh.config) !== JSON.stringify(exhConfigDef()) ? 1 : 0; nExc = (excepciones[agendaKey()] || []).length; reuMod = JSON.stringify([...reunionesCfg()].sort()) !== JSON.stringify([...defConfig().reuniones].sort()) ? 1 : 0; } catch (e) {}
    const tit = (config.titulo || '').trim(), n = {
        tema: (leerPref('tema') !== 'auto') + (leerPref('densidad') !== 'comoda') + (leerPref('anim') !== 'activas') + (!!tit && tit !== defConfig().titulo) + (!!(config.subtitulo || '').trim()),
        zoom: leerPref('zoom') !== 100 ? 1 : 0,
        horarios: (config.horariosDia ? 1 : 0) + ((config.maxTurnos || 4) !== 4 ? 1 : 0) + exhMod,
        reuniones: reuMod + (nExc ? 1 : 0),
        sistema: (config.waModo && config.waModo !== 'auto') ? 1 : 0
    };
    Object.keys(n).forEach(k => { const e = document.getElementById('cfgBadge-' + k); if (e) e.textContent = n[k] ? `${n[k]} activo${n[k] > 1 ? 's' : ''}` : ''; });
    const c = document.getElementById('cfgExcCont'); if (c) c.textContent = nExc ? `(${nExc} en ${nombreMesSel()})` : '';
}
function filtrarConfig(q) {
    q = norm(q || '').trim();
    document.querySelectorAll('#modalConfig .cfg-sec').forEach(sec => {
        let hit = 0;
        sec.querySelectorAll('.cfg-body > .input-group, .cfg-body > .cfg-info').forEach(g => { const ok = !q || norm(g.textContent + ' ' + (g.dataset.k || '')).includes(q); g.classList.toggle('hidden', !ok); if (ok) hit++; });
        sec.classList.toggle('hidden', !!q && !hit); if (q && hit) sec.open = true;
    });
}
// Aviso al cambiar reglas: aplica a futuras generaciones; opción de regenerar el mes (los turnos fijados se conservan)
function avisarCambioReglas(tipo) {
    const box = document.getElementById('cfgAvisoRegla'); if (!box) return;
    const exhT = tipo === 'exh', mes = exhT ? `${MESES[exhMes() - 1]} ${exhAnio()}` : `${nombreMesSel()} ${anioSel()}`;
    const hay = exhT ? (exh.agendas[exhKey()] || []).length : (agendasMaestras[agendaKey()] || []).length;
    box.innerHTML = `<span>✔ Cambio guardado. Se aplicará a las <b>próximas generaciones</b>.${hay ? ` La agenda de ${esc(mes)} no cambia hasta que la regeneres${exhT ? '' : ' (los turnos fijados se conservan)'}.` : ''}</span>` + (hay && puedeEditar() ? `<button type="button" class="btn-primary" onclick="regenerarDesdeConfig('${exhT ? 'exh' : 'grupos'}')">Regenerar ${esc(mes)}</button>` : '');
    box.classList.remove('hidden');
}
function regenerarDesdeConfig(tipo) { closeModal('modalConfig'); if (tipo === 'exh') exhGenerar(); else generarNuevaAgenda(); }
function abrirExcepcionesDesdeConfig() { closeModal('modalConfig'); abrirExcepciones(); }
function actualizarEstadoSistema() {
    const el = document.getElementById('cfgEstadoSistema'); if (!el) return;
    let kb = 0; try { kb = Math.round((localStorage.getItem('vdm_data') || '').length / 1024); } catch (e) {}
    const txt = { ok: 'Sincronizado con la nube', pending: 'Cambios pendientes de subir', offline: 'Sin conexión' }[estadoSync()] || 'Sin nube';
    el.innerHTML = `<div>Caché local: <b>${kb} KB</b></div><div>Estado: <b>${txt}</b></div><div>Versión de datos: <b>${_verBase}</b></div><div>Cuenta: <b>${puedeEditar() ? 'Editor' : 'Solo lectura'}</b></div>`;
}
async function actualizarApp() {
    if (!('serviceWorker' in navigator)) return mostrarToast('Este navegador no admite la actualización automática.', 'error');
    try {
        const r = await navigator.serviceWorker.getRegistration();
        if (!r) return mostrarToast('La app todavía no está instalada para usarse sin conexión.', 'error');
        await r.update();
        const recargar = () => location.reload();
        if (r.installing || r.waiting) {
            // El sw.js se activa solo (skipWaiting + claim): al tomar el control se recarga la página
            navigator.serviceWorker.addEventListener('controllerchange', recargar, { once: true });
            if (r.waiting) r.waiting.postMessage('SKIP_WAITING');
            mostrarToast('Instalando la actualización…');
            setTimeout(recargar, 6000);
        } else {
            // index.html se pide primero a la red: al recargar se trae la última versión publicada
            mostrarToast('Recargando para traer la última versión…');
            setTimeout(recargar, 700);
        }
    } catch (e) { mostrarToast('No se pudo comprobar la actualización.', 'error'); }
}

function aplicarTema(t) {
    const forzado = (t === 'light' || t === 'dark');
    if (forzado) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    document.querySelectorAll('#temaSegmentado button').forEach(b =>
        b.classList.toggle('active', b.dataset.themeOpt === (forzado ? t : 'auto')));
}
function setTema(t) {
    try { if (t === 'auto') localStorage.removeItem('vdm_theme'); else localStorage.setItem('vdm_theme', t); } catch (e) {}
    aplicarTema(t); marcarLocal(); guardarPreferencias(); actualizarContadores();
}
function setZoom(porcentaje) {
    const p = Math.min(160, Math.max(70, parseInt(porcentaje, 10) || 100));
    document.documentElement.style.setProperty('--zoom', p / 100);
    try { localStorage.setItem('vdm_zoom', p / 100); } catch (e) {}
    document.getElementById('zoomValor').textContent = p + '%';
    document.getElementById('zoomRange').value = p; marcarZoomUI(p); marcarLocal(); guardarPreferencias(); actualizarContadores();
}
function initPreferencias() {
    let t = 'auto', z = 1;
    try { t = localStorage.getItem('vdm_theme') || 'auto'; z = parseFloat(localStorage.getItem('vdm_zoom')) || 1; } catch (e) {}
    aplicarTema(t);
    document.getElementById('zoomValor').textContent = Math.round(z * 100) + '%';
    document.getElementById('zoomRange').value = Math.round(z * 100);
    aplicarDensidad(leerPref('densidad')); aplicarAnim(leerPref('anim')); marcarZoomUI(Math.round(z * 100));
}
initPreferencias();

// === VARIABLES GLOBALES ===
let conductores = [], territorios = [], agendasMaestras = {}, historialAgendas = {}, historialActividad = [];

const MATRIZ_HORARIOS = { 
    'LUN': ['07:00 AM', '09:00 AM', '04:00 PM', '06:30 PM'], 
    'MAR': ['07:00 AM', '09:00 AM', '04:00 PM'], 
    'MIÉ': ['07:00 AM', '09:00 AM'], 
    'JUE': ['07:00 AM', '09:00 AM', '04:00 PM'], 
    'VIE': ['07:00 AM', '09:00 AM', '04:00 PM', '06:30 PM'], 
    'SÁB': ['07:00 AM', '09:00 AM'], 
    'DOM': ['11:00 AM'] 
};

// === V2: HELPERS ===
function defConfig() { return { titulo: 'Gestión de Territorios Vista Al Mar', subtitulo: '', maxTurnos: 4, reuniones: ['MIÉ-PM', 'DOM-AM'], reunionesInit: true, waModo: 'auto', horariosDia: null }; }
const STD_HORAS = ['07:00 AM', '09:00 AM', '11:00 AM', '04:00 PM', '06:30 PM'];
const tk = t => String(t.numero !== '' && t.numero != null ? t.numero : 'S-' + t.nombre);
const terrLabel = t => (t.numero !== '' && t.numero != null) ? `${t.numero}. ${t.nombre}` : t.nombre;
const nomC = c => `${c.nombre} ${c.apellido}`;
const hMin = h => { const m = /(\d+):(\d+)\s*(AM|PM)/i.exec(h || ''); if (!m) return 0; let H = +m[1] % 12; if (m[3].toUpperCase() === 'PM') H += 12; return H * 60 + +m[2]; };
const bloqueDe = h => /PM/i.test(h) ? 'PM' : 'AM';
const _svg = (p, s = 18) => `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
    undo: _svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: _svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
    lock: _svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    unlock: _svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
    sol: _svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>'),
    luna: _svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
    edit: _svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
    trash: _svg('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
    x: _svg('<path d="M18 6L6 18M6 6l12 12"/>'),
    mas: _svg('<path d="M12 5v14M5 12h14"/>'),
    check: _svg('<path d="M20 6L9 17l-5-5"/>'),
    checkAll: _svg('<path d="M18 6L7 17l-5-5"/><path d="M22 10l-7.5 7.5L13 16"/>'),
    pausa: _svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
    play: _svg('<path d="M6 4l14 8-14 8V4z"/>'),
    nubeOk: _svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><path d="M9.5 15l2 2 4-4"/>'),
    nubeSube: _svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><path d="M12 17v-5"/><path d="M9.5 14.5L12 12l2.5 2.5"/>'),
    nubeOff: _svg('<path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6"/><path d="M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/><path d="M1 1l22 22"/>'),
    aviso: _svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 16),
    punto: _svg('<circle cx="12" cy="12" r="4"/>', 14),
    ok14: _svg('<path d="M20 6L9 17l-5-5"/>', 14),
};
// Icono del turno: sol = mañana (AM) · medio sol/atardecer: tarde hasta las 6:00 PM · luna = noche (después de las 6:00 PM)
const SVG_ATARDECER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Atardecer"><path d="M6 17a6 6 0 0 1 12 0"/><line x1="2" y1="17" x2="22" y2="17"/><line x1="12" y1="6" x2="12" y2="8.5"/><line x1="4.6" y1="9.6" x2="6.3" y2="11.3"/><line x1="19.4" y1="9.6" x2="17.7" y2="11.3"/><line x1="7" y1="21" x2="17" y2="21"/></svg>';
function iconoTurno(h) {
    if (bloqueDe(h) === 'AM') return { cls: 'am', ico: IC.sol, tit: 'Mañana' };
    if (hMin(h) <= 18 * 60) return { cls: 'ocaso', ico: SVG_ATARDECER, tit: 'Atardecer' };
    return { cls: 'pm', ico: IC.luna, tit: 'Noche' };
}
const pillHora = (h, attr = '') => { const t = iconoTurno(h); return `<span class="pill ${t.cls}" title="${t.tit}"><i>${t.ico}</i><span${attr}>${esc(h)}</span></span>`; };
const ROLES = { anciano: 'Anciano', siervo: 'Siervo ministerial', experimentado: 'Publicador experimentado' };
const esPrioritario = c => !!c.esAnciano || ['siervo', 'experimentado'].includes(c.rol);

// === Parte 1: constantes de turnos especiales ===
const NUM_GRUPOS = 8;                 // Último sábado: siempre 8 grupos (1 al 8)
const HORA_ULT_SAB = '09:00 AM';      // Hora de los 8 grupos del último sábado
const HORA_GRUPO_DOM = '11:00 AM';    // Domingo: grupo de predicación 11:00 AM-12:00 PM (la reunión es a las 9:00 AM)
const HORA_TELEGRAM = '06:30 PM';     // Salida por Telegram (viernes 6:30 PM)
const esTelegram = (dia, hora) => hora === HORA_TELEGRAM;
const esAncianoC = c => !!c && (!!c.esAnciano || c.rol === 'anciano');

// Duración INTERNA de cada turno (solo para calcular el estado en "Hoy y mañana"; nunca se muestra en agenda/tabla/resumen).
//  07:00 AM → 7:00-9:00 AM · 09:00 AM → 9:00-11:00 AM
//  LUN tarde → 5:00-7:00 PM · MAR-VIE tarde → 6:00-7:00 PM (fin 7:00 PM)
//  DOM: reunión 9:00 AM · grupo 11:00 AM-12:00 PM
const FIN_AM = { 420: 540, 540: 660 };   // inicio (min) → fin (min)
function ventanaTurno(dia, hora) {
    const ini = hMin(hora); let fin;
    if (dia === 'DOM') fin = ini < 660 ? ini + 120 : ini + 60;
    else if (ini < 720) fin = FIN_AM[ini] || ini + 120;
    else if (['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE'].includes(dia)) fin = 19 * 60;
    else fin = ini + 120;
    if (fin <= ini) fin = ini + 60;
    return { ini, fin };
}
// 'fin' = ya finalizó · 'en' = en curso · 'prox' = por empezar
function estadoTurno(f, ahoraMin) {
    const v = ventanaTurno(f.diaSemana, f.hora);
    return ahoraMin >= v.fin ? 'fin' : (ahoraMin >= v.ini ? 'en' : 'prox');
}
// Anciano registrado para el grupo n (1-8): se toma de Conductores (rol Anciano + número de grupo)
function ancianoDeGrupo(n, iso, usados) {
    const libre = c => c.estado !== 'pausa' && !enAusencia(c, iso) && !usados.includes(nomC(c));
    const c = conductores.find(x => esAncianoC(x) && String(x.grupo) === String(n) && libre(x));
    return c ? nomC(c) : '';
}
// Migración única: los grupos del apartado "Grupos" (eliminado) pasan a ser el número de grupo del anciano en Conductores.
function migrarGruposLegacy(lista) {
    let cambio = false;
    (lista || []).forEach(g => {
        const c = conductores.find(x => nomC(x) === g.anciano); if (!c) return;
        const n = String(g.numero);
        if (conductores.some(x => esAncianoC(x) && String(x.grupo) === n)) return;
        c.esAnciano = true; c.grupo = n; cambio = true;
    });
    return cambio;
}

function limpiarTelefono(raw) {
    raw = String(raw || '').trim();
    let d = raw.replace(/\D/g, ''); if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    if (raw.startsWith('+') && !d.startsWith('58')) return '+' + d;
    if (d.startsWith('58')) d = d.slice(2);
    d = d.replace(/^0+/, '');
    return d ? '+58' + d : '';
}
function limpiarTelInput() { const e = document.getElementById('cTelefono'); e.value = limpiarTelefono(e.value) || '+58 '; }
function syncAnciano(v) {
    document.getElementById('grupoSugerido').classList.toggle('hidden', v !== 'si');
    const r = document.getElementById('cRol'); if (v === 'si' && !r.value) r.value = 'anciano'; else if (v === 'no' && r.value === 'anciano') r.value = '';
}
function syncRol(v) { const si = v === 'anciano'; document.getElementById('cEsAnciano').value = si ? 'si' : 'no'; document.getElementById('grupoSugerido').classList.toggle('hidden', !si); }

const NOM_F = new Set(['abigail', 'ruth', 'esther', 'raquel', 'isabel', 'maribel', 'carmen', 'mercedes', 'luz', 'pilar', 'rosario', 'belen', 'ines', 'judith', 'sarai', 'noemi', 'yaneth', 'yanet', 'miriam', 'liz', 'beatriz', 'dolores', 'sol', 'karen', 'jennifer', 'yenifer', 'nohemi', 'lilibeth', 'madeleine']);
const NOM_M = new Set(['joshua', 'josue', 'jose', 'luca', 'nicolas', 'elias', 'matias', 'tobias', 'andres', 'jonas', 'isaias', 'jeremias', 'zacarias', 'bautista']);
function generoDe(c) {
    if (!c) return ''; if (c.genero === 'M' || c.genero === 'F') return c.genero;
    const p = norm(c.nombre).trim().split(/\s+/)[0];
    if (NOM_F.has(p)) return 'F'; if (NOM_M.has(p)) return 'M';
    return /a$/.test(p) ? 'F' : 'M';
}
function mensajeWA(c, f) {
    const sal = c ? `¡Hola ${generoDe(c) === 'F' ? 'hermana' : 'hermano'} ${c.nombre}!` : '¡Hola!';
    return `${sal} ¿Cómo estás?. Este mensaje es para notificarte que tienes el privilegio de dirigir el grupo del ${String(f.diaSemana).toLowerCase()} ${f.diaMes} a las ${f.hora}. Ese día estarán abarcando el territorio ${f.territorio}. El lugar de encuentro será en ${f.lugar}. ¿Podrías confirmarme si vas a asistir? Estaré atento a tu respuesta. ¡Muchas gracias!`;
}
// === SANEAMIENTO DE TEXTO ===
// Quita etiquetas HTML, caracteres de control/invisibles y saltos de línea; colapsa espacios.
function sanearTexto(str) {
    return String(str ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<\/?[a-zA-Z!?][^>]*(?:>|$)/g, '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2028\u2029\uFEFF]/g, '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[ \u00A0]{2,}/g, ' ')
        .trim();
}
// Sanea recursivamente todas las cadenas de un objeto de datos (copia nueva; ignora claves peligrosas)
function sanearDatos(v, d = 0) {
    if (typeof v === 'string') return sanearTexto(v);
    if (v === null || typeof v !== 'object' || d > 20) return v;
    if (Array.isArray(v)) return v.map(x => sanearDatos(x, d + 1));
    const o = {};
    Object.keys(v).forEach(k => { if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') o[k] = sanearDatos(v[k], d + 1); });
    return o;
}

function payloadCompleto() { return { version: _verBase, updated_at: new Date().toISOString(), conductores, territorios, historial: historialAgendas, actividad: historialActividad, borradores: agendasMaestras, excepciones, config, exhibidores: exh }; }
function aplicarPayload(p, sinGuardar) {
    p = sanearDatos(p || {});
    conductores = p.conductores || []; territorios = p.territorios || [];
    historialAgendas = migrarClaves(p.historial); agendasMaestras = migrarClaves(p.borradores); excepciones = migrarClaves(p.excepciones);
    historialActividad = p.actividad || []; exh = exhNormalizar(p.exhibidores); config = Object.assign(defConfig(), p.config || {}); config.reuniones = migrarReuniones(config.reuniones);
    migrarGruposLegacy(p.grupos);
    if (sinGuardar) { try { localStorage.setItem('vdm_data', JSON.stringify(p)); } catch (e) {} } else guardarLocal();
    initApp(false);
}

// === CONFIGURACIÓN (título, reuniones, máximo) ===
function aplicarConfigUI() {
    const t = (config.titulo || '').trim() || defConfig().titulo, sub = (config.subtitulo || '').trim();
    document.getElementById('tituloApp').textContent = t; document.title = t;
    const e = document.getElementById('subtituloApp'); e.textContent = sub; e.classList.toggle('hidden', !sub);
    document.getElementById('expTituloApp').textContent = t; document.getElementById('expSubtitulo').textContent = sub;
    document.getElementById('expSubtitulo').style.display = sub ? '' : 'none';
}
function poblarConfigUI() {
    document.getElementById('cfgTitulo').value = config.titulo || ''; document.getElementById('cfgSub').value = config.subtitulo || '';
    document.getElementById('cfgMax').value = config.maxTurnos || 4; document.getElementById('cfgWaModo').value = config.waModo || 'auto';
    poblarHorariosUI();
    // Reuniones: solo día de la semana + mañana o tarde (el domingo la reunión es a las 9:00 AM)
    const box = document.getElementById('cfgReuniones'), R = reunionesCfg();
    box.innerHTML = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'].map(d => `<div class="reu-row"><b>${DIAS_LARGOS[d]}</b><div class="chip-button-group">${['AM', 'PM'].map(b => `<label class="chip-button"><input type="checkbox" value="${d}-${b}"${R.includes(d + '-' + b) ? ' checked' : ''}> ${b === 'AM' ? IC.sol + ' Mañana' : 'Tarde'}${d === 'DOM' && b === 'AM' ? ' (9:00 AM)' : ''}</label>`).join('')}</div></div>`).join('');
}
function guardarConfig(sinAviso) { if (_bloqueadoLector()) return;
    config.titulo = document.getElementById('cfgTitulo').value; config.subtitulo = document.getElementById('cfgSub').value;
    config.waModo = document.getElementById('cfgWaModo').value; config.maxTurnos = Math.max(1, parseInt(document.getElementById('cfgMax').value, 10) || 4);
    config.reuniones = [...document.querySelectorAll('#cfgReuniones input:checked')].map(i => i.value); config.reunionesInit = true;
    const filas = document.querySelectorAll('#cfgHorarios .hor-row');
    if (filas.length === 7) {
        const hd = {}; filas.forEach(r => { hd[r.dataset.dia] = [...r.querySelectorAll('input:checked')].map(i => i.value).sort((a, b) => hMin(a) - hMin(b)); });
        // Si coincide con los horarios por defecto no se guarda nada (se usa MATRIZ_HORARIOS)
        const igual = DIAS_SEM.every(d => { const base = new Set([...(MATRIZ_HORARIOS[d] || []), ...horasReglaFija(d)]); return base.size === hd[d].length && hd[d].every(h => base.has(h)); });
        config.horariosDia = igual ? null : hd;
    }
    guardarLocal(); aplicarConfigUI(); actualizarContadores(); if (!sinAviso) avisarCambioReglas('grupos');
}
function poblarHorariosUI() {
    const box = document.getElementById('cfgHorarios'); if (!box) return;
    box.innerHTML = DIAS_SEM.map(d => {
        const fijas = horasReglaFija(d), base = new Set([...horariosBase(d), ...fijas]), lista = [...new Set([...STD_HORAS, ...base])].sort((a, b) => hMin(a) - hMin(b));
        return `<div class="hor-row" data-dia="${d}"><b>${DIAS_LARGOS[d]}</b><div class="chip-button-group">${lista.map(h => `<label class="chip-button"><input type="checkbox" value="${esc(h)}"${base.has(h) ? ' checked' : ''}${fijas.includes(h) ? ' disabled title="Regla fija"' : ''}> ${esc(h)}</label>`).join('')}</div><input type="time" id="cfgHN-${d}" aria-label="Añadir hora ${esc(DIAS_LARGOS[d])}"><button type="button" class="btn-outline mini" title="Añadir hora" aria-label="Añadir hora" onclick="anadirHoraBase('${d}')">${IC.mas}</button></div>`;
    }).join('');
}
function anadirHoraBase(dia) { if (_bloqueadoLector()) return;
    const e = document.getElementById('cfgHN-' + dia), v = e && e.value; if (!v) return mostrarToast('Elige una hora', 'error');
    const [H, M] = v.split(':').map(Number), h = `${pad(H % 12 || 12)}:${pad(M)} ${H >= 12 ? 'PM' : 'AM'}`;
    guardarConfig(); const hd = {}; DIAS_SEM.forEach(d => { hd[d] = [...new Set([...horariosBase(d), ...horasReglaFija(d)])]; });
    if (!hd[dia].includes(h)) hd[dia].push(h); hd[dia].sort((a, b) => hMin(a) - hMin(b));
    config.horariosDia = hd; guardarLocal(); poblarHorariosUI();
}
function restablecerHorariosBase() { if (_bloqueadoLector()) return; config.horariosDia = null; guardarLocal(); poblarHorariosUI(); actualizarContadores(); avisarCambioReglas('grupos'); mostrarToast('Horarios base restablecidos'); }

// === DESHACER / MODO LECTURA ===
function pushUndo(k) { k = k || agendaKey(); if (!agendasMaestras[k]) return; undoStack.push({ k, j: JSON.stringify(agendasMaestras[k]) }); if (undoStack.length > 10) undoStack.shift(); redoStack.length = 0; updateUndoUI(); }
function restaurarEstado(e) {
    agendasMaestras[e.k] = JSON.parse(e.j); guardarLocal();
    const [a, m] = e.k.split('-').map(Number); asegurarAnio(a); document.getElementById('anioAgenda').value = a; document.getElementById('mesAgenda').value = m;
    cargarAgendaDelMes();
}
function deshacer() { if (_bloqueadoLector()) return;
    const e = undoStack.pop(); if (!e) return mostrarToast('Nada que deshacer', 'error');
    // El estado actual pasa a la pila de rehacer antes de restaurar
    if (agendasMaestras[e.k]) { redoStack.push({ k: e.k, j: JSON.stringify(agendasMaestras[e.k]) }); if (redoStack.length > 10) redoStack.shift(); }
    restaurarEstado(e); updateUndoUI(); mostrarToast('Cambio deshecho');
}
function rehacer() { if (_bloqueadoLector()) return;
    const e = redoStack.pop(); if (!e) return mostrarToast('Nada que rehacer', 'error');
    if (agendasMaestras[e.k]) { undoStack.push({ k: e.k, j: JSON.stringify(agendasMaestras[e.k]) }); if (undoStack.length > 10) undoStack.shift(); }
    restaurarEstado(e); updateUndoUI(); mostrarToast('Cambio rehecho');
}
function updateUndoUI() {
    const u = document.getElementById('btnUndo'), r = document.getElementById('btnRedo'), l = document.getElementById('btnLock');
    if (u) { u.disabled = !undoStack.length; u.innerHTML = `${IC.undo}<span>Deshacer${undoStack.length ? ' (' + undoStack.length + ')' : ''}</span>`; }
    if (r) { r.disabled = !redoStack.length; r.innerHTML = `${IC.redo}<span>Rehacer${redoStack.length ? ' (' + redoStack.length + ')' : ''}</span>`; }
    if (l) l.innerHTML = lectura ? `${IC.lock}<span>Modo lectura</span>` : `${IC.unlock}<span>Editando</span>`;
}
function toggleLectura() { if (_bloqueadoLector()) return; lectura = !lectura; try { localStorage.setItem('vdm_lock', lectura ? '1' : '0'); } catch (e) {} refrescarTabla(); mostrarToast(lectura ? 'Modo lectura: edición bloqueada' : 'Edición habilitada'); }
document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Escape') { if (window._dlgCancel) { window._dlgCancel(); return; } document.querySelectorAll('.modal').forEach(m => { if (m.style.display === 'flex') m.style.display = 'none'; }); cerrarMenu(); return; }
    if (mod && !e.shiftKey && k === 'f') { e.preventDefault(); abrirBuscador(); return; }
    if (mod && !e.shiftKey && k === 's') { e.preventDefault(); guardarEnHistorial(); return; }
    const esUndo = mod && !e.shiftKey && k === 'z';
    const esRedo = mod && ((e.shiftKey && k === 'z') || (!e.shiftKey && !e.altKey && k === 'y'));
    if (esUndo || esRedo) {
        const t = e.target; if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
        e.preventDefault(); if (esRedo) rehacer(); else deshacer();
    }
});

// === TERRITORIOS: pequeño / hora personalizada ===
function togglePequeno() {
    const p = document.getElementById('tPequeno').checked, n = document.getElementById('tNumero');
    n.disabled = false; n.required = !p; n.placeholder = p ? 'Número del subterritorio (opcional)' : '12, 12-A, 12.1';   // los pequeños/subterritorios también pueden llevar número
}
function limpiarHorasCustom() { document.querySelectorAll('#tHoras [data-custom]').forEach(e => e.remove()); }
function addChipHora(h, marcado) {
    if ([...document.querySelectorAll('#tHoras input')].some(i => i.value === h)) { document.querySelectorAll('#tHoras input').forEach(i => { if (i.value === h && marcado) i.checked = true; }); return; }
    const l = document.createElement('label'); l.className = 'chip-button'; l.setAttribute('data-custom', '1');
    l.innerHTML = `<input type="checkbox" value="${esc(h)}"${marcado ? ' checked' : ''}> ${esc(h)}`;
    document.getElementById('tHoras').appendChild(l);
}
function anadirHoraCustom() {
    const v = document.getElementById('tHoraCustom').value; if (!v) return mostrarToast('Elige una hora', 'error');
    const [H, M] = v.split(':').map(Number); addChipHora(`${pad(H % 12 || 12)}:${pad(M)} ${H >= 12 ? 'PM' : 'AM'}`, true);
    document.getElementById('tHoraCustom').value = '';
}

// === BÚSQUEDA GLOBAL ===
function abrirBuscador() { document.getElementById('gsInput').value = ''; buscarGlobal(); openModal('modalBuscar'); setTimeout(() => document.getElementById('gsInput').focus(), 60); }
function buscarGlobal() {
    const ws = norm(document.getElementById('gsInput').value).trim().split(/\s+/).filter(Boolean), el = document.getElementById('gsRes');
    if (!ws.length) { el.innerHTML = '<p class="hint">Escribe para buscar conductores, territorios y asignaciones del mes.</p>'; return; }
    const m = txt => { const t = norm(txt); return ws.every(w => t.includes(w)); };
    const it = (t, sub, fn) => `<div class="group-card gs-it" onclick="${fn}"><div><strong>${esc(t)}</strong><br><small>${esc(sub)}</small></div></div>`;
    const sec = (t, a) => a.length ? `<div class="gs-t">${t}</div>${a.join('')}` : '';
    const R = agendasMaestras[agendaKey()] || [];
    el.innerHTML = sec('Conductores', conductores.map((c, i) => [c, i]).filter(([c]) => m(`${nomC(c)} ${c.telefono}`)).map(([c, i]) => it(nomC(c), c.estado === 'pausa' ? 'En pausa' : (ROLES[c.rol] || (c.esAnciano ? 'Anciano' : 'Conductor')), `irConductor(${i})`)))
        + sec('Territorios', territorios.map((t, i) => [t, i]).filter(([t]) => m(`${t.numero} ${t.nombre} ${t.lugar}`)).map(([t, i]) => it(terrLabel(t), t.lugar || '', `irTerritorio(${i})`)))
        + sec(`Asignaciones de ${nombreMesSel()}`, R.map((f, i) => [f, i]).filter(([f]) => !f.evento && m(`${DIAS_LARGOS[f.diaSemana]} ${f.diaMes} ${f.hora} ${f.conductor} ${f.territorio} ${f.lugar} ${f.grupos}`)).slice(0, 30).map(([f, i]) => it(`${DIAS_LARGOS[f.diaSemana]} ${f.diaMes} · ${f.hora}`, `${f.conductor} — ${f.territorio} — ${f.lugar}`, `irFila(${i})`)))
        || '<p class="hint">Sin resultados.</p>';
}
function irConductor(i) { closeModal('modalBuscar'); switchTab('tab-personal'); filtroCond = 'todos'; document.getElementById('listaConductores').classList.remove('hidden'); document.getElementById('buscaConductores').value = nomC(conductores[i]); renderListaConductores(); }
function irTerritorio(i) { closeModal('modalBuscar'); switchTab('tab-territorios'); document.getElementById('listaTerritorios').classList.remove('hidden'); document.getElementById('buscaTerritorios').value = territorios[i].nombre; renderListaTerritorios(); }
function irFila(i) {
    closeModal('modalBuscar'); switchTab('tab-agenda'); const tr = document.querySelector(`#tablaCuerpoAgenda tr[data-idx="${i}"]`);
    if (tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); tr.style.outline = '3px solid var(--blue)'; setTimeout(() => tr.style.outline = '', 2500); }
}

// === BÚSQUEDA DIFUSA Y SELECTOR DE CONDUCTOR ===
function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let p = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) { const q = [i]; for (let j = 1; j <= n; j++) q[j] = Math.min(p[j] + 1, q[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = q; }
    return p[n];
}
function scoreFuzzy(q, txt) {
    q = norm(q).trim(); if (!q) return 0; const t = norm(txt); if (t.includes(q)) return 0;
    let best = 99; t.split(/\s+/).forEach(w => { best = Math.min(best, lev(q, w), lev(q, w.slice(0, q.length))); }); return best;
}
function libreEn(c, k, f) {
    const R = agendasMaestras[k] || [], [a, m] = k.split('-').map(Number), iso = `${a}-${pad(m)}-${pad(f.diaMes)}`;
    return condDispo(c, f.diaSemana, f.hora, iso) && !R.some(x => !x.evento && x !== f && x.diaMes === f.diaMes && x.hora === f.hora && x.conductor === nomC(c));
}
function abrirSelectorConductor(k, idx, modo) {
    if (lectura && modo === 'todos') return;
    selCtx = { k, idx, modo };
    document.getElementById('selTitulo').textContent = modo === 'libres' ? 'Reemplazo de emergencia (solo disponibles)' : 'Cambiar conductor';
    document.getElementById('selBusca').value = ''; renderSelector(); openModal('modalSelector');
    setTimeout(() => document.getElementById('selBusca').focus(), 60);
}
function isoFila(k, f) { const [a, m] = k.split('-').map(Number); return `${a}-${pad(m)}-${pad(f.diaMes)}`; }
// Parte 2: conductor libre más equilibrado para un turno sin asignar (menos turnos, prioridad en SÁB/DOM, disponibilidad real)
function sugerirConductor(k, f) {
    const R = agendasMaestras[k] || [], maxT = Math.max(1, parseInt(config.maxTurnos, 10) || 4), finde = f.diaSemana === 'SÁB' || f.diaSemana === 'DOM';
    const cnt = {}, hoy = [], ayer = [];
    R.forEach(x => { if (x.evento || x === f) return; cnt[x.conductor] = (cnt[x.conductor] || 0) + 1; if (x.diaMes === f.diaMes) hoy.push(x.conductor); if (x.diaMes === f.diaMes - 1) ayer.push(x.conductor); });
    const gm = /grupo\s*(\d+)/i.exec(f.grupos || ''), grupo = gm ? gm[1] : null;
    let mejor = null;
    conductores.forEach((c, i) => {
        if (!libreEn(c, k, f)) return;
        const n = nomC(c), t = cnt[n] || 0;
        let sc = t * 10 + (hoy.includes(n) ? 100 : 0) + (ayer.includes(n) ? 3 : 0) + (t >= maxT ? 50 : 0);
        if (finde && !esPrioritario(c)) sc += 8;
        if (esTelegram(f.diaSemana, f.hora) && c.telegram) sc -= 6;
        if (grupo && esAncianoC(c) && String(c.grupo) === grupo) sc -= 20;
        if (!mejor || sc < mejor.sc || (sc === mejor.sc && n.localeCompare(nomC(conductores[mejor.i]), 'es') < 0)) mejor = { i, sc, t };
    });
    return mejor;
}
function renderSelector() {
    if (!selCtx) return; const { k, idx, modo } = selCtx, R = agendasMaestras[k] || [], f = R[idx]; if (!f) return;
    const q = document.getElementById('selBusca').value, cnt = {}, iso = isoFila(k, f); R.forEach(x => { if (!x.evento) cnt[x.conductor] = (cnt[x.conductor] || 0) + 1; });
    const sug = esVacio(f.conductor, 'Sin Asignar') ? sugerirConductor(k, f) : null;
    let L = conductores.map((c, i) => ({ c, i, s: scoreFuzzy(q, nomC(c) + ' ' + (c.telefono || '')), libre: libreEn(c, k, f), sug: !!sug && sug.i === i }));
    let sinDisp = false;
    if (modo === 'libres') {
        const actual = norm(f.conductor || '').trim();
        // Nunca ofrecer al conductor que ya está asignado en este turno
        L = L.filter(x => x.libre && (!actual || norm(nomC(x.c)).trim() !== actual));
        sinDisp = !L.length;
    }
    if (q.trim()) { const lim = Math.max(1, Math.floor(norm(q).trim().length / 3)); L = L.filter(x => x.s <= lim); }
    L.sort((a, b) => (b.sug ? 1 : 0) - (a.sug ? 1 : 0) || a.s - b.s || (cnt[nomC(a.c)] || 0) - (cnt[nomC(b.c)] || 0) || nomC(a.c).localeCompare(nomC(b.c)));
    const estado = x => { if (x.libre) return 'Libre en este horario'; if (x.c.estado === 'pausa') return 'En pausa'; if (exhEnExh(nomC(x.c), exhTel(x.c.telefono), iso)) return 'Ya tiene turno de exhibidor ese día'; const au = enAusencia(x.c, iso); return au ? 'Ausente en esa fecha' + (au.motivo ? ' (' + esc(au.motivo) + ')' : '') : 'No disponible / ocupado'; };
    const card = x => `<div class="group-card${x.sug ? ' sugerido' : ''}"><div><strong>${esc(nomC(x.c))}</strong>${x.sug ? ' <span class="tag sug">Sugerido</span>' : ''}${x.c.estado === 'pausa' ? ' <span class="tag pausa">En pausa</span>' : ''}<br><small>${estado(x)} · ${cnt[nomC(x.c)] || 0} turno(s) este mes${x.sug ? ' · opción más equilibrada' : ''}</small></div><div><button class="btn-edit-outline" onclick="asignarConductor(${x.i},false)">Asignar</button><button type="button" class="btn-whatsapp" title="${telefonoValido(x.c) ? 'Asignar y abrir WhatsApp' : 'Sin teléfono válido'}" onclick="asignarConductor(${x.i},true)">+ WhatsApp</button></div></div>`;
    const sin = `<div class="group-card"><div><strong>Sin Asignar</strong></div><button class="btn-edit-outline" onclick="asignarConductor(-1,false)">Asignar</button></div>`;
    document.getElementById('selLista').innerHTML = L.filter(x => x.sug).map(card).join('') + (modo === 'todos' && !q.trim() ? sin : '') + (L.filter(x => !x.sug).map(card).join('') || (L.some(x => x.sug) ? '' : (sinDisp ? `<div class="sel-vacio" role="alert">${IC.aviso}<span>No hay conductores disponibles para ese horario</span></div>` : '<p class="hint">Sin conductores que coincidan.</p>')));
}
function asignarConductor(ci, wa) { if (_bloqueadoLector()) return;
    const { k, idx } = selCtx, R = agendasMaestras[k], f = R[idx], c = ci >= 0 ? conductores[ci] : null; pushUndo(k);
    const ant = f.conductor; f.conductor = c ? nomC(c) : 'Sin Asignar'; f.avisado = false; f.confirmado = false;
    registrarActividad('Editar celda', `conductor: "${ant}" → "${f.conductor}" (día ${f.diaMes})`);
    let waFallo = false;
    if (wa && c) {
        if (!telefonoValido(c)) { waFallo = true; mostrarToast(`${nomC(c)} no tiene un teléfono válido guardado: se asignó el turno, pero no se abrió WhatsApp. Edita el teléfono en Conductores.`, 'error'); }
        else { window.open(waUrl(limpiarTelefono(c.telefono).replace('+', ''), mensajeWA(c, f)), '_blank', 'noopener'); f.avisado = true; }
    }
    closeModal('modalSelector'); guardarLocal();
    if (agendasMaestras[agendaKey()]) refrescarTabla(); else refrescarDerivados();
    const av = c ? avisosFila(k, R, f) : []; if (av.length && !waFallo) mostrarToast('Aviso: ' + av.join(' · '), 'error');
}

// === EXTENSIONES ===
let filtroAg = { c: '', t: '', q: '' }, bloquesCerrados = new Set(), ausTmp = [], extraTmp = [];
let excepciones = {}, filtroCond = 'todos', config = defConfig(), undoStack = [], redoStack = [], lectura = false, selCtx = null;
const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DIAS = ["DOM","LUN","MAR","MIÉ","JUE","VIE","SÁB"];
const DIAS_LARGOS = { DOM:'Domingo', LUN:'Lunes', MAR:'Martes', 'MIÉ':'Miércoles', JUE:'Jueves', VIE:'Viernes', 'SÁB':'Sábado' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const pad = n => String(n).padStart(2, '0');
const clonar = o => JSON.parse(JSON.stringify(o));
const hoyIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const numTerr = f => { if (f.terrNum != null) return String(f.terrNum); const m = /^(\d+(?:[-.]?[A-Za-z0-9]+)?)\.\s/.exec(f.territorio || ''); return m ? m[1] : null; };
const esVacio = (v, txt) => !v || norm(v) === norm(txt);

// === Diálogos estilo Material (reemplazan confirm/alert nativos) ===
function dialogo(titulo, msg, botones) {
    return new Promise(res => {
        document.getElementById('dlgTitulo').textContent = titulo; document.getElementById('dlgMsg').textContent = msg;
        const box = document.getElementById('dlgBtns'); box.innerHTML = '';
        const fin = v => { window._dlgCancel = null; closeModal('modalDialogo'); res(v); };
        botones.forEach(b => { const e = document.createElement('button'); e.type = 'button'; e.className = b.primario ? 'btn-primary' : 'btn-outline'; e.textContent = b.t; e.onclick = () => fin(b.v); box.appendChild(e); });
        window._dlgCancel = () => fin(null); openModal('modalDialogo');
    });
}
async function confirmar(msg, ok) { return (await dialogo('Confirmar', msg, [{ t: 'Cancelar', v: false }, { t: ok || 'Aceptar', v: true, primario: true }])) === true; }
function avisar(msg) { return dialogo('Atención', msg, [{ t: 'Entendido', v: true, primario: true }]); }
const limpiarEsp = x => sanearTexto(x);
const capitalizar = x => limpiarEsp(x).toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
function antiDoble(e) { const b = (e && e.submitter) || (e && e.target && e.target.querySelector('[type=submit]')); if (!b) return true; if (b.disabled) return false; b.disabled = true; setTimeout(() => { b.disabled = false; }, 900); return true; }
function waUrl(telf, msg) {
    const m = config.waModo || 'auto', web = m === 'web' || (m === 'auto' && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));
    return web ? `https://web.whatsapp.com/send?phone=${telf}&text=${encodeURIComponent(msg)}` : `https://wa.me/${telf}?text=${encodeURIComponent(msg)}`;
}
function mostrarToast(msg, tipo) {
    const c = document.getElementById('toast-container'); c.innerHTML = '';
    const t = document.createElement('div'); t.className = 'toast' + (tipo === 'error' ? ' error' : ''); t.textContent = msg;
    c.appendChild(t);
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
    clearTimeout(window._toastT);
    window._toastT = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
}
async function copiar(texto) {
    try { await navigator.clipboard.writeText(texto); return true; }
    catch (e) {
        try { const ta = document.createElement('textarea'); ta.value = texto; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; }
        catch (e2) { return false; }
    }
}

// --- Año / claves ---
function anioSel() { const e = document.getElementById('anioAgenda'); return e && e.value ? parseInt(e.value, 10) : new Date().getFullYear(); }
function obtenerAnioTrabajo() { return anioSel(); }
function agendaKey() { return `${anioSel()}-${parseInt(document.getElementById('mesAgenda').value, 10)}`; }
function nombreMesSel() { const m = document.getElementById('mesAgenda'); return m.options[m.selectedIndex].text; }
function migrarClaves(o) { const r = {}; Object.keys(o || {}).forEach(k => { r[/^\d{1,2}$/.test(k) ? `2026-${k}` : k] = o[k]; }); return r; }
function poblarAnios() {
    const y = new Date().getFullYear(), set = new Set([y - 1, y, y + 1, y + 2]);
    [...Object.keys(historialAgendas), ...Object.keys(agendasMaestras)].forEach(k => set.add(+k.split('-')[0]));
    const e = document.getElementById('anioAgenda');
    e.innerHTML = [...set].sort().map(a => `<option>${a}</option>`).join('');
    e.value = y; document.getElementById('mesAgenda').value = new Date().getMonth() + 1;
}
function asegurarAnio(a) { const e = document.getElementById('anioAgenda'); if (![...e.options].some(o => +o.value === a)) e.add(new Option(a, a)); }

// --- Historial de uso de territorios ---
function usoTerritorios(excluirKey, antesDe) {
    const u = {}, A = Object.assign({}, historialAgendas, agendasMaestras), hoy = hoyIso();
    Object.keys(A).forEach(k => {
        if (k === excluirKey) return;
        const [a, m] = k.split('-').map(Number);
        A[k].forEach(f => {
            if (f.evento) return;
            const n = numTerr(f); if (n == null) return;
            const iso = `${a}-${pad(m)}-${pad(f.diaMes)}`;
            if (antesDe && iso >= antesDe) return;
            const x = u[n] || (u[n] = { max: '', ultima: '', proxima: '' });
            if (iso > x.max) x.max = iso;
            if (iso <= hoy) { if (iso > x.ultima) x.ultima = iso; } else if (!x.proxima || iso < x.proxima) x.proxima = iso;
        });
    });
    return u;
}
function fCorta(iso) { const [a, m, d] = iso.split('-').map(Number); return `${d} ${MESES[m - 1].slice(0, 3).toLowerCase()}${a !== new Date().getFullYear() ? ' ' + a : ''}`; }
function relFecha(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    const dif = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(a, m - 1, d)) / 864e5);
    return (dif === 0 ? 'hoy' : dif === 1 ? 'ayer' : `hace ${dif} días`) + ` (${fCorta(iso)})`;
}
function elegirTerritorio(cands, ultimo, usosMes, iso) {
    if (!cands.length) return null;
    const ref = iso ? new Date(iso + 'T00:00:00') : new Date();
    const dias = u => u ? Math.round((ref - new Date(u + 'T00:00:00')) / 864e5) : Infinity;
    const rank = u => { if (!u) return 0; const d = dias(u); return d > 60 ? 0 : d >= 30 ? 1 : 2; };
    // Prioritarios/pendientes: se adelantan si llevan tiempo sin trabajarse (≥21 días: fuerte; 7-20: leve),
    // pero dejan de adelantarse al llegar a 2 usos en el mes o si se trabajaron hace menos de 7 días (equilibrio).
    const boost = (t, u, n) => !t.prioritario || n >= 2 ? 0 : dias(u) < 7 ? 0 : dias(u) >= 21 ? 2 : 1;
    return cands.map(t => { const k = tk(t), u = ultimo[k] || '', n = usosMes[k] || 0; return { t, u, r0: rank(u), n, b: boost(t, u, n), r: Math.random() }; })
        .sort((a, b) => b.b - a.b || a.r0 - b.r0 || a.u.localeCompare(b.u) || a.n - b.n || a.r - b.r)[0].t;
}

// --- Listas con búsqueda y filtros ---
function setFiltroCond(f) { filtroCond = f; renderListaConductores(); }
function resumen3m() {
    const A = Object.assign({}, historialAgendas, agendasMaestras), fin = new Date(); fin.setHours(0, 0, 0, 0);
    const ini = new Date(fin); ini.setMonth(ini.getMonth() - 3), out = {};
    Object.keys(A).forEach(k => { const [a, m] = k.split('-').map(Number); A[k].forEach(f => { if (f.evento) return; const d = new Date(a, m - 1, f.diaMes); if (d < ini || d > fin) return; const o = out[f.conductor] || (out[f.conductor] = { n: 0, d: {} }); o.n++; o.d[f.diaSemana] = (o.d[f.diaSemana] || 0) + 1; }); });
    return out;
}
function alternarEstado(i) { if (_bloqueadoLector()) return; const c = conductores[i]; c.estado = c.estado === 'pausa' ? 'activo' : 'pausa'; guardarLocal(); renderListaConductores(); registrarActividad('Editar', `${nomC(c)}: ${c.estado === 'pausa' ? 'En pausa' : 'Activo'}`); }
function renderListaConductores() {
    const cont = document.getElementById('listaConductoresItems'); if (!cont) return;
    conductores.sort((a, b) => a.nombre.localeCompare(b.nombre));
    const chips = [['todos', 'Todos'], ['anciano', 'Ancianos'], ...DIAS.slice(1).concat('DOM').map(d => [d, d.charAt(0) + d.slice(1).toLowerCase()])];
    document.getElementById('chipsConductores').innerHTML = chips.map(([v, t]) => `<button type="button" class="chip-button${filtroCond === v ? ' active' : ''}" onclick="setFiltroCond('${v}')">${t}</button>`).join('');
    const q = norm(document.getElementById('buscaConductores').value), R3 = resumen3m();
    let html = '';
    conductores.forEach((c, i) => {
        const d = c.disponibilidadDias || [];
        if (filtroCond === 'anciano' && !c.esAnciano) return;
        if (!['todos', 'anciano'].includes(filtroCond) && !d.some(x => x === filtroCond || x.startsWith(filtroCond + '-'))) return;
        if (q && !norm(`${c.nombre} ${c.apellido} ${c.telefono}`).includes(q)) return;
        const on = x => d.some(y => y === x || y.startsWith(x + '-'));
        const circ = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'].map((x, j) => `<i class="${on(x) ? 'on' : ''}" title="${DIAS_LARGOS[x]}">${'LMMJVSD'[j]}</i>`).join('');
        const r = R3[nomC(c)] || { n: 0, d: {} }, top = Object.entries(r.d).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([x]) => DIAS_LARGOS[x]).join(', ') || '—';
        const rol = c.esAnciano ? 'Anciano' : (ROLES[c.rol] || '');
        html += `<div class="group-card"><div><strong>${esc(c.nombre)} ${esc(c.apellido)}</strong>${c.vinc ? ' <span class="tag prox" title="Vinculado con un participante de Exhibidores">Vinculado</span>' : ''}${c.estado === 'pausa' ? ' <span class="tag pausa">En pausa</span>' : ''}${rol ? `<br><small>${rol}</small>` : ''}${(() => { const n = ausenciasDe(c).filter(a => a.hasta >= hoyIso()).length; return n ? `<br><small>Ausencias próximas: ${n}</small>` : ''; })()}<div class="dias-mini">${circ}</div><details class="res-cond"><summary>Resumen</summary><small>Últimos 3 meses: <b>${r.n}</b> turno(s) dirigidos<br>Días más frecuentes: ${top}</small></details></div><div class="row-actions"><button type="button" class="btn-edit-outline icon-btn" title="${c.estado === 'pausa' ? 'Activar' : 'Pausar'}" aria-label="${c.estado === 'pausa' ? 'Activar conductor' : 'Pausar conductor'}" onclick="alternarEstado(${i})">${c.estado === 'pausa' ? IC.play : IC.pausa}</button><button type="button" class="btn-edit-outline icon-btn" title="Editar" aria-label="Editar conductor" onclick="editarConductor(${i})">${IC.edit}</button><button type="button" class="btn-danger-outline icon-btn" title="Eliminar" aria-label="Eliminar conductor" onclick="eliminarConductor(${i})">${IC.trash}</button></div></div>`;
    });
    cont.innerHTML = html || '<p class="hint">Sin resultados.</p>';
}
function semaforo(u) {
    if (!u) return ['rojo', 'Nunca predicado'];
    const d = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(u + 'T00:00:00')) / 864e5);
    return [d > 60 ? 'rojo' : d >= 30 ? 'amarillo' : 'verde', `Hace ${d} día(s)`];
}
// Número de territorio: base numérica + sufijo opcional (12, 12-A, 12.1, 12A)
function partesNum(n) { const m = /^(\d+)(?:[-.]?(.+))?$/.exec(String(n ?? '').trim()); return m ? { b: +m[1], s: m[2] || '' } : null; }
function cmpNumTerr(a, b) {
    const A = partesNum(a), B = partesNum(b); if (!A || !B) return (A ? 0 : 1) - (B ? 0 : 1);
    return A.b - B.b || A.s.localeCompare(B.s, 'es', { numeric: true, sensitivity: 'base' });
}
// Subterritorio: marcado como pequeño o sin número. Tiene su propia categoría y se ordena por número dentro de su bloque.
const esSubterritorio = t => !!t.pequeno || t.numero === '' || t.numero == null;
function bloqueDeTerritorio(t) {
    // Dos secciones: "Territorios" y "Subterritorios". El orden numérico lo da el sort previo (cmpNumTerr).
    return esSubterritorio(t) ? { id: 'sub', ini: 1e6, titulo: 'Subterritorios' } : { id: 'terr', ini: 0, titulo: 'Territorios' };
}
function toggleBloque(id, abierto) { if (abierto) bloquesCerrados.delete(id); else bloquesCerrados.add(id); }
function renderListaTerritorios() {
    const cont = document.getElementById('listaTerritoriosItems'); if (!cont) return;
    territorios.sort((a, b) => cmpNumTerr(a.numero, b.numero) || a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));
    const q = norm(document.getElementById('buscaTerritorios').value), U = usoTerritorios(null, null), bloques = new Map();
    territorios.forEach((t, i) => {
        if (q && !norm(`${t.numero} ${t.nombre} ${t.lugar}`).includes(q)) return;
        const u = U[tk(t)], [col, txt] = semaforo(u && u.ultima);
        const uso = u && u.ultima ? `Última vez: ${relFecha(u.ultima)}` : 'Aún sin asignar';
        const prox = u && u.proxima ? ` · Próxima: ${fCorta(u.proxima)}` : '';
        const card = `<div class="group-card"><div><strong><span class="sem ${col}" title="${txt}"></span>${esc(terrLabel(t))}</strong>${esSubterritorio(t) ? ' <span class="tag">Subterritorio</span>' : ''}${t.prioritario ? ' <span class="tag prio">Prioritario</span>' : ''}<br><small>${t.lugar ? esc(t.lugar) + '<br>' : ''}${uso}${prox}</small></div><div class="row-actions"><button type="button" class="btn-edit-outline icon-btn" title="Editar" aria-label="Editar territorio" onclick="editarTerritorio(${i})">${IC.edit}</button><button type="button" class="btn-danger-outline icon-btn" title="Eliminar" aria-label="Eliminar territorio" onclick="eliminarTerritorio(${i})">${IC.trash}</button></div></div>`;
        const b = bloqueDeTerritorio(t), g = bloques.get(b.id) || bloques.set(b.id, { ...b, n: 0, html: '' }).get(b.id);
        g.n++; g.html += card;
    });
    const html = [...bloques.values()].sort((a, b) => a.ini - b.ini).map(g => `<details class="bloque"${q || !bloquesCerrados.has(g.id) ? ' open' : ''} ontoggle="${q ? '' : `toggleBloque('${g.id}', this.open)`}"><summary><span>${g.titulo}</span><small>${g.n} territorio(s)</small></summary>${g.html}</details>`).join('');
    cont.innerHTML = html || '<p class="hint">Sin resultados.</p>';
}

// --- Generación ---
function filaEvento(anio, mes, dia, motivo) {
    return { diaSemana: DIAS[new Date(anio, mes - 1, dia).getDay()], diaMes: dia, hora: 'Todo el día', evento: true, motivo, conductor: '', territorio: '', lugar: '', grupos: '', avisado: false };
}
function esUltimoSabado(a, m, d) { return new Date(a, m - 1, d).getDay() === 6 && d + 7 > new Date(a, m, 0).getDate(); }
// Reuniones por día y hora exacta (p. ej. 'MIÉ-06:30 PM'). Por defecto: miércoles 6:30 PM y domingo 9:00 AM.
// Formato simple: 'DÍA-AM' o 'DÍA-PM'. Convierte el formato antiguo con hora exacta (p. ej. 'MIÉ-06:30 PM' → 'MIÉ-PM').
function migrarReuniones(arr) {
    const out = new Set();
    (arr || []).forEach(v => {
        if (/^[^-]+-(AM|PM)$/.test(v)) { out.add(v); return; }
        const m = /^([^-]+)-(\d{1,2}:\d{2}\s*(?:AM|PM))$/i.exec(v); if (m) out.add(`${m[1]}-${bloqueDe(m[2])}`);
    });
    return [...out];
}
function reunionesCfg() {
    if (!config.reunionesInit) { if (!(config.reuniones || []).length) config.reuniones = defConfig().reuniones.slice(); config.reunionesInit = true; }
    config.reuniones = migrarReuniones(config.reuniones);
    return config.reuniones;
}
// Regla del domingo: la reunión es a las 9:00 AM, pero el grupo de las 11:00 AM (11:00 AM-12:00 PM) SIEMPRE se programa.
function reunionBloquea(dia, hora) {
    if (dia === 'DOM' && hMin(hora) === 11 * 60) return false;
    return reunionesCfg().includes(`${dia}-${bloqueDe(hora)}`);
}
// === Parte 2: horarios base configurables ===
const DIAS_SEM = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'];
// Reglas fijas: viernes 06:30 PM (Telegram) y domingo 11:00 AM siempre; el último sábado 09:00 AM se añade al generar.
function horasReglaFija(dia) { return dia === 'VIE' ? [HORA_TELEGRAM] : dia === 'DOM' ? [HORA_GRUPO_DOM] : []; }
function horariosBase(dia) { const h = config.horariosDia && config.horariosDia[dia]; return Array.isArray(h) ? h.slice() : (MATRIZ_HORARIOS[dia] || []).slice(); }
function horasBaseExtra() { const o = new Set(); DIAS_SEM.forEach(d => horariosBase(d).forEach(h => { if (!STD_HORAS.includes(h)) o.add(h); })); return [...o].sort((a, b) => hMin(a) - hMin(b)); }
function horasDelDia(dia) {
    const st = new Set(horariosBase(dia));
    if (dia === 'VIE') st.add(HORA_TELEGRAM);
    territorios.forEach(t => { if ((t.disponibilidadDias || []).includes(dia)) (t.disponibilidadHoras || []).forEach(h => { if (!STD_HORAS.includes(h)) st.add(h); }); });
    return [...st].sort((a, b) => hMin(a) - hMin(b));
}
// === Parte 2: ausencias (rangos) y fechas extra de disponibilidad ===
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function normAus(a) {
    if (!a || !ISO_RE.test(a.desde || '')) return null;
    let d = a.desde, h = ISO_RE.test(a.hasta || '') ? a.hasta : d; if (h < d) [d, h] = [h, d];
    return { desde: d, hasta: h, motivo: sanearTexto(a.motivo || '').slice(0, 60) };
}
// Todas las ausencias del conductor: rangos nuevos + fechaNoDisponible heredada (compatibilidad hacia atrás)
function ausenciasDe(c) {
    const out = (c.ausencias || []).map(normAus).filter(Boolean);
    if (ISO_RE.test(c.fechaNoDisponible || '') && !out.some(a => a.desde <= c.fechaNoDisponible && a.hasta >= c.fechaNoDisponible)) out.push({ desde: c.fechaNoDisponible, hasta: c.fechaNoDisponible, motivo: '' });
    return out;
}
function enAusencia(c, iso) { return ausenciasDe(c).find(a => iso >= a.desde && iso <= a.hasta) || null; }
function extraDisp(c, iso) { return (c.fechasExtraDisp || []).includes(iso) || c.fechaDisponible === iso; }
function condDispo(c, dia, hora, iso) {
    if (c.estado === 'pausa') return false;
    if (exhChoqueConductor(c, iso)) return false;   // Parte 4: ya tiene exhibidor ese día
    if (extraDisp(c, iso)) return true;
    return conductorDisponible(c, dia, bloqueDe(hora)) && !enAusencia(c, iso);
}
// Avisos de una fila (no impiden editar): duplicado, pausa, ausencia o sin disponibilidad semanal
function avisosFila(k, R, f) {
    const out = []; if (!f || f.evento || esVacio(f.conductor, 'Sin Asignar')) return out;
    const iso = isoFila(k, f), c = conductores.find(x => norm(nomC(x)) === norm(f.conductor));
    if (R.some(x => x !== f && !x.evento && x.diaMes === f.diaMes && x.hora === f.hora && norm(x.conductor) === norm(f.conductor))) out.push('Conductor repetido en el mismo día y hora');
    if (c) {
        if (c.estado === 'pausa') out.push(`${nomC(c)} está en pausa`);
        const au = enAusencia(c, iso);
        if (au && !extraDisp(c, iso)) out.push(`Ausente en esa fecha${au.motivo ? ' (' + au.motivo + ')' : ''}: ${fCorta(au.desde)}${au.hasta !== au.desde ? ' – ' + fCorta(au.hasta) : ''}`);
        else if (c.estado !== 'pausa' && !extraDisp(c, iso) && !conductorDisponible(c, f.diaSemana, bloqueDe(f.hora))) out.push(`No tiene marcada disponibilidad el ${DIAS_LARGOS[f.diaSemana] || f.diaSemana} en la ${bloqueDe(f.hora) === 'AM' ? 'mañana' : 'tarde'}`);
    }
    { const ce = exhEnExh(f.conductor, exhTelDeNombre(f.conductor), iso); if (ce) out.push(`Choque: ${f.conductor} ya tiene turno de exhibidor el ${DIAS_LARGOS[f.diaSemana]} ${f.diaMes} (${ce.f.hora}, ${ce.f.lugar || 'lugar por definir'})`); }
    return out;
}
// === MÓDULO 5: MOTOR DE GENERACIÓN (GRUPOS Y EXHIBIDORES) ===
async function generarNuevaAgenda() { if (_bloqueadoLector()) return;
    if (agendasMaestras[agendaKey()]) {
        const i = impactoAgenda(agendasMaestras[agendaKey()]);
        if (!(await confirmar(`Ya existe una agenda para ${nombreMesSel()} ${anioSel()}.\n\n✔ Se conservarán: ${i.fij ? i.fij + ' turno(s) fijado(s) con candado' : 'ningún turno (no hay turnos fijados con candado)'}.\n✖ Se reemplazarán: ${i.rest} turno(s) sin candado y tus ediciones manuales en ellos${i.marcas ? ` (${i.marcas} con aviso o confirmación, que se perderán)` : ''}.\n\nPodrás usar Deshacer después.`, 'Regenerar'))) return;
    }
    _generarNuevaAgenda();
}
function _generarNuevaAgenda() {
    const mes = parseInt(document.getElementById('mesAgenda').value, 10), nombreMes = nombreMesSel(), anio = anioSel(), key = agendaKey();
    const diasEnMes = new Date(anio, mes, 0).getDate(), nuevaAgenda = [], ex = excepciones[key] || [];
    if (agendasMaestras[key]) pushUndo(key);
    const fijadas = (agendasMaestras[key] || []).filter(f => f.fijado && !f.evento).map(clonar);   // Parte 2: turnos con candado
    const base = usoTerritorios(key, `${anio}-${pad(mes)}-01`), ultimo = {}, usosMes = {}, maxT = Math.max(1, parseInt(config.maxTurnos, 10) || 4);
    Object.keys(base).forEach(n => { ultimo[n] = base[n].max; });
    const marcar = (t, iso) => { const k = tk(t); ultimo[k] = iso; usosMes[k] = (usosMes[k] || 0) + 1; };

    for (let i = 1; i <= diasEnMes; i++) {
        const fijasDia = fijadas.filter(f => f.diaMes === i), iniDia = nuevaAgenda.length;
        const evt = ex.find(e => i >= e.desde && i <= e.hasta);
        if (evt) { nuevaAgenda.push(filaEvento(anio, mes, i, evt.motivo)); fijasDia.forEach(f => nuevaAgenda.push(f)); continue; }
        const diaNombre = DIAS[new Date(anio, mes - 1, i).getDay()], fechaIso = `${anio}-${pad(mes)}-${pad(i)}`, usadosHoy = [];
        // Los turnos fijados entran intactos y cuentan para el equilibrio y para no repetir territorio ese día
        fijasDia.forEach(f => { nuevaAgenda.push(f); const n = numTerr(f); if (n != null) { usadosHoy.push(n); ultimo[n] = fechaIso; usosMes[n] = (usosMes[n] || 0) + 1; } });

        const esUltSab = esUltimoSabado(anio, mes, i);
        const horasDia = horasDelDia(diaNombre);
        if (esUltSab && !horasDia.includes(HORA_ULT_SAB)) { horasDia.push(HORA_ULT_SAB); horasDia.sort((x, y) => hMin(x) - hMin(y)); }
        if (diaNombre === 'DOM' && !horasDia.includes(HORA_GRUPO_DOM)) horasDia.push(HORA_GRUPO_DOM);   // domingo: siempre grupo de 11:00 AM

        horasDia.forEach(hora => {
            if (reunionBloquea(diaNombre, hora)) return;
            if (!(esUltSab && hora === HORA_ULT_SAB) && fijasDia.some(f => hMin(f.hora) === hMin(hora))) return;   // ya hay un turno fijado a esa hora

            // Último sábado: 8 grupos a las 9:00 AM, uno por grupo (1-8), dirigidos por su anciano
            if (esUltSab && hora === HORA_ULT_SAB) {
                const fijasSlot = fijasDia.filter(f => hMin(f.hora) === hMin(hora));
                const lugares = fijasSlot.filter(f => f.lugar).map(f => norm(f.lugar)), conductoresSlot = fijasSlot.map(f => f.conductor).filter(x => !esVacio(x, 'Sin Asignar'));
                for (let n = 1; n <= NUM_GRUPOS; n++) {
                    if (fijasSlot.some(f => norm(f.grupos) === 'grupo ' + n)) continue;   // ese grupo ya está fijado
                    const nombreAnc = ancianoDeGrupo(n, fechaIso, conductoresSlot);
                    if (nombreAnc) conductoresSlot.push(nombreAnc);
                    let pool = territorios.filter(t => !usadosHoy.includes(tk(t)) && !(t.lugar && lugares.includes(norm(t.lugar))));
                    const sab = pool.filter(t => (t.disponibilidadDias || []).includes('SÁB')); if (sab.length) pool = sab;
                    const t = elegirTerritorio(pool, ultimo, usosMes, fechaIso);
                    if (t) { usadosHoy.push(tk(t)); if (t.lugar) lugares.push(norm(t.lugar)); marcar(t, fechaIso); }
                    nuevaAgenda.push({ diaSemana: diaNombre, diaMes: i, hora, conductor: nombreAnc || 'Sin Asignar', territorio: t ? terrLabel(t) : 'Sin Territorio', terrNum: t ? tk(t) : null, lugar: t ? (t.lugar || 'Por Definir') : 'Por Definir', grupos: `Grupo ${n}`, avisado: false, confirmado: false });
                }
                return;
            }

            const tele = esTelegram(diaNombre, hora);
            let conds = conductores.filter(c => condDispo(c, diaNombre, hora, fechaIso));
            // Telegram: se prioriza a quienes sacan grupos por Telegram
            if (tele) { const tg = conds.filter(c => c.telegram); if (tg.length) conds = tg; }
            const terrs = territorios.filter(t => (t.disponibilidadDias || []).includes(diaNombre) && (t.disponibilidadHoras || []).includes(hora) && !usadosHoy.includes(tk(t)));
            const grupoObjetivo = ((i % NUM_GRUPOS) + 1).toString();
            const c = obtenerConductorOptimo(conds, nuevaAgenda, i, grupoObjetivo, { max: maxT, diaNombre });
            const t = elegirTerritorio(terrs, ultimo, usosMes, fechaIso);
            if (t) { usadosHoy.push(tk(t)); marcar(t, fechaIso); }
            nuevaAgenda.push({
                diaSemana: diaNombre, diaMes: i, hora,
                conductor: c ? nomC(c) : 'Sin Asignar',
                territorio: t ? terrLabel(t) : 'Sin Territorio', terrNum: t ? tk(t) : null,
                lugar: tele ? 'Vía Telegram' : (t ? (t.lugar || 'Por Definir') : 'Por Definir'),
                grupos: tele ? 'Telegram' : 'Todos', avisado: false, confirmado: false
            });
        });
        if (fijasDia.length) { const filasDia = nuevaAgenda.splice(iniDia); filasDia.sort((a, b) => hMin(a.hora) - hMin(b.hora)); nuevaAgenda.push(...filasDia); }
    }
    agendasMaestras[key] = nuevaAgenda; guardarLocal();
    renderAgenda(nuevaAgenda, nombreMes);
    document.getElementById('resultadoAgenda').classList.remove('hidden');
    registrarActividad('Generar', `Agenda de ${nombreMes} ${anio}`);
}

// --- Tabla ---
// === MÓDULO 6: RENDERIZADO, FILTROS Y EXPORTACIÓN ===
function refrescarTabla() { const R = agendasMaestras[agendaKey()]; if (R) renderAgenda(R, nombreMesSel()); }
function refrescarDerivados() { exhRefrescarChoques(); renderEstadisticas(); renderContactos(); renderListaTerritorios(); renderHoy(); actualizarBadge(); updateUndoUI(); actualizarEstadoHistorial(); }
function renderAgenda(datos, nombreMes) {
    document.getElementById('fechaActualDisplay').innerText = `${nombreMes} ${anioSel()}`;
    const cuerpo = document.getElementById('tablaCuerpoAgenda'); if (!cuerpo) return;
    const CE = lectura ? 'false' : 'true';
    poblarFiltrosAgenda(datos);
    let ultimoDia = null, html = '';
    datos.forEach((f, i) => {
        if (!coincideFiltro(f)) return;
        const nuevo = ultimoDia !== f.diaMes;
        const cls = (ultimoDia && nuevo) ? ' class="day-separator"' : '';
        const cab = `<td class="bold-cell">${nuevo ? esc(f.diaSemana) : ''}</td><td class="bold-cell">${nuevo ? esc(f.diaMes) : ''}</td>`;
        const ed = (c, v) => `<td data-campo="${c}" contenteditable="${CE}" onblur="actualizarCelda(${i},'${c}',this.innerText)">${esc(v)}</td>`;
        const sel = (c, v, vacio) => `<td class="${lectura ? '' : 'edit-select '}${esVacio(v, vacio) ? 'sin-asignar' : ''}" data-campo="${c}">${esc(v)}</td>`;
        const bloq = f.evento ? '' : `<button class="btn-outline mini lock${f.fijado ? ' on' : ''}" title="${f.fijado ? 'Turno fijado: no se sobrescribe al regenerar el mes' : 'Fijar turno (no se sobrescribe al regenerar el mes)'}" aria-label="${f.fijado ? 'Quitar candado del turno' : 'Fijar turno'}" aria-pressed="${f.fijado ? 'true' : 'false'}" onclick="bloquearTurno(${i})">${f.fijado ? IC.lock : IC.unlock}</button>`;
        const acc = lectura ? `<td class="no-export acc">${f.fijado && !f.evento ? `<span class="mini lock on" title="Turno fijado" style="display:inline-flex">${IC.lock}</span>` : ''}</td>` : `<td class="no-export acc">${f.evento ? '' : `<button class="btn-outline mini" title="Agregar turno en este día" aria-label="Agregar turno" onclick="agregarFila(${i})">${IC.mas}</button><button class="btn-outline mini" title="Reemplazo de emergencia" onclick="abrirSelectorConductor(agendaKey(),${i},'libres')">Sustituir</button>${bloq}`}<button class="btn-outline mini del" title="Eliminar fila" aria-label="Eliminar fila" onclick="eliminarFila(${i})">${IC.x}</button></td>`;
        const cuerpoFila = f.evento
            ? `<td colspan="5" class="evento-cell" contenteditable="${CE}" onblur="actualizarCelda(${i},'motivo',this.innerText)">${esc(f.motivo)}</td>`
            : `<td><span class="hora-plana" contenteditable="${CE}" onblur="actualizarCelda(${i},'hora',this.innerText)">${esc(f.hora)}</span></td>${sel('conductor', f.conductor, 'Sin Asignar')}${sel('territorio', f.territorio, 'Sin Territorio')}${ed('lugar', f.lugar)}${ed('grupos', f.grupos)}`;
        html += `<tr data-diames="${esc(f.diaMes)}" data-idx="${i}" style="--i:${Math.min(i, 40)}"${cls}>${cab}${cuerpoFila}${acc}</tr>`;
        ultimoDia = f.diaMes;
    });
    cuerpo.innerHTML = html || `<tr><td colspan="8" class="hint" style="text-align:center;padding:18px">Ningún turno coincide con la búsqueda o el filtro.</td></tr>`;
    validarTabla(); refrescarDerivados();
}
function validarTabla() {
    const k = agendaKey(), R = agendasMaestras[k] || [], ll = {}, kh = f => f.diaMes + '|' + f.hora + '|', cc = {};
    R.forEach(f => {
        if (f.evento) return;
        if (!esVacio(f.conductor, 'Sin Asignar')) { const kk = kh(f) + norm(f.conductor); cc[kk] = (cc[kk] || 0) + 1; }
        const l = norm(f.lugar); if (l && l !== 'por definir' && !l.includes('telegram')) { const kk = kh(f) + l; ll[kk] = (ll[kk] || 0) + 1; }
    });
    document.querySelectorAll('#tablaCuerpoAgenda tr[data-idx]').forEach(tr => {
        const f = R[+tr.dataset.idx]; if (!f || f.evento) return;
        const c = tr.querySelector('td[data-campo="conductor"]'), l = tr.querySelector('td[data-campo="lugar"]');
        if (c) {
            c.classList.toggle('warn-cond', cc[kh(f) + norm(f.conductor)] > 1);
            c.classList.toggle('choque-exh', !esVacio(f.conductor, 'Sin Asignar') && !!exhEnExh(f.conductor, exhTelDeNombre(f.conductor), isoFila(k, f)));
            c.querySelectorAll(':scope > .warn-ico').forEach(e => e.remove());
            const av = avisosFila(k, R, f);
            if (av.length) {
                const msg = av.join(' · '), ico = document.createElement('span');
                ico.className = 'warn-ico no-export'; ico.title = msg; ico.setAttribute('role', 'img'); ico.setAttribute('aria-label', 'Aviso: ' + msg); ico.innerHTML = IC.aviso;
                ico.addEventListener('click', ev => { ev.stopPropagation(); mostrarToast(msg, 'error'); });
                c.appendChild(ico);
            }
        }
        if (l) { const dup = ll[kh(f) + norm(f.lugar)] > 1; l.classList.toggle('warn-lugar', dup); if (dup) l.title = 'Lugar repetido en el mismo día y hora'; else l.removeAttribute('title'); }
    });
}
// === Parte 2: candado por turno ===
function bloquearTurno(idx) {
    if (lectura) return; const R = agendasMaestras[agendaKey()]; if (!R || !R[idx] || R[idx].evento) return;
    pushUndo(); const f = R[idx]; f.fijado = !f.fijado;
    registrarActividad(f.fijado ? 'Fijar turno' : 'Quitar candado', `Día ${f.diaMes} ${f.hora || ''} — ${nombreMesSel()}`);
    guardarLocal(); refrescarTabla(); mostrarToast(f.fijado ? 'Turno fijado: se conservará al regenerar el mes' : 'Turno liberado');
}
// === Parte 2: filtros de la agenda ===
const claveTerrFila = f => { const n = numTerr(f); return n != null ? n : 'T:' + f.territorio; };
function textoFila(f) { return norm(`${DIAS_LARGOS[f.diaSemana] || ''} ${f.diaSemana} ${f.diaMes} ${f.hora} ${f.conductor} ${f.territorio} ${f.lugar} ${f.grupos}`); }
function coincideFiltro(f) {
    const hayQ = !!norm(filtroAg.q || '').trim();
    if (!filtroAg.c && !filtroAg.t && !hayQ) return true;
    if (f.evento) return false;
    const ws = norm(filtroAg.q || '').trim().split(/\s+/).filter(Boolean);
    if (ws.length) { const tx = textoFila(f); if (!ws.every(w => tx.includes(w))) return false; }
    if (filtroAg.c) { const sin = esVacio(f.conductor, 'Sin Asignar'); if (filtroAg.c === '__sin' ? !sin : f.conductor !== filtroAg.c) return false; }
    if (filtroAg.t) { const sinT = esVacio(f.territorio, 'Sin Territorio'); if (filtroAg.t === '__sin') { if (!sinT) return false; } else if (sinT || claveTerrFila(f) !== filtroAg.t) return false; }
    return true;
}
function poblarFiltrosAgenda(datos) {
    const sc = document.getElementById('filtroConductor'), st = document.getElementById('filtroTerritorio'); if (!sc || !st) return;
    const cs = [...new Set(datos.filter(f => !f.evento && !esVacio(f.conductor, 'Sin Asignar')).map(f => f.conductor))].sort((a, b) => a.localeCompare(b, 'es'));
    const ts = new Map(); datos.forEach(f => { if (!f.evento && !esVacio(f.territorio, 'Sin Territorio')) { const n = claveTerrFila(f); if (!ts.has(n)) ts.set(n, f.territorio); } });
    const tsA = [...ts].sort((a, b) => cmpNumTerr(a[0], b[0]) || a[1].localeCompare(b[1], 'es'));
    if (filtroAg.c && filtroAg.c !== '__sin' && !cs.includes(filtroAg.c)) filtroAg.c = '';
    if (filtroAg.t && filtroAg.t !== '__sin' && !ts.has(filtroAg.t)) filtroAg.t = '';
    sc.innerHTML = '<option value="">Conductor: Todos</option><option value="__sin">Sin asignar</option>' + cs.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    st.innerHTML = '<option value="">Territorio: Todos</option><option value="__sin">Sin territorio</option>' + tsA.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join('');
    sc.value = filtroAg.c; st.value = filtroAg.t;
    actualizarBusquedaAgendaUI(datos);
}
// Barra de búsqueda: siempre visible en la Agenda. Filtra solo la vista; los datos guardados no se modifican.
function actualizarBusquedaAgendaUI(datos) {
    const box = document.getElementById('filtroBusqBox'); if (!box) return;
    box.classList.remove('hidden');
    const inp = document.getElementById('filtroBusqueda');
    if (inp && inp.value !== (filtroAg.q || '')) inp.value = filtroAg.q || '';
    const q = (filtroAg.q || '').trim(), hayFiltro = !!(filtroAg.c || filtroAg.t);
    const total = (datos || []).filter(f => !f.evento).length;
    const n = (datos || []).filter(f => !f.evento && coincideFiltro(f)).length;
    const partes = [];
    if (filtroAg.c) partes.push(filtroAg.c === '__sin' ? 'turnos sin conductor' : 'conductor: ' + filtroAg.c);
    if (filtroAg.t) { const o = document.getElementById('filtroTerritorio'); partes.push(filtroAg.t === '__sin' ? 'turnos sin territorio' : 'territorio: ' + (o && o.selectedOptions[0] ? o.selectedOptions[0].text : filtroAg.t)); }
    if (q) partes.push('búsqueda: "' + q + '"');
    document.getElementById('filtroBusqInfo').textContent = (hayFiltro || q) ? `${n} de ${total} asignación(es) · ${partes.join(' · ')}` : `${total} asignación(es) en la agenda`;
    const cl = document.getElementById('filtroBusqClear'); if (cl) cl.classList.toggle('hidden', !q);
    const lt = document.getElementById('filtroBusqLimpiarTodo'); if (lt) lt.classList.toggle('hidden', !(hayFiltro || q));
}
function limpiarBusquedaAgenda() { filtroAg.q = ''; const i = document.getElementById('filtroBusqueda'); if (i) { i.value = ''; i.focus(); } refrescarTabla(); }
function aplicarBusquedaAgenda(v) { filtroAg.q = v; refrescarTabla(); }
function aplicarFiltrosAgenda() {
    const c = document.getElementById('filtroConductor').value, t = document.getElementById('filtroTerritorio').value;
    filtroAg = { c, t, q: filtroAg.q || '' }; refrescarTabla();
}
function limpiarFiltrosAgenda() { if (!filtroAg.c && !filtroAg.t && !filtroAg.q) return; filtroAg = { c: '', t: '', q: '' }; refrescarTabla(); }
// === Parte 2: estado del borrador frente al historial ===
const firmaAgenda = R => (R || []).map(f => [f.diaMes, f.hora, f.evento ? 'E:' + f.motivo : '', f.conductor, f.territorio, f.lugar, f.grupos, f.fijado ? 1 : 0].join('|')).join('\n');
function actualizarEstadoHistorial() {
    const e = document.getElementById('estadoHistorial'); if (!e) return;
    const k = agendaKey(), M = agendasMaestras[k], H = historialAgendas[k];
    if (!M) { e.className = 'hist-estado'; e.innerHTML = ''; e.removeAttribute('title'); return; }
    const ok = !!H && firmaAgenda(H) === firmaAgenda(M);
    e.className = 'hist-estado ' + (ok ? 'ok' : 'pend');
    e.title = ok ? 'El borrador coincide con la versión guardada en el historial' : (H ? 'Hay cambios respecto a lo guardado en el historial' : 'Este mes aún no se ha guardado en el historial');
    e.innerHTML = (ok ? IC.ok14 : IC.punto) + '<span>' + (ok ? 'Guardado en historial' : 'Con cambios sin guardar en historial') + '</span>';
}
function actualizarCelda(idx, campo, valor) { if (_bloqueadoLector()) return;
    const R = agendasMaestras[agendaKey()];
    if (R && R[idx]) {
        const v = sanearTexto(valor), anterior = R[idx][campo];
        if (anterior !== v) {
            pushUndo(); R[idx][campo] = v;
            registrarActividad('Editar celda', `${campo}: "${anterior}" → "${v}" (día ${R[idx].diaMes})`);
        }
        validarTabla(); renderEstadisticas(); renderContactos(); renderHoy(); actualizarEstadoHistorial();
        // Si el texto tenía etiquetas o saltos de línea, la celda se redibuja ya limpia
        if (v !== String(valor ?? '').trim()) refrescarTabla();
    }
}
function agregarFila(i) { if (_bloqueadoLector()) return;
    if (lectura) return; const k = agendaKey(), R = agendasMaestras[k]; if (!R || !R[i]) return;
    pushUndo(); const d = R[i].diaMes; let pos = i; R.forEach((f, j) => { if (f.diaMes === d) pos = j; });
    R.splice(pos + 1, 0, { diaSemana: R[i].diaSemana, diaMes: d, hora: '09:00 AM', conductor: 'Sin Asignar', territorio: 'Sin Territorio', terrNum: null, lugar: 'Por Definir', grupos: 'Todos', avisado: false, confirmado: false });
    guardarLocal(); registrarActividad('Agregar turno', `Día ${d} — ${nombreMesSel()}`); refrescarTabla();
}
function eliminarFila(i) { if (_bloqueadoLector()) return;
    if (lectura) return; const R = agendasMaestras[agendaKey()]; if (!R || !R[i]) return;
    pushUndo(); const f = R.splice(i, 1)[0]; guardarLocal();
    registrarActividad('Eliminar turno', `Día ${f.diaMes} ${f.hora || ''} — ${nombreMesSel()}`); refrescarTabla();
}
document.getElementById('tablaCuerpoAgenda').addEventListener('click', e => {
    if (lectura) return;
    const td = e.target.closest('td.edit-select'); if (!td || td.querySelector('select')) return;
    const idx = +td.closest('tr').dataset.idx;
    if (td.dataset.campo === 'conductor') abrirSelectorConductor(agendaKey(), idx, 'todos'); else abrirSelector(td, idx);
});
function abrirSelector(td, idx) {
    const f = agendasMaestras[agendaKey()][idx], campo = td.dataset.campo;
    let ops = ['Sin Territorio', ...territorios.map(terrLabel)];
    if (f[campo] && !ops.includes(f[campo])) ops.push(f[campo]);
    const s = document.createElement('select'); s.className = 'cell-select';
    s.innerHTML = ops.map(o => `<option value="${esc(o)}"${o === f[campo] ? ' selected' : ''}>${esc(o)}</option>`).join('');
    let hecho = false;
    s.onchange = () => { hecho = true; aplicarSeleccion(idx, campo, s.value); };
    s.onblur = () => { if (!hecho) refrescarTabla(); };
    td.textContent = ''; td.appendChild(s); s.focus();
    try { if (s.showPicker) s.showPicker(); } catch (e) {}
}
function aplicarSeleccion(idx, campo, v) { if (_bloqueadoLector()) return;
    const f = agendasMaestras[agendaKey()][idx], ant = f[campo];
    if (ant !== v) {
        pushUndo(); f[campo] = v;
        const t = territorios.find(t => terrLabel(t) === v); f.terrNum = t ? tk(t) : null; if (t) f.lugar = t.lugar || 'Por Definir';
        registrarActividad('Editar celda', `${campo}: "${ant}" → "${v}" (día ${f.diaMes})`);
    }
    guardarLocal(); refrescarTabla();
}

// --- Resumen (pestaña dedicada: balance mensual + equilibrio mensual/anual de territorios) ---
let resumenListo = false;
function esTabResumenActiva() { const t = document.getElementById('tab-resumen'); return !!t && t.classList.contains('active'); }
function renderEstadisticas() { if (esTabResumenActiva()) renderResumen(); }
function poblarResumenSelectores(forzar) {
    const sa = document.getElementById('resAnio'), sm = document.getElementById('resMes'); if (!sa || !sm) return;
    const y = new Date().getFullYear(), set = new Set([y - 1, y, y + 1, anioSel()]);
    [...Object.keys(historialAgendas), ...Object.keys(agendasMaestras)].forEach(k => { const a = parseInt(k.split('-')[0], 10); if (a) set.add(a); });
    const prev = sa.value;
    sa.innerHTML = [...set].sort().map(a => `<option>${a}</option>`).join('');
    if (!resumenListo || forzar) { sa.value = anioSel(); sm.value = document.getElementById('mesAgenda').value; resumenListo = true; }
    else if ([...sa.options].some(o => o.value === prev)) sa.value = prev;
}
const nivelEq = disp => disp <= 1 ? ['ok', 'Equilibrado'] : disp <= 3 ? ['mid', 'Moderado'] : ['bad', 'Desbalanceado'];
function renderResumen() {
    const cont = document.getElementById('resumenCuerpo'); if (!cont) return;
    poblarResumenSelectores();
    const anio = parseInt(document.getElementById('resAnio').value, 10) || anioSel(), mes = parseInt(document.getElementById('resMes').value, 10) || 1;
    const A = Object.assign({}, historialAgendas, agendasMaestras), kMes = `${anio}-${mes}`, Rall = A[kMes] || null, R = (Rall || []).filter(f => !f.evento);
    const fuente = document.getElementById('resEstadoFuente');
    fuente.textContent = Rall ? `${agendasMaestras[kMes] ? 'Datos del borrador actual' : 'Datos del historial guardado'} de ${MESES[mes - 1]} ${anio}.` : `No hay agenda generada ni guardada para ${MESES[mes - 1]} ${anio}. El balance mensual aparecerá cuando exista; el equilibrio anual sí considera los demás meses de ${anio}.`;

    // --- Balance mensual ---
    const cnt = {}; conductores.forEach(c => { cnt[nomC(c)] = 0; });
    let sinC = 0, sinT = 0;
    R.forEach(f => {
        if (esVacio(f.conductor, 'Sin Asignar')) sinC++; else cnt[f.conductor] = (cnt[f.conductor] || 0) + 1;
        if (esVacio(f.territorio, 'Sin Territorio')) sinT++;
    });
    const arr = Object.entries(cnt).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'es'));
    const max = Math.max(1, ...arr.map(x => x[1])), cMax = arr.length ? arr[0][1] : 0, cMin = arr.length ? arr[arr.length - 1][1] : 0, difC = cMax - cMin;
    const barras = (lista, mx) => lista.map(([n, v]) => `<div class="stat-row"><span>${esc(n)}</span><div class="stat-bar"><i style="width:${mx ? v / mx * 100 : 0}%"></i></div><b>${v}</b></div>`).join('');

    const cMes = {}; R.forEach(f => { const n = numTerr(f); if (n != null) cMes[n] = (cMes[n] || 0) + 1; });
    const totT = territorios.length, cubiertos = territorios.filter(t => cMes[tk(t)]), libres = territorios.filter(t => !cMes[tk(t)]);
    const pctMes = totT ? Math.round(cubiertos.length / totT * 100) : 0;

    // --- Año elegido ---
    const cAnio = {}, cobMeses = [];
    for (let m = 1; m <= 12; m++) {
        const F = (A[`${anio}-${m}`] || []).filter(f => !f.evento), set = new Set();
        F.forEach(f => { const n = numTerr(f); if (n != null) { cAnio[n] = (cAnio[n] || 0) + 1; set.add(n); } });
        const hay = !!A[`${anio}-${m}`] && F.length > 0, cub = territorios.filter(t => set.has(tk(t))).length;
        cobMeses.push({ m, hay, cub, pct: hay && totT ? Math.round(cub / totT * 100) : 0 });
    }
    const filas = territorios.map(t => ({ t, m: cMes[tk(t)] || 0, a: cAnio[tk(t)] || 0 })).sort((x, y) => cmpNumTerr(x.t.numero, y.t.numero) || x.t.nombre.localeCompare(y.t.nombre, 'es', { numeric: true }));
    const aMax = filas.length ? Math.max(...filas.map(x => x.a)) : 0, aMin = filas.length ? Math.min(...filas.map(x => x.a)) : 0, dispA = aMax - aMin;
    const mMax = filas.length ? Math.max(...filas.map(x => x.m)) : 0, mMin = filas.length ? Math.min(...filas.map(x => x.m)) : 0, dispM = mMax - mMin;
    const cubA = filas.filter(x => x.a > 0).length, pctA = totT ? Math.round(cubA / totT * 100) : 0;
    const nvA = nivelEq(dispA), nvM = nivelEq(dispM);
    const lim = l => esc(l.slice(0, 8).join(', ')) + (l.length > 8 ? ` y ${l.length - 8} más` : '');
    const satA = dispA ? filas.filter(x => x.a === aMax).map(x => terrLabel(x.t)) : [], rezA = dispA ? filas.filter(x => x.a === aMin).map(x => terrLabel(x.t)) : [];
    const repetM = filas.filter(x => x.m > 1).length;

    // --- Secciones ---
    const kpi = (v, et, cls, sub) => `<div class="kpi ${cls || ''}"><b>${v}</b><span>${et}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const sec1 = `<section class="module-section"><div class="module-title">Balance de ${MESES[mes - 1]} ${anio}</div>`
        + (Rall ? `<div class="res-kpis">${kpi(R.length, 'Turnos totales')}${kpi(sinC, 'Sin conductor', sinC ? 'warn' : 'ok')}${kpi(sinT, 'Sin territorio', sinT ? 'warn' : 'ok')}${kpi(pctMes + '%', 'Cobertura de territorios', pctMes === 100 ? 'ok' : '', `${cubiertos.length} de ${totT}`)}${kpi(difC, 'Dif. de carga', difC >= 3 ? 'warn' : '', arr.length ? `máx ${cMax} · mín ${cMin}` : '')}</div>`
            + `<div class="cov-track" title="Cobertura de territorios del mes"><i style="width:${pctMes}%"></i></div>`
            + `<div class="stats-sec"><h4>Carga por conductor</h4>${arr.length ? barras(arr, max) : '<p class="hint">Aún no hay conductores registrados.</p>'}`
            + (arr.length ? `<p class="hint${difC >= 3 ? ' warn' : ''}">Diferencia entre quien más y quien menos dirige: <b>${difC}</b> turno(s).</p>` : '') + `</div>`
            + `<div class="stats-sec"><h4>Territorios sin asignar en el mes (${libres.length})</h4>${libres.length ? `<p class="hint">${lim(libres.map(t => terrLabel(t) + (t.prioritario ? ' ★' : '')))}${libres.some(t => t.prioritario) ? ' <span class="tag prio">★ prioritario</span>' : ''}</p>` : '<p class="hint">Todos los territorios fueron cubiertos este mes.</p>'}</div>`
            : '<p class="hint">Sin datos para este mes.</p>')
        + `</section>`;

    const colMes = cobMeses.map(x => `<div class="mes-col${x.m === mes ? ' sel' : ''}${x.hay ? '' : ' vacio'}" title="${MESES[x.m - 1]}: ${x.hay ? `${x.cub} de ${totT} territorios (${x.pct}%)` : 'sin agenda'}"><span>${x.hay ? x.pct + '%' : '–'}</span><i style="height:${x.hay ? Math.max(4, x.pct * 1.0) : 4}px"></i><em>${MESES[x.m - 1].slice(0, 3)}</em></div>`).join('');
    const sec2 = `<section class="module-section"><div class="module-title">Cobertura mensual de ${anio}</div>`
        + `<p class="hint">Porcentaje de territorios cubiertos en cada mes. El mes elegido aparece resaltado.</p><div class="mes-chart">${colMes}</div></section>`;

    const filaRot = x => {
        const tag = dispA && x.a === aMax ? ' <span class="tag eqs sat">Saturado</span>' : dispA && x.a === aMin ? ' <span class="tag eqs rez">Rezagado</span>' : '';
        return `<div class="rot-row"><span class="rot-n">${esc(terrLabel(x.t))}${x.t.prioritario ? ' ★' : ''}${tag}</span><b title="Veces cubierto en ${MESES[mes - 1]}">${x.m}</b><b title="Veces cubierto en ${anio}">${x.a}</b><div class="stat-bar"><i style="width:${aMax ? x.a / aMax * 100 : 0}%"></i></div></div>`;
    };
    const sec3 = `<section class="module-section"><div class="module-title">Equilibrio de rotación de territorios</div>`
        + (!filas.length ? '<p class="hint">Aún no hay territorios registrados.</p>'
            : `<div class="res-kpis">${kpi(`<span class="eq ${nvM[0]}">${nvM[1]}</span>`, `Mes (${MESES[mes - 1]})`, 'kpi-eq', `dispersión ${dispM} · ${repetM} repetido(s)`)}${kpi(`<span class="eq ${nvA[0]}">${nvA[1]}</span>`, `Año ${anio}`, 'kpi-eq', `máx ${aMax} · mín ${aMin} · dispersión ${dispA}`)}${kpi(pctA + '%', `Cubiertos en ${anio}`, pctA === 100 ? 'ok' : '', `${cubA} de ${totT}`)}</div>`
            + `<div class="cov-track" title="Cobertura anual de territorios"><i style="width:${pctA}%"></i></div>`
            + (satA.length ? `<p class="hint"><b>Más saturados (${aMax} veces):</b> ${lim(satA)}</p><p class="hint"><b>Más rezagados (${aMin} veces):</b> ${lim(rezA)}</p>` : '<p class="hint">La rotación del año está pareja: no hay territorios saturados ni rezagados.</p>')
            + `<div class="rot-tabla"><div class="rot-row rot-head"><span>Territorio</span><b>Mes</b><b>Año</b><span>Año (proporción)</span></div><div class="stats-scroll rot-scroll">${filas.map(filaRot).join('')}</div></div>`)
        + `</section>`;
    cont.innerHTML = sec1 + sec2 + sec3;
}

// --- Excepciones / eventos especiales ---
function abrirExcepciones() {
    const a = anioSel(), m = parseInt(document.getElementById('mesAgenda').value, 10), ult = new Date(a, m, 0).getDate();
    ['exDesde', 'exHasta'].forEach(id => { const e = document.getElementById(id); e.min = `${a}-${pad(m)}-01`; e.max = `${a}-${pad(m)}-${pad(ult)}`; e.value = ''; });
    document.getElementById('exMotivo').value = '';
    document.getElementById('exTitulo').textContent = `Excepciones de ${nombreMesSel()} ${a}`;
    renderExcepciones(); openModal('modalExcepciones');
}
function renderExcepciones() {
    const L = excepciones[agendaKey()] || [];
    document.getElementById('listaExcepciones').innerHTML = L.map((e, i) => `<div class="group-card"><div><strong>${esc(e.motivo)}</strong><br><small>${e.desde === e.hasta ? 'Día ' + e.desde : `Del ${e.desde} al ${e.hasta}`}</small></div><button type="button" class="btn-danger-outline" onclick="borrarExcepcion(${i})">X</button></div>`).join('') || '<p class="hint">Sin excepciones este mes.</p>';
}
function agregarExcepcion() { if (_bloqueadoLector()) return;
    const d = document.getElementById('exDesde').value, h = document.getElementById('exHasta').value || d, motivo = document.getElementById('exMotivo').value.trim();
    if (!d || !motivo) return mostrarToast('Indica la fecha y el motivo', 'error');
    let a = +d.slice(8), b = +h.slice(8); if (a > b) [a, b] = [b, a];
    const key = agendaKey(); (excepciones[key] = excepciones[key] || []).push({ desde: a, hasta: b, motivo });
    const R = agendasMaestras[key];
    if (R) {
        const anio = anioSel(), mes = +document.getElementById('mesAgenda').value, nuevas = R.filter(f => f.diaMes < a || f.diaMes > b);
        for (let i = a; i <= b; i++) nuevas.push(filaEvento(anio, mes, i, motivo));
        agendasMaestras[key] = nuevas.sort((x, y) => x.diaMes - y.diaMes);
    }
    guardarLocal(); registrarActividad('Excepción', `${motivo} (días ${a}-${b}) — ${nombreMesSel()}`);
    renderExcepciones(); cargarAgendaDelMes(); document.getElementById('exMotivo').value = '';
    mostrarToast('Excepción agregada');
}
function borrarExcepcion(i) { if (_bloqueadoLector()) return;
    excepciones[agendaKey()].splice(i, 1); guardarLocal(); renderExcepciones();
    mostrarToast('Excepción eliminada. Genera de nuevo la agenda para restaurar esos días.');
}

// --- Resumen semanal para WhatsApp ---
function abrirResumen() {
    const R = agendasMaestras[agendaKey()];
    if (!R || !R.length) return mostrarToast('Primero genera una agenda para este mes.', 'error');
    const c = document.getElementById('opcionesResumen'); c.innerHTML = '';
    rangosSemana(Math.max(...R.map(d => d.diaMes))).forEach(r => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'download-option';
        b.innerHTML = `<span>${r.nombre}</span><small>Días ${r.desde} al ${r.hasta}</small>`; b.onclick = () => copiarResumen(r); c.appendChild(b);
    });
    openModal('modalResumen');
}
async function copiarResumen(r) {
    closeModal('modalResumen');
    let t = `*Agenda de Predicación — ${nombreMesSel()} ${anioSel()}*\n_${r.nombre} (días ${r.desde} al ${r.hasta})_\n`, ult = null;
    agendasMaestras[agendaKey()].filter(f => f.diaMes >= r.desde && f.diaMes <= r.hasta).forEach(f => {
        if (ult !== null && ult !== f.diaMes) t += '\n';
        ult = f.diaMes;
        const dia = `${DIAS_LARGOS[f.diaSemana]} ${f.diaMes}`;
        if (f.evento) { t += `\n*${dia}:* ${f.motivo}`; return; }
        const m = /^(\d+)\.\s*(.*)$/.exec(f.territorio || ''), terr = m ? `Territorio ${m[1]} - ${m[2]}` : f.territorio;
        t += `\n*${dia} - ${f.hora.replace(/^0/, '')}:* ${f.conductor} — ${terr}${f.lugar ? ` (${f.lugar})` : ''}`;
    });
    if (await copiar(sinDatosContacto(t))) mostrarToast('Resumen copiado. ¡Pégalo en WhatsApp!'); else mostrarToast('No se pudo copiar el resumen', 'error');
}

// --- Hoy y mañana / Contactar ---
function filasDeFecha(d) {
    const k = `${d.getFullYear()}-${d.getMonth() + 1}`;
    if (!agendasMaestras[k] && historialAgendas[k]) agendasMaestras[k] = clonar(historialAgendas[k]);
    return (agendasMaestras[k] || []).map((f, i) => ({ f, i, k, d })).filter(x => !x.f.evento && x.f.diaMes === d.getDate());
}
const proximos2 = () => { const h = new Date(), m = new Date(); m.setDate(h.getDate() + 1); return [h, m]; };
function renderHoy() {
    const el = document.getElementById('cardHoy'); if (!el) return;
    const [h, m] = proximos2(), now = h.getHours() * 60 + h.getMinutes(), hoy = filasDeFecha(h).filter(x => estadoTurno(x.f, now) !== 'fin'), man = filasDeFecha(m);
    if (!hoy.length && !man.length) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    let prox = -1; hoy.forEach((x, j) => { if (prox < 0 && estadoTurno(x.f, now) === 'prox') prox = j; });
    const fila = (x, tag) => `<div class="hoy-row">${pillHora(x.f.hora)}<div><strong>${esc(x.f.conductor)}</strong>${tag}<br><small>${esc(x.f.territorio)} · ${esc(x.f.lugar)}${x.f.grupos ? ' · ' + esc(x.f.grupos) : ''}</small></div></div>`;
    const col = (t, L, esHoy) => `<div><div class="hoy-dia">${t}</div>${L.map((x, j) => fila(x, esHoy ? (estadoTurno(x.f, now) === 'en' ? ' <span class="tag en">Turno en curso</span>' : estadoTurno(x.f, now) === 'fin' ? ' <span class="tag">Finalizado</span>' : j === prox ? ' <span class="tag prox">Próxima salida</span>' : '') : '')).join('') || '<small class="hint">Sin salidas</small>'}</div>`;
    el.innerHTML = `<div class="module-title" style="margin-bottom:14px">Hoy y mañana</div><div class="hoy-grid">${col('Hoy · ' + DIAS_LARGOS[DIAS[h.getDay()]] + ' ' + h.getDate(), hoy, true)}${col('Mañana · ' + DIAS_LARGOS[DIAS[m.getDay()]] + ' ' + m.getDate(), man, false)}</div>`;
}
function actualizarBadge() {
    const n = itemsContactos().filter(x => asignado(x.f) && x.f.confirmado !== true).length;   // pendiente = asignado y sin ✓✓
    const b = document.getElementById('badgeAgenda'); if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
}
// === Contactar Pro: estados, filtros, alertas por cercanía, cola rápida y validación de teléfono ===
let filtroContacto = 'todos', colaLista = [], colaPos = 0, colaAbierta = false;
const asignado = f => !esVacio(f.conductor, 'Sin Asignar');
// 'avisar' = aún no avisado · 'confirmar' = avisado, falta confirmación · 'confirmado' · 'sin' = turno sin conductor
const estadoAviso = f => !asignado(f) ? 'sin' : f.confirmado ? 'confirmado' : f.avisado ? 'confirmar' : 'avisar';
const conductorDe = f => conductores.find(c => norm(nomC(c)) === norm(f.conductor)) || null;
const RX_E164 = /^\+[1-9]\d{9,14}$/;   // formato internacional: + código de país + número (10 a 15 dígitos)
function telefonoValido(c) { if (!c) return false; const t = limpiarTelefono(c.telefono).replace(/\s/g, ''); return RX_E164.test(t) && (!t.startsWith('+58') || t.length === 13); }
const inicioMs = x => new Date(x.d.getFullYear(), x.d.getMonth(), x.d.getDate(), 0, ventanaTurno(x.f.diaSemana, x.f.hora).ini).getTime();
// Hoy: solo turnos en curso o por empezar (se excluyen los finalizados). Mañana: todos.
function itemsContactos() {
    const [h, m] = proximos2(), ahoraMin = h.getHours() * 60 + h.getMinutes();
    return filasDeFecha(h).filter(x => estadoTurno(x.f, ahoraMin) !== 'fin').concat(filasDeFecha(m));
}
function fmtMin(m) { const N = '\u00A0'; if (m < 60) return `${Math.max(1, m)}${N}min`; const h = Math.floor(m / 60), r = m % 60; return `${h}${N}h${r ? ` ${r}${N}min` : ''}`; }
// Alerta de un turno sin confirmar: 'urgente' (empieza en 3 h o menos), 'curso' (ya empezó), 'cercano' (empieza en 14 h o menos)
function alertaTurno(x) {
    if (!asignado(x.f) || x.f.confirmado) return null;
    const v = ventanaTurno(x.f.diaSemana, x.f.hora), m = Math.round((inicioMs(x) - Date.now()) / 60000);
    if (m + (v.fin - v.ini) <= 0) return null;                    // ya terminó
    if (m <= 0) return { cls: 'curso', txt: 'En curso sin confirmar' };
    if (m <= 180) return { cls: 'urgente', txt: `Empieza en ${fmtMin(m)} · sin confirmar` };
    if (m <= 840) return { cls: 'cercano', txt: `Sin confirmar · empieza en ${fmtMin(m)}` };
    return null;
}
function setFiltroContacto(f) { filtroContacto = f; renderContactos(); }
function renderContactos(silencioso) {
    const cont = document.getElementById('listaContactos'); if (!cont) return;
    const lista = itemsContactos(), cuenta = { todos: lista.length, pend: 0, avisar: 0, confirmar: 0, confirmados: 0 };
    lista.forEach(x => { const e = estadoAviso(x.f); if (e === 'avisar') cuenta.avisar++; else if (e === 'confirmar') cuenta.confirmar++; else if (e === 'confirmado') cuenta.confirmados++; });
    cuenta.pend = cuenta.avisar + cuenta.confirmar;
    const chips = document.getElementById('chipsContactos');
    if (chips) chips.innerHTML = [['todos', 'Todos'], ['pend', 'Pendientes'], ['avisar', 'Por avisar'], ['confirmar', 'Por confirmar'], ['confirmados', 'Confirmados']]
        .map(([v, t]) => `<button type="button" class="chip-button${filtroContacto === v ? ' active' : ''}" onclick="setFiltroContacto('${v}')">${t} (${cuenta[v]})</button>`).join('');
    const btnCola = document.getElementById('btnColaAvisos'), pend = cuenta.avisar + cuenta.confirmar;
    if (btnCola) { btnCola.disabled = !pend && !colaAbierta; btnCola.innerHTML = `${IC.play}<span>Cola de avisos (${pend})</span>`; btnCola.title = pend ? 'Avanza uno a uno por los avisos y confirmaciones pendientes' : 'No hay avisos ni confirmaciones pendientes'; }
    cont.classList.toggle('quiet', !!silencioso);
    if (!lista.length) { cont.innerHTML = '<p class="hint">No hay turnos en curso ni próximos para hoy y mañana.</p>'; renderCola(); return; }
    const vis = lista.filter(x => filtroContacto === 'todos' || (filtroContacto === 'pend' && ['avisar', 'confirmar'].includes(estadoAviso(x.f))) || (filtroContacto === 'avisar' && estadoAviso(x.f) === 'avisar') || (filtroContacto === 'confirmar' && estadoAviso(x.f) === 'confirmar') || (filtroContacto === 'confirmados' && estadoAviso(x.f) === 'confirmado'));
    if (!vis.length) { cont.innerHTML = '<p class="hint">No hay asignaciones con este estado.</p>'; renderCola(); return; }
    cont.innerHTML = bannerUrgentes(lista) + ordenarUrgentes(vis).map(x => {
        const f = x.f, c = conductorDe(f), al = alertaTurno(x), telOk = telefonoValido(c);
        const chk = f.confirmado ? `<span class="chk ok" title="Confirmado">${IC.checkAll}</span>` : (f.avisado ? `<span class="chk" title="Avisado">${IC.check}</span>` : '');
        const tag = al ? ` <span class="tag alerta ${al.cls}">${esc(al.txt)}</span>` : '';
        const estA = estadoAviso(f), pendTag = estA === 'avisar' ? ' <span class="tag">Por avisar</span>' : estA === 'confirmar' ? ' <span class="tag">Por confirmar</span>' : '';
        const sinTel = asignado(f) && !telOk ? ` <span class="tag sin-tel" title="Edita al conductor para agregar un teléfono válido">${c ? 'Sin teléfono válido' : 'No registrado'}</span>` : '';
        // Misma tarjeta que Contactar de Exhibidores: cabecera (fecha · hora · lugar) + fila con nombre, estados y acciones
        const clases = ['exh-card', 'contacto-g', al ? 'al-' + al.cls : '', asignado(f) && !f.confirmado ? 'sinconf' : ''].filter(Boolean).join(' ');
        return `<div class="${clases}"><div class="exh-card-head"><b>${esc(DIAS_LARGOS[f.diaSemana])} ${f.diaMes} de ${esc(MESES[x.d.getMonth()].toLowerCase())}</b><small>${esc(f.hora)}</small><small>Lugar: ${esc(f.lugar || 'Por definir')}</small>${f.territorio ? `<small>Territorio: ${esc(f.territorio)}</small>` : ''}</div>
            <div class="exh-card-p"><strong>${esc(f.conductor)}</strong> ${chk}${pendTag}${tag}${sinTel}${f.grupos ? `<br><span class="contacto-g-sub">${esc(f.grupos)}</span>` : ''}
                <div class="contact-actions">
                    <button type="button" class="btn-whatsapp" onclick="abrirWhatsAppTurno('${x.k}',${x.i})">WhatsApp</button>
                    <button type="button" class="btn-outline mini" onclick="copiarAvisoTurno('${x.k}',${x.i})">Copiar</button>
                    <button type="button" class="btn-outline mini conf${f.confirmado ? ' on' : ''}" onclick="toggleConfirmado('${x.k}',${x.i})">${f.confirmado ? IC.checkAll : IC.check}<span>Confirmado</span></button>
                    <button type="button" class="btn-outline mini" onclick="abrirSelectorConductor('${x.k}',${x.i},'libres')">Sustituir</button>
                </div></div></div>`;
    }).join('');
    renderCola();
}
// WhatsApp solo se abre si el conductor existe y tiene un teléfono válido
function abrirWhatsAppTurno(k, idx) {
    const R = agendasMaestras[k], f = R && R[idx]; if (!f) return false;
    const c = conductorDe(f);
    if (!c) { mostrarToast(`${asignado(f) ? f.conductor : 'Este turno'} no tiene un conductor registrado; no se puede abrir WhatsApp.`, 'error'); return false; }
    if (!telefonoValido(c)) { mostrarToast(`${nomC(c)} no tiene un teléfono válido guardado. Edítalo en Conductores con formato internacional (ej. +58 414 1234567) para poder abrir WhatsApp.`, 'error'); return false; }
    window.open(waUrl(limpiarTelefono(c.telefono).replace('+', ''), mensajeWA(c, f)), '_blank', 'noopener');
    marcarComoAvisado(k, idx); return true;
}
async function copiarAvisoTurno(k, idx) {
    const R = agendasMaestras[k], f = R && R[idx]; if (!f) return;
    if (await copiar(mensajeWA(conductorDe(f), f))) { mostrarToast('Mensaje copiado al portapapeles'); marcarComoAvisado(k, idx); } else mostrarToast('No se pudo copiar el texto', 'error');
}
// --- Cola rápida de avisos pendientes ---
function iniciarColaAvisos() {
    colaLista = itemsContactos().filter(x => asignado(x.f) && !x.f.confirmado)
        .sort((a, b) => (a.f.avisado ? 1 : 0) - (b.f.avisado ? 1 : 0) || inicioMs(a) - inicioMs(b)).map(x => ({ k: x.k, i: x.i }));
    if (!colaLista.length) return mostrarToast('No hay avisos ni confirmaciones pendientes', 'error');
    colaPos = 0; colaAbierta = true; renderCola();
    const b = document.getElementById('colaAvisos'); if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function cerrarCola() { colaAbierta = false; colaLista = []; colaPos = 0; renderContactos(); }
function colaSiguiente() { colaPos = Math.min(colaLista.length, colaPos + 1); renderCola(); }
function colaAnterior() { colaPos = Math.max(0, colaPos - 1); renderCola(); }
function confirmarCola() {
    const it = colaLista[colaPos], R = it && agendasMaestras[it.k], f = R && R[it.i]; if (!f) return;
    f.confirmado = true; f.avisado = true; sincHist(it.k, f); guardarLocal(); colaPos++; refrescarEstados();
}
function renderCola() {
    const box = document.getElementById('colaAvisos'); if (!box) return;
    if (!colaAbierta) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    const total = colaLista.length;
    if (colaPos >= total) {
        box.innerHTML = `<div class="cola-fin"><b>${IC.checkAll} Cola completada</b><p class="hint">Revisaste todos los avisos pendientes. Los que siguen sin confirmar quedan en el filtro "Por confirmar".</p><div class="toolbar"><button type="button" class="btn-outline" onclick="colaAnterior()">${IC.undo}<span>Volver</span></button><button type="button" class="btn-primary" onclick="cerrarCola()">Cerrar</button></div></div>`; return;
    }
    const it = colaLista[colaPos], R = agendasMaestras[it.k], f = R && R[it.i];
    if (!f || f.evento || !asignado(f)) { colaLista.splice(colaPos, 1); renderCola(); return; }
    const c = conductorDe(f), telOk = telefonoValido(c), est = estadoAviso(f);
    box.innerHTML = `<div class="cola-cab"><span class="tag prox">${colaPos + 1} de ${total}</span><span class="hint" style="margin:0">${est === 'avisar' ? 'Por avisar' : 'Avisado, falta confirmar'}</span></div>
            <div class="cola-prog"><i style="width:${(colaPos / total) * 100}%"></i></div>
            <div class="cola-cuerpo"><strong>${esc(f.conductor)}</strong>${telOk ? '' : ' <span class="tag sin-tel">' + (c ? 'Sin teléfono válido' : 'No registrado') + '</span>'}<br><small>${DIAS_LARGOS[f.diaSemana]} ${f.diaMes} · ${esc(f.hora)} · ${esc(f.territorio)} · ${esc(f.lugar)}</small></div>
            <div class="toolbar" style="margin:12px 0 0">
                <button type="button" class="btn-outline mini" onclick="colaAnterior()" ${colaPos === 0 ? 'disabled' : ''}>${IC.undo}<span>Anterior</span></button>
                <button type="button" class="btn-outline mini" onclick="copiarAvisoTurno('${it.k}',${it.i})">Copiar</button>
                <button type="button" class="btn-whatsapp" onclick="abrirWhatsAppTurno('${it.k}',${it.i})">WhatsApp</button>
                <button type="button" class="btn-outline mini conf" onclick="confirmarCola()">${IC.checkAll}<span>Confirmado y siguiente</span></button>
                <button type="button" class="btn-outline mini" onclick="colaSiguiente()">${IC.redo}<span>Omitir</span></button>
                <button type="button" class="btn-outline mini del" onclick="cerrarCola()">${IC.x}<span>Cerrar</span></button>
            </div>`;
}
// Actualización periódica para que las alertas de cercanía sigan al reloj (sin repetir animaciones)
if (!window.__vdmTickContactos) {
    window.__vdmTickContactos = setInterval(() => { if (_sesionActiva && _appIniciada && !document.hidden) { renderContactos(true); renderHoy(); if (modoApp === 'exhibidores') { exhRenderHoy(); exhRenderContactos(); } } }, 60000);
}
async function copiarTextoNotificacion(m) {
    if (await copiar(decodeURIComponent(m))) mostrarToast('Mensaje copiado al portapapeles'); else mostrarToast('No se pudo copiar el texto', 'error');
}
function sincHist(k, f) { const H = historialAgendas[k]; if (H) { const h = H.find(x => x.diaMes === f.diaMes && x.hora === f.hora); if (h) { h.avisado = f.avisado; h.confirmado = f.confirmado; } } }
function refrescarEstados() { renderContactos(); renderHoy(); actualizarBadge(); }  // renderContactos también redibuja la cola
function marcarComoAvisado(k, idx) { if (_bloqueadoLector()) return;
    const R = agendasMaestras[k]; if (!R || !R[idx]) return; R[idx].avisado = true; sincHist(k, R[idx]); guardarLocal(); setTimeout(refrescarEstados, 0);
}
function toggleConfirmado(k, idx) { if (_bloqueadoLector()) return;
    const R = agendasMaestras[k]; if (!R || !R[idx]) return; const f = R[idx]; f.confirmado = !f.confirmado; if (f.confirmado) f.avisado = true;
    sincHist(k, f); guardarLocal(); refrescarEstados();
}

// --- Historial guardado ---
async function guardarEnHistorial() {
    if (_bloqueadoLector()) return;
    const key = agendaKey();
    if (!agendasMaestras[key]) return mostrarToast('Primero genera una agenda para este mes.', 'error');
    historialAgendas[key] = clonar(agendasMaestras[key]); const ok = guardarLocal(); renderHistorial(); actualizarEstadoHistorial();
    registrarActividad('Guardar historial', `Agenda de ${nombreMesSel()} ${anioSel()}`);
    if (!ok) return mostrarToast('No se guardó: los datos no pasaron la validación.', 'error');
    mostrarToast(await esperarSincronizacion() ? 'Instantánea del mes guardada en el historial y sincronizada con la nube' : 'Guardada en el historial local; pendiente de sincronizar con la nube');
}
function renderHistorial() {
    const cont = document.getElementById('listaHistorial'); if (!cont) return;
    cont.innerHTML = Object.keys(historialAgendas).filter(k => /^\d{4}-\d{1,2}$/.test(k)).sort((a, b) => { const [x, y] = a.split('-').map(Number), [p, q] = b.split('-').map(Number); return x - p || y - q; })
        .map(k => { const [a, m] = k.split('-').map(Number); return `<div class="group-card"><span>Agenda de ${MESES[m - 1]} ${a}</span> <div><button class="btn-edit-outline" onclick="cargarDeHistorial('${k}')">Cargar</button><button class="btn-danger-outline" onclick="borrarDeHistorial('${k}')">Borrar</button></div></div>`; }).join('');
}
function cargarDeHistorial(k) { if (_bloqueadoLector()) return;
    const [a, m] = k.split('-').map(Number); asegurarAnio(a);
    document.getElementById('anioAgenda').value = a; document.getElementById('mesAgenda').value = m;
    agendasMaestras[k] = clonar(historialAgendas[k]); guardarLocal(); cargarAgendaDelMes(); closeModal('modalHistorial');
}
async function borrarDeHistorial(k) { if (_bloqueadoLector()) return;
    const hi = impactoAgenda(historialAgendas[k]), abierta = !!agendasMaestras[k];
    if (await confirmar(`¿Borrar la copia del historial (${k})?\n\n✖ Se eliminará la instantánea guardada: ${hi.total} turno(s), ${hi.fij} con candado.\n✔ ${abierta ? 'Se conservará la agenda de trabajo de ese mes (' + impactoAgenda(agendasMaestras[k]).fij + ' turno(s) con candado).' : 'Ese mes no tiene agenda de trabajo abierta: dejará de verse en la Agenda.'}\n\nNo se puede deshacer.`, 'Borrar')) { delete historialAgendas[k]; guardarLocal(); renderHistorial(); cargarAgendaDelMes(); }
}
function cargarAgendaDelMes() {
    filtroAg = { c: '', t: '', q: '' };
    const key = agendaKey();
    if (!agendasMaestras[key] && historialAgendas[key]) agendasMaestras[key] = clonar(historialAgendas[key]);
    if (agendasMaestras[key]) { renderAgenda(agendasMaestras[key], nombreMesSel()); document.getElementById('resultadoAgenda').classList.remove('hidden'); }
    else { document.getElementById('resultadoAgenda').classList.add('hidden'); document.getElementById('tablaCuerpoAgenda').innerHTML = ''; }
    refrescarDerivados();
}

// Limpia el clon de html2canvas / PDF: la salida siempre sale limpia
function limpiarClon(a) {
    a.querySelectorAll('select').forEach(x => x.replaceWith(x.options[x.selectedIndex].text));
    a.querySelectorAll('.no-export').forEach(e => e.remove());
    a.querySelectorAll('.sin-asignar,.edit-select,.warn-cond,.warn-lugar').forEach(e => e.classList.remove('sin-asignar', 'edit-select', 'warn-cond', 'warn-lugar'));
    a.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
    purgarContactoDOM(a);
}

// === INICIALIZACIÓN DE DATOS ===
function leerLocal() {
    if (!_sesionActiva) return {};
    try { return JSON.parse(localStorage.getItem('vdm_data') || '{}') || {}; } catch (e) { return {}; }
}
async function initApp(desdeNube = true) {
    if (!_sesionActiva) return;
    let local = leerLocal(); _verBase = Number(local.version) || 0;
    // Si quedaron cambios locales sin subir, tienen prioridad sobre la nube (y se vuelven a enviar)
    let pendiente = false; try { pendiente = localStorage.getItem('vdm_sync_pendiente') === '1'; } catch (e) {}
    if (desdeNube && supabaseClient) {
        if (pendiente && Object.keys(local).length) { sincronizarNube(); }
        else {
            const nube = await leerNube();
            if (!_sesionActiva) return;
            if (nube) { local = nube; _verBase = Number(nube.version) || 0; try { localStorage.setItem('vdm_data', JSON.stringify(nube)); } catch (e) {} }
        }
    }

    local = sanearDatos(local || {});
    conductores = local.conductores || [];
    territorios = local.territorios || [];
    agendasMaestras = migrarClaves(local.borradores); historialAgendas = migrarClaves(local.historial); excepciones = migrarClaves(local.excepciones); poblarAnios();
    historialActividad = local.actividad || []; exh = exhNormalizar(local.exhibidores);
    config = Object.assign(defConfig(), local.config || {}); config.reuniones = migrarReuniones(config.reuniones); lectura = !puedeEditar() || localStorage.getItem('vdm_lock') === '1';
    conductores.forEach(c => { const t = limpiarTelefono(c.telefono); if (t) c.telefono = t; });
    if (migrarGruposLegacy(local.grupos)) guardarLocal();

    renderListaConductores(); 
    renderListaTerritorios(); 
    renderHistorial(); 
    renderActividad();
    cargarAgendaDelMes(); 
    
    let lastTab = localStorage.getItem('vdm_active_tab') || 'tab-agenda';
    if (!document.getElementById(lastTab)) lastTab = 'tab-agenda';
    adoptarPreferenciasNube(); aplicarConfigUI();
    switchTab(lastTab);
    exhIniciar();
    actualizarDatalists();
    updateUndoUI(); actualizarSyncUI(); aplicarRolUI(); _rolListo = true;
    if (!window._onbMostrado) { window._onbMostrado = true; setTimeout(mostrarOnboardingSiCorresponde, 400); }
}

function guardarLocal() {
    if (!_sesionActiva) return false;
    if (!puedeEditar()) { if (_rolListo) avisoLector(); return false; }
    const payload = payloadCompleto(), v = validarEstadoApp(payload);
    if (!v.ok) { alertaEstadoInvalido(v.errores); return false; }
    try { localStorage.setItem('vdm_data', JSON.stringify(payload)); } catch (e) { mostrarToast('No se pudo guardar en este dispositivo (almacenamiento lleno).', 'error'); return false; }
    programarSync();   // la subida a la nube se agrupa (debounce) para evitar tirones al editar rápido
    return true;
}

// --- Respaldo completo (JSON) ---
function descargarRespaldo() {
    const p = payloadCompleto(), v = validarEstadoApp(p); if (!v.ok) return alertaEstadoInvalido(v.errores);
    const d = new Date(), sello = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'territorios-vdm', formato: 1, exportado: d.toISOString(), datos: p }, null, 2)], { type: 'application/json' }));
    a.download = `Respaldo-Territorios-${sello}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    if (puedeEditar()) registrarActividad('Exportar', 'Respaldo completo (JSON)');
    mostrarToast('Respaldo descargado');
}
async function restaurarRespaldo(inp) {
    const f = inp.files && inp.files[0]; inp.value = ''; if (!f) return;
    if (_bloqueadoLector()) return;
    if (f.size > 15 * 1024 * 1024) return avisar('El archivo es demasiado grande para ser un respaldo válido.');
    let obj; try { obj = JSON.parse(await f.text()); } catch (e) { return avisar('El archivo no es un JSON válido. No se restauró nada.'); }
    const datos = (obj && obj.app === 'territorios-vdm' && obj.datos) ? obj.datos : obj, v = validarEstadoApp(datos);
    if (!v.ok) return avisar('El respaldo está incompleto o dañado y no se restauró nada. Detalle: ' + v.errores.slice(0, 4).join(' · '));
    const fijAct = contarFijados(agendasMaestras), fijRes = contarFijados(datos.borradores);
    if (!(await confirmar(`Restaurar este respaldo reemplazará TODOS los datos actuales, también en la nube.\n\n✔ Se conservarán (los del respaldo): ${fijRes} turno(s) fijado(s) con candado en ${Object.keys(datos.borradores || {}).length} agenda(s).\n✖ Se reemplazarán: ${Object.keys(agendasMaestras).length} agenda(s) actuales con ${fijAct} turno(s) fijado(s), ${conductores.length} conductor(es), ${territorios.length} territorio(s) y el historial.\n\nTe recomendamos descargar un respaldo actual antes de continuar.`, 'Restaurar'))) return;
    const nube = await leerNube(); if (nube) _verBase = Number(nube.version) || 0;
    aplicarPayload(datos); mostrarToast('Respaldo restaurado');
}

// Modo lectura por rol: bloquea controles visibles (las funciones de escritura tienen además su propia guarda)
function aplicarRolUI() {
    document.body.classList.toggle('rol-lector', !puedeEditar());
    if (puedeEditar()) return;
    if (!document.getElementById('bannerLector')) {
        const b = document.createElement('div'); b.id = 'bannerLector'; b.setAttribute('role', 'status');
        b.style.cssText = 'background:#fef3c7;color:#78350f;text-align:center;padding:6px 10px;font-size:.85rem;font-weight:600';
        b.textContent = 'Modo lectura: tu cuenta no tiene permisos de edición.';
        const c = document.getElementById('app-content'); c.insertBefore(b, c.firstChild);
    }
    const RX = /generarNuevaAgenda|exhGenerar|guardarEnHistorial|openModalConductor|openModalTerritorio|exhAbrirPart|exhAbrirLug|eliminar|borrar|deshacer|rehacer|restaurar|inpRespaldo|agregarExcepcion|exhGuardar|exhCfg|restablecer|toggleLectura|cargarDeHistorial|exhCargarHist/;
    document.querySelectorAll('[onclick]').forEach(el => { if (RX.test(el.getAttribute('onclick'))) { el.disabled = true; el.setAttribute('aria-disabled', 'true'); el.style.opacity = '.5'; el.style.pointerEvents = 'none'; } });
}

function actualizarSyncUI() {
    const el = document.getElementById('syncStatus'); if (!el) return;
    const est = estadoSync();
    if (!est) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    // Tres estados reales: Sincronizado · Guardando... · Sin conexión (guardado localmente)
    const M = {
        ok: ['Sincronizado', '', IC.nubeOk, 'Todos los cambios están guardados en la nube'],
        pending: ['Guardando...', '', IC.nubeSube, 'Subiendo los cambios a la nube'],
        offline: ['Sin conexión', ' (guardado localmente)', IC.nubeOff, 'Sin conexión: tus cambios están guardados en este dispositivo y se subirán al reconectar']
    }[est];
    if (el.dataset.estado !== est || !el.querySelector('.sync-ico .ico')) { el.dataset.estado = est; el.querySelector('.sync-ico').innerHTML = M[2]; }
    const t = el.querySelector('.sync-txt'), html = M[0] + (M[1] ? `<span class="sync-sub">${M[1]}</span>` : '');
    if (t.innerHTML !== html) t.innerHTML = html;
    const b = el.querySelector('.sync-retry'); if (b) b.classList.toggle('hidden', est !== 'offline');
    el.title = M[3];
}

function registrarActividad(accion, detalle) {
    const ahora = new Date();
    const fechaHora = ahora.toLocaleDateString('es-VE', { 
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
    historialActividad.unshift({ accion, detalle, fecha: fechaHora });
    if (historialActividad.length > 100) historialActividad.pop();
    guardarLocal();
    renderActividad();
}

// === TABS ===
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    const selectedBtn = Array.from(document.querySelectorAll('.tab-btn'))
        .find(btn => btn.getAttribute('onclick').includes(tabId));
    
    if (selectedBtn) selectedBtn.classList.add('active');
    document.getElementById(tabId).classList.add('active');
    try { localStorage.setItem(EXH_TABS.includes(tabId) ? 'vdm_active_tab_exh' : 'vdm_active_tab', tabId); } catch (e) {}
    if (tabId === 'tab-resumen') { poblarResumenSelectores(!resumenListo); renderResumen(); }
    exhOnTab(tabId);
}

function toggleVisibility(id) {
    const el = document.getElementById(id);
    el.classList.toggle('hidden');
}

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { flushDeb(); document.getElementById(id).style.display = 'none'; }

// === CRUD CONDUCTORES ===
function openModalConductor() { 
    document.getElementById('formConductor').reset(); 
    document.getElementById('editIndexConductor').value = ""; 
    document.getElementById('grupoSugerido').classList.add('hidden'); 
    ausTmp = []; extraTmp = []; renderAusTmp(); vincReset('C');
    openModal('modalConductor'); 
}
// === Parte 2: ausencias múltiples y fechas extra en el modal de Conductor ===
function renderAusTmp() {
    const fr = a => esc(fCorta(a.desde)) + (a.hasta !== a.desde ? ' – ' + esc(fCorta(a.hasta)) : '');
    document.getElementById('cAusLista').innerHTML = ausTmp.map((a, i) => `<div class="aus-item"><span>${fr(a)}${a.motivo ? ' · ' + esc(a.motivo) : ''}</span><button type="button" class="btn-danger-outline icon-btn" title="Quitar" aria-label="Quitar ausencia" onclick="quitarAusenciaTmp(${i})">${IC.x}</button></div>`).join('') || '<span class="hint">Sin ausencias registradas.</span>';
    document.getElementById('cExtraLista').innerHTML = extraTmp.map((d, i) => `<div class="aus-item"><span>${esc(fCorta(d))}</span><button type="button" class="btn-danger-outline icon-btn" title="Quitar" aria-label="Quitar fecha" onclick="quitarExtraTmp(${i})">${IC.x}</button></div>`).join('') || '<span class="hint">Sin fechas extra.</span>';
}
function agregarAusenciaTmp(silencioso) {
    const d = document.getElementById('cAusDesde').value;
    if (!d) { if (silencioso !== true) mostrarToast('Elige la fecha "Desde"', 'error'); return false; }
    const a = normAus({ desde: d, hasta: document.getElementById('cAusHasta').value || d, motivo: document.getElementById('cAusMotivo').value });
    if (a && !ausTmp.some(x => x.desde === a.desde && x.hasta === a.hasta && x.motivo === a.motivo)) ausTmp.push(a);
    ausTmp.sort((x, y) => x.desde.localeCompare(y.desde));
    ['cAusDesde', 'cAusHasta', 'cAusMotivo'].forEach(id => { document.getElementById(id).value = ''; });
    renderAusTmp(); return true;
}
function quitarAusenciaTmp(i) { ausTmp.splice(i, 1); renderAusTmp(); }
function agregarExtraTmp(silencioso) {
    const v = document.getElementById('cExtraFecha').value;
    if (!v || !ISO_RE.test(v)) { if (silencioso !== true) mostrarToast('Elige una fecha', 'error'); return false; }
    if (!extraTmp.includes(v)) extraTmp.push(v); extraTmp.sort();
    document.getElementById('cExtraFecha').value = ''; renderAusTmp(); return true;
}
function quitarExtraTmp(i) { extraTmp.splice(i, 1); renderAusTmp(); }

document.getElementById('formConductor').addEventListener('submit', async (e) => {
    e.preventDefault(); if (!antiDoble(e)) return;
    const index = document.getElementById('editIndexConductor').value;
    if (document.getElementById('cAusDesde').value) agregarAusenciaTmp(true);      // lo que quedó escrito sin pulsar "Agregar" no se pierde
    if (document.getElementById('cExtraFecha').value) agregarExtraTmp(true);
    const disponibilidadActualizada = [];
    document.querySelectorAll('#disponibilidadSemanal .day-row').forEach(row => {
        const dayCheck = row.querySelector('.day-check');
        const timeInputs = Array.from(row.querySelectorAll('.time-options input'));
        let marcados = timeInputs.filter(t => t.checked).map(t => t.value);
        // Día marcado sin AM/PM => disponible en todos los bloques de ese día
        if (dayCheck && dayCheck.checked && marcados.length === 0) marcados = timeInputs.map(t => t.value);
        if (marcados.length > 0) {
            disponibilidadActualizada.push(dayCheck.value);
            marcados.forEach(v => disponibilidadActualizada.push(v));
        }
    });

    const c = {
        nombre: capitalizar(document.getElementById('cNombre').value), 
        apellido: capitalizar(document.getElementById('cApellido').value),
        telefono: limpiarTelefono(document.getElementById('cTelefono').value),
        estado: document.getElementById('cEstado').value, rol: document.getElementById('cRol').value, genero: document.getElementById('cGenero').value, 
        esAnciano: document.getElementById('cEsAnciano').value === 'si' || document.getElementById('cRol').value === 'anciano',
        grupo: document.getElementById('cGrupoAsignado').value,
        telegram: document.getElementById('cTelegram').checked,
        disponibilidadDias: disponibilidadActualizada, 
        fechaDisponible: document.getElementById('cFechaDisponible').value, 
        fechaNoDisponible: document.getElementById('cFechaNoDisponible').value,
        ausencias: clonar(ausTmp), fechasExtraDisp: extraTmp.slice()
    };
    // Compatibilidad hacia atrás: con un solo día, fechaNoDisponible / fechaDisponible quedan sincronizadas
    if (!c.fechaNoDisponible && ausTmp.length === 1 && ausTmp[0].desde === ausTmp[0].hasta) c.fechaNoDisponible = ausTmp[0].desde;
    if (!c.fechaDisponible && extraTmp.length === 1) c.fechaDisponible = extraTmp[0];

    if (!validarDatosConductor(c, index)) return;
    const vinc = await vincAlGuardar('C', c, index === "" ? null : conductores[index]);
    if (index === "") {
        conductores.push(c);
        registrarActividad('Agregar', `Conductor: ${c.nombre} ${c.apellido}`);
    } else {
        const anterior = `${conductores[index].nombre} ${conductores[index].apellido}`;
        conductores[index] = c;
        registrarActividad('Editar', `Conductor: ${anterior} → ${c.nombre} ${c.apellido}`);
    }
    if (vinc.otro) { vincSincronizar('C', c, vinc.otro); exhReg('Editar', `Sincronizado desde Grupos: ${exhNom(vinc.otro)}`); exhRenderPart(); exhRefrescarChoques(); }
    guardarLocal(); renderListaConductores(); actualizarDatalists(); closeModal('modalConductor');
});

// Sincroniza el chip del día con sus bloques AM/PM
document.querySelectorAll('#disponibilidadSemanal .day-row').forEach(row => {
    const day = row.querySelector('.day-check');
    const times = Array.from(row.querySelectorAll('.time-options input'));
    day.addEventListener('change', () => { times.forEach(t => t.checked = day.checked); });
    times.forEach(t => t.addEventListener('change', () => { day.checked = times.some(x => x.checked); }));
});

function editarConductor(i) {
    const c = conductores[i]; 
    document.getElementById('editIndexConductor').value = i;
    document.getElementById('cNombre').value = c.nombre; document.getElementById('cApellido').value = c.apellido; document.getElementById('cTelefono').value = c.telefono;
    document.getElementById('cEsAnciano').value = c.esAnciano ? 'si' : 'no'; document.getElementById('cGrupoAsignado').value = c.grupo || "1";
    document.getElementById('grupoSugerido').classList.toggle('hidden', !c.esAnciano);
    document.getElementById('cEstado').value = c.estado || 'activo'; document.getElementById('cRol').value = c.rol || (c.esAnciano ? 'anciano' : ''); document.getElementById('cGenero').value = c.genero || '';
    document.querySelectorAll('#disponibilidadSemanal input[type="checkbox"]').forEach(cb => {
        cb.checked = (c.disponibilidadDias || []).includes(cb.value);
    });
    document.getElementById('cTelegram').checked = !!c.telegram;
    ausTmp = (c.ausencias || []).map(normAus).filter(Boolean); extraTmp = (c.fechasExtraDisp || []).filter(d => ISO_RE.test(d));
    const fd = c.fechaDisponible || '', fnd = c.fechaNoDisponible || '';
    document.getElementById('cFechaDisponible').value = extraTmp.includes(fd) ? '' : fd;
    document.getElementById('cFechaNoDisponible').value = ausTmp.some(a => a.desde === fnd && a.hasta === fnd) ? '' : fnd;
    ['cAusDesde', 'cAusHasta', 'cAusMotivo', 'cExtraFecha'].forEach(id => { document.getElementById(id).value = ''; });
    renderAusTmp(); vincReset('C');
    openModal('modalConductor');
}

async function eliminarConductor(i) { if (_bloqueadoLector()) return; 
    if(await confirmar("¿Eliminar este registro?", 'Eliminar')) { 
        const nombre = `${conductores[i].nombre} ${conductores[i].apellido}`;
        conductores.splice(i,1); 
        guardarLocal(); renderListaConductores();
        registrarActividad('Eliminar', `Conductor: ${nombre}`);
    } 
}

// === CRUD TERRITORIOS ===
function openModalTerritorio() { actualizarDatalists(); limpiarHorasCustom(); horasBaseExtra().forEach(h => addChipHora(h, false)); setTimeout(togglePequeno, 0); 
    document.getElementById('formTerritorio').reset(); 
    document.getElementById('editIndexTerritorio').value = ""; 
    openModal('modalTerritorio'); 
}

document.getElementById('formTerritorio').addEventListener('submit', (e) => {
    e.preventDefault(); if (!antiDoble(e)) return;
    const index = document.getElementById('editIndexTerritorio').value;
    const numRaw = document.getElementById('tNumero').value.replace(/\s+/g, '').toUpperCase();
    if (!document.getElementById('tPequeno').checked && !numRaw) return mostrarToast('Indica el número o marca "Es un subterritorio"', 'error');
    if (numRaw && !/^\d+(?:[-.]?[A-Z0-9]{1,4})?$/.test(numRaw)) return mostrarToast('Número no válido. Usa formatos como 12, 12-A o 12.1', 'error');
    const t = { 
        numero: numRaw, pequeno: document.getElementById('tPequeno').checked, prioritario: document.getElementById('tPrioritario').checked,
        nombre: limpiarEsp(document.getElementById('tNombre').value), 
        lugar: limpiarEsp(document.getElementById('tLugar').value),
        disponibilidadDias: Array.from(document.querySelectorAll('#tDias input:checked')).map(cb => cb.value),
        disponibilidadHoras: Array.from(document.querySelectorAll('#tHoras input:checked')).map(cb => cb.value)
    };
    const dup = territorios.some((x, i) => String(i) !== String(index) && (t.numero !== '' ? String(x.numero).toLowerCase() === t.numero.toLowerCase() : (x.numero === '' && norm(x.nombre) === norm(t.nombre))));
    if (dup) { avisar(t.numero !== '' ? `Ya existe el territorio o subterritorio número ${t.numero}.` : `Ya existe un subterritorio llamado "${t.nombre}".`); return; }
    aislarLugares('grupos', () => {
        if(index === "") {
            territorios.push(t);
            registrarActividad('Agregar', `Territorio: ${t.numero}. ${t.nombre}`);
        } else {
            const anterior = `${territorios[index].numero}. ${territorios[index].nombre}`;
            territorios[index] = t;
            registrarActividad('Editar', `Territorio: ${anterior} → ${t.numero}. ${t.nombre}`);
        }
    });
    guardarLocal(); renderListaTerritorios(); actualizarDatalists(); closeModal('modalTerritorio');
});

function editarTerritorio(i) {
    const t = territorios[i]; document.getElementById('editIndexTerritorio').value = i;
    document.getElementById('tPequeno').checked = !!t.pequeno || t.numero === ''; togglePequeno(); document.getElementById('tNumero').value = t.numero; document.getElementById('tNombre').value = t.nombre; document.getElementById('tLugar').value = t.lugar;
    document.querySelectorAll('#tDias input').forEach(cb => cb.checked = (t.disponibilidadDias || []).includes(cb.value));
    document.getElementById('tPrioritario').checked = !!t.prioritario;
    limpiarHorasCustom(); horasBaseExtra().forEach(h => addChipHora(h, false)); (t.disponibilidadHoras || []).forEach(h => { if (!STD_HORAS.includes(h)) addChipHora(h, true); });
    document.querySelectorAll('#tHoras input').forEach(cb => cb.checked = (t.disponibilidadHoras || []).includes(cb.value));
    openModal('modalTerritorio');
}

async function eliminarTerritorio(i) { if (_bloqueadoLector()) return; 
    if(await confirmar("¿Eliminar este registro?", 'Eliminar')) { 
        const nombre = `${territorios[i].numero}. ${territorios[i].nombre}`;
        aislarLugares('grupos', () => { territorios.splice(i,1); });
        guardarLocal(); renderListaTerritorios();
        registrarActividad('Eliminar', `Territorio: ${nombre}`);
    } 
}

// === MOTOR DE GENERACIÓN ===

function conductorDisponible(c, dia, bloque) {
    const d = c.disponibilidadDias || [];
    if (d.includes(`${dia}-${bloque}`)) return true;
    // Compatibilidad: día marcado sin bloques específicos
    const tieneBloques = d.some(x => x.startsWith(dia + '-'));
    return d.includes(dia) && !tieneBloques;
}

function obtenerConductorOptimo(conds, agenda, diaMesActual, grupoObjetivo, ctx) {
    if (!conds.length) return null; ctx = ctx || {};
    const max = ctx.max || 4, cnt = {};
    agenda.forEach(a => { if (!a.evento) cnt[a.conductor] = (cnt[a.conductor] || 0) + 1; });
    const hoy = agenda.filter(a => a.diaMes === diaMesActual).map(a => a.conductor), ayer = agenda.filter(a => a.diaMes === diaMesActual - 1).map(a => a.conductor);
    const n = c => cnt[nomC(c)] || 0;
    // Se relaja de la regla más estricta a la más laxa: sin doble turno el mismo día, bajo el límite mensual, con descanso
    const niveles = [c => !hoy.includes(nomC(c)) && n(c) < max && !ayer.includes(nomC(c)), c => !hoy.includes(nomC(c)) && n(c) < max, c => !hoy.includes(nomC(c)), c => n(c) < max, () => true];
    let pool = []; for (const f of niveles) { pool = conds.filter(f); if (pool.length) break; }
    if (ctx.diaNombre === 'SÁB' || ctx.diaNombre === 'DOM') { const pr = pool.filter(esPrioritario); if (pr.length) pool = pr; }
    const min = Math.min(...pool.map(n)), menos = pool.filter(c => n(c) === min);
    const delGrupo = menos.filter(c => c.grupo === grupoObjetivo);
    const arr = delGrupo.length ? delGrupo : menos; return arr[Math.floor(Math.random() * arr.length)];
}

// === RENDERIZADO DE TABLA Y JERARQUÍA ===

// === WHATSAPP Y NOTIFICACIONES ===

// === SISTEMA DE HISTORIAL GUARDADO ===

// === HISTORIAL DE ACTIVIDAD ===
function renderActividad() {
    const cont = document.getElementById('listaActividad'); if(!cont) return;
    cont.innerHTML = '';
    if (historialActividad.length === 0) {
        cont.innerHTML = '<p style="color: var(--text-sub); font-size: 0.9rem; font-weight: 500;">No hay actividad registrada aún.</p>';
        return;
    }
    historialActividad.forEach(act => {
        const item = document.createElement('div'); item.className = 'historial-item';
        const fuerte = document.createElement('strong'); fuerte.textContent = String(act.accion ?? '');
        const chico = document.createElement('small'); chico.textContent = String(act.fecha ?? '');
        item.append(fuerte, document.createTextNode(': ' + String(act.detalle ?? '') + ' '), chico);
        cont.appendChild(item);
    });
}

async function borrarHistorialActividad() { if (_bloqueadoLector()) return;
    if(await confirmar(`¿Borrar todo el historial de actividad?\n\n✖ Se eliminarán ${historialActividad.length} registro(s).\n✔ No se tocan las agendas ni los turnos fijados con candado (${contarFijados(agendasMaestras)} en total).`, 'Borrar')) {
        historialActividad = [];
        guardarLocal();
        renderActividad();
    }
}

function validarDatosConductor(c, idx) {
    if (c.nombre && c.apellido && conductores.some((x, i) => String(i) !== String(idx) && norm(nomC(x)) === norm(nomC(c)))) { avisar(`Ya existe un conductor llamado "${nomC(c)}". No se guardó para evitar duplicados.`); return false; }
    if (!c.telefono) { mostrarToast('Ingresa un teléfono válido', 'error'); return false; }
    if (!c.nombre || !c.apellido) { mostrarToast("Nombre y apellido son obligatorios", "error"); return false; }
    return true;
}

function actualizarDatalists() {
    const dl = document.getElementById('dlLugares'); if (!dl) return;
    const u = [...new Set(territorios.map(t => limpiarEsp(t.lugar)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    dl.innerHTML = u.map(l => `<option value="${esc(l)}"></option>`).join('');
}

function rangosSemana(totalDias) {
    const limites = [[1, 7], [8, 14], [15, 21], [22, 28], [29, 31]];
    const out = [];
    limites.forEach(([d, h], i) => {
        if (d <= totalDias) out.push({ clave: 'sem' + (i + 1), nombre: 'Semana ' + (i + 1), desde: d, hasta: Math.min(h, totalDias) });
    });
    return out;
}

function rangosQuincena(total) {
    return [{ clave: 'q1', nombre: 'Quincena 1', desde: 1, hasta: Math.min(15, total) }, { clave: 'q2', nombre: 'Quincena 2', desde: 16, hasta: total }].filter(r => r.desde <= total);
}
function exportarCSV() {
    const R = agendasMaestras[agendaKey()]; if (!R || !R.length) return mostrarToast('Primero genera una agenda para este mes.', 'error');
    const q = v => `"${sinDatosContacto(v ?? '').replace(/"/g, '""')}"`, rows = [['Día', 'Fecha', 'Hora', 'Conductor', 'Territorio', 'Lugar', 'Grupos']];
    R.forEach(f => rows.push(f.evento ? [DIAS_LARGOS[f.diaSemana], f.diaMes, 'Todo el día', f.motivo, '', '', ''] : [DIAS_LARGOS[f.diaSemana], f.diaMes, f.hora, f.conductor, f.territorio, f.lugar, f.grupos]));
    const csv = '\ufeff' + rows.map(r => r.map(q).join(';')).join('\r\n'), a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = `Agenda-${pad(document.getElementById('mesAgenda').value)}-${anioSel()}.csv`; a.click();
    registrarActividad('Exportar', 'Agenda en CSV (Excel)');
}
function exportarPDF() {
    if (!(agendasMaestras[agendaKey()] || []).length) return mostrarToast('Primero genera una agenda para este mes.', 'error');
    limpiarFiltrosAgenda();
    const a = document.getElementById('areaExportar').cloneNode(true); limpiarClon(a);
    const w = window.open('', '_blank'); if (!w) return mostrarToast('Permite las ventanas emergentes para exportar el PDF', 'error');
    const css = cssDeLaApp();
    w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Agenda ${esc(nombreMesSel())} ${anioSel()}</title><style>${css}
            @page{size:letter;margin:12mm}html,body{background:#fff!important;margin:0}body{zoom:1}*{animation:none!important}
            #areaExportar{max-width:none!important;width:100%!important;padding:0!important;border-radius:0}
            .agenda-table{font-size:.78rem}.agenda-table th{position:static!important}.agenda-table td{padding:6px 8px}.agenda-table tr{page-break-inside:avoid}thead{display:table-header-group}
            *{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>${a.outerHTML}</body></html>`);
    w.document.close(); setTimeout(() => { w.focus(); w.print(); }, 500);
    registrarActividad('Exportar', 'Agenda en PDF');
}
function abrirModalDescarga() {
    const mes = document.getElementById('mesAgenda').value;
    const datos = agendasMaestras[agendaKey()];
    if (!datos || datos.length === 0) { mostrarToast("Primero genera una agenda para este mes.", "error"); return; }
    limpiarFiltrosAgenda();
    const total = Math.max(...datos.map(d => d.diaMes));
    const cont = document.getElementById('opcionesDescarga');
    cont.innerHTML = '';
    rangosSemana(total).forEach(r => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'download-option';
        b.innerHTML = `<span>${r.nombre}</span><small>Días ${r.desde} al ${r.hasta}</small>`;
        b.onclick = () => previsualizar(r.clave);
        cont.appendChild(b);
    });
    rangosQuincena(total).forEach(r => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'download-option';
        b.innerHTML = `<span>${r.nombre}</span><small>Días ${r.desde} al ${r.hasta}</small>`; b.onclick = () => previsualizar(r.clave); cont.appendChild(b);
    });
    const full = document.createElement('button');
    full.type = 'button';
    full.className = 'download-option full';
    full.innerHTML = `<span>Mes completo</span><small>Días 1 al ${total}</small>`;
    full.onclick = () => previsualizar('mes');
    cont.appendChild(full);
    document.getElementById('prevBox').classList.add('hidden');
    openModal('modalDescarga');
}

async function capturarRango(rango = 'mes', escalaFija) {
    const area = document.getElementById('areaExportar');
    const mesSel = document.getElementById('mesAgenda');
    const mes = mesSel.value;
    const nombreMes = mesSel.options[mesSel.selectedIndex].text;
    const anio = obtenerAnioTrabajo();
    const datos = agendasMaestras[agendaKey()] || [];
    const total = datos.length ? Math.max(...datos.map(d => d.diaMes)) : 31;
    const sel = [...rangosSemana(total), ...rangosQuincena(total)].find(r => r.clave === rango);
    const desde = sel ? sel.desde : 1;
    const hasta = sel ? sel.hasta : total;
    const nFilas = datos.filter(f => f.diaMes >= desde && f.diaMes <= hasta).length;
    const etiqueta = sel ? `${sel.nombre} (días ${sel.desde} al ${sel.hasta})` : 'Mes completo';

    try {
        await document.fonts.ready;
        const canvas = await html2canvas(area, {
            scale: escalaFija || (nFilas > 40 ? 1.6 : nFilas > 22 ? 2 : 2.5),
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: 1000,
            onclone: (doc) => {
                // Tamaño fijo: el zoom y el tamaño de pantalla no afectan la imagen
                doc.documentElement.style.setProperty('--zoom', '1'); doc.documentElement.removeAttribute('data-densidad');
                const a = doc.getElementById('areaExportar');
                limpiarClon(a);
                const st = doc.createElement('style'); const g = nFilas > 30;
                st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;opacity:1!important;transform:none!important}.agenda-table th{position:static!important}.agenda-table td{padding:' + (g ? '7px 8px' : '11px 10px') + '!important}.agenda-table{font-size:' + (g ? '.8rem' : '.9rem') + '}'; doc.head.appendChild(st);
                a.parentElement.style.maxHeight = 'none';
                a.style.width = '900px';
                a.style.maxWidth = '900px';
                a.parentElement.style.overflow = 'visible';
                a.parentElement.style.border = 'none';
                let primera = true;
                a.querySelectorAll('#tablaCuerpoAgenda tr').forEach(f => {
                    const dia = parseInt(f.getAttribute('data-diames'));
                    if (!isNaN(dia) && (dia < desde || dia > hasta)) { f.style.display = 'none'; return; }
                    if (primera) { f.classList.remove('day-separator'); primera = false; }
                });
                const p = doc.getElementById('fechaActualDisplay');
                if (p) p.textContent = `${nombreMes} ${anio} · ${etiqueta}`;
            }
        });
        const sufijo = rango === 'mes' ? 'mes-completo' : rango.startsWith('q') ? 'quincena-' + rango.slice(1) : 'semana-' + rango.slice(3);
        return { canvas, etiqueta, nombre: `Agenda-${String(mes).padStart(2, '0')}-${anio}-${sufijo}.png` };
    } catch (err) {
        mostrarToast("No se pudo generar la imagen. Inténtalo de nuevo.", "error"); return null;
    }
}
async function previsualizar(rango) {
    mostrarToast('Generando vista previa...');
    const r = await capturarRango(rango, 0.6); if (!r) return;
    document.getElementById('prevImg').src = r.canvas.toDataURL('image/png'); document.getElementById('prevEtq').textContent = 'Vista previa: ' + r.etiqueta;
    document.getElementById('prevBox').classList.remove('hidden'); document.getElementById('prevBtn').onclick = () => descargarImagen(rango);
}
async function descargarImagen(rango = 'mes') {
    closeModal('modalDescarga'); const r = await capturarRango(rango); if (!r) return;
    const link = document.createElement('a'); link.download = r.nombre; link.href = r.canvas.toDataURL('image/png'); link.click();
    registrarActividad('Descargar', `Imagen de agenda (${r.etiqueta})`);
}

// =====================================================================
// === MÓDULO 7: MODO "PREDICACIÓN CON EXHIBIDORES" (sincronizado anti-choques) ===
// =====================================================================
const EXH_DIAS = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'];
const EXH_TABS = ['tab-exh-agenda', 'tab-exh-part', 'tab-exh-lug', 'tab-exh-res', 'tab-exh-act'];
const GRP_TABS = ['tab-agenda', 'tab-personal', 'tab-territorios', 'tab-resumen', 'tab-historial'];
const EXH_PAUTAS = ['Pautas para la predicación pública: Ver el formulario s-148', '( en cada exhibidor estará colocado )', 'DEBE ESTAR 10 MINUTOS ANTES DE LA HORA PAUTADA EN EL LUGAR DE SALIDA'];
const EXH_LUGARES_DEF = ['La Recta', 'Calazán', 'La Plana', 'Ent. La Colonia'];

function exhConfigDef() {
    return { turnos: [
        { id: 'AM', nombre: 'Mañana', hora: '9:00 AM a 11:00 AM', puntos: { LUN: 1, MAR: 1, JUE: 1, VIE: 1, 'SÁB': 2 } },
        { id: 'PM', nombre: 'Tarde', hora: '4:00 PM a 5:30 PM', puntos: { LUN: 1, MAR: 1, JUE: 1 } }
    ] };
}
function exhDef() { return { participantes: [], lugares: [], agendas: {}, historial: {}, actividad: [], config: exhConfigDef(), sembrado: false }; }
function exhNormalizar(x) {
    const o = Object.assign(exhDef(), (x && typeof x === 'object' && !Array.isArray(x)) ? x : {});
    if (!Array.isArray(o.participantes)) o.participantes = [];
    if (!Array.isArray(o.lugares)) o.lugares = [];
    if (!Array.isArray(o.actividad)) o.actividad = [];
    if (!o.agendas || typeof o.agendas !== 'object' || Array.isArray(o.agendas)) o.agendas = {};
    if (!o.historial || typeof o.historial !== 'object' || Array.isArray(o.historial)) o.historial = {};
    if (!o.config || !Array.isArray(o.config.turnos) || !o.config.turnos.length) o.config = exhConfigDef();
    o.config.turnos.forEach(t => { if (!t.puntos || typeof t.puntos !== 'object') t.puntos = {}; });
    if (!o.sembrado && !o.lugares.length) {
        const slots = []; o.config.turnos.forEach(t => EXH_DIAS.forEach(d => { if ((t.puntos[d] | 0) > 0) slots.push(d + '-' + t.id); }));
        o.lugares = EXH_LUGARES_DEF.map(n => ({ nombre: n, dias: slots.slice(), simult: 1 }));
    }
    // Lugares de Exhibidores: ámbito propio (nunca comparte datos con Territorios) y siempre 1 exhibidor por punto
    o.lugares = o.lugares.filter(l => l && String(l.nombre || '').trim()).map(l => ({ nombre: String(l.nombre).trim(), dias: Array.isArray(l.dias) ? l.dias.slice() : [], simult: 1 }));
    o.sembrado = true;
    return o;
}
let exh = exhDef(), modoApp = 'grupos';
try { modoApp = localStorage.getItem('vdm_modo') === 'exhibidores' ? 'exhibidores' : 'grupos'; } catch (e) {}

// ---------- Utilidades ----------
const exhNom = p => `${p.nombre || ''} ${p.apellido || ''}`.replace(/\s+/g, ' ').trim();
const exhNk = s => norm(s).replace(/\s+/g, ' ').trim();
const exhTel = t => { const d = String(t || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const exhIso = (a, m, d) => `${a}-${pad(m)}-${pad(d)}`;
const exhGenero = p => (p && (p.genero === 'M' || p.genero === 'F')) ? p.genero : generoDe(p);
const exhBloqueHora = h => { const m = /\d{1,2}:\d{2}\s*(AM|PM)/i.exec(String(h || '')); return m ? m[1].toUpperCase() : 'AM'; };
const exhBloque = t => exhBloqueHora(t.hora);
function exhMes() { return parseInt(document.getElementById('exhMes').value, 10); }
function exhAnio() { const e = document.getElementById('exhAnio'); return e && e.value ? parseInt(e.value, 10) : new Date().getFullYear(); }
function exhKey() { return `${exhAnio()}-${exhMes()}`; }
function exhIsoFila(key, f) { const [a, m] = key.split('-').map(Number); return exhIso(a, m, f.diaMes); }
function exhLunes(a, m, d) { const dt = new Date(a, m - 1, d); dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); return exhIso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()); }
function exhSlots(dia) { return exh.config.turnos.filter(t => (t.puntos[dia] | 0) > 0); }
function exhPartPorNombre(n) { const k = exhNk(n); return exh.participantes.find(p => exhNk(exhNom(p)) === k) || null; }
function exhReg(accion, detalle) {
    const f = new Date().toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    exh.actividad.unshift({ accion, detalle, fecha: f }); if (exh.actividad.length > 100) exh.actividad.pop();
    guardarLocal(); exhRenderAct();
}
function exhDispo(p, dia, bloque, iso) {
    if (p.estado === 'pausa') return false;
    if ((p.noDisp || []).includes(iso)) return false;
    if ((p.extraDisp || []).includes(iso)) return true;
    return (p.disp || []).includes(`${dia}-${bloque}`);
}

// ---------- Cruce con Predicación de Grupos / Territorios ----------
function exhTelDeNombre(nombre) {
    const k = exhNk(nombre); if (!k) return '';
    const c = conductores.find(x => exhNk(nomC(x)) === k); if (c && exhTel(c.telefono)) return exhTel(c.telefono);
    const p = exh.participantes.find(x => exhNk(exhNom(x)) === k); return p ? exhTel(p.telefono) : '';
}
function exhMismo(nA, tA, nB, tB) { const a = exhNk(nA); return (!!a && a === exhNk(nB)) || (!!tA && tA === tB); }
// Turno de grupos de esa persona en esa fecha (o null)
function exhEnGrupos(nombre, tel, iso) {
    const [a, m, d] = iso.split('-').map(Number), R = agendasMaestras[`${a}-${m}`] || [];
    return R.find(f => !f.evento && f.diaMes === d && !esVacio(f.conductor, 'Sin Asignar') && exhMismo(nombre, tel, f.conductor, exhTelDeNombre(f.conductor))) || null;
}
// Turno de exhibidor de esa persona en esa fecha (o null); "excepto" = fila que no cuenta
function exhEnExh(nombre, tel, iso, excepto) {
    const [a, m, d] = iso.split('-').map(Number), R = exh.agendas[`${a}-${m}`] || [];
    for (const f of R) {
        if (f === excepto || f.bloqueado || f.diaMes !== d) continue;
        const i = (f.parts || []).findIndex(n => n && exhMismo(nombre, tel, n, exhTelDeNombre(n)));
        if (i >= 0) return { f, i };
    }
    return null;
}
function exhChoques(key, f, pos) {
    const n = f.parts[pos], out = []; if (!n || f.bloqueado) return out;
    const tel = exhTelDeNombre(n), iso = exhIsoFila(key, f), dl = `${DIAS_LARGOS[f.diaSemana]} ${f.diaMes}`;
    const g = exhEnGrupos(n, tel, iso);
    if (g) out.push({ t: 'choque', msg: `${n} ya tiene turno en Predicación de Grupos el ${dl} (${g.hora}${!esVacio(g.territorio, 'Sin Territorio') ? ', ' + g.territorio : ''})` });
    const e = exhEnExh(n, tel, iso, f);
    if (e) out.push({ t: 'choque', msg: `${n} ya está en otro exhibidor el ${dl} (${e.f.hora}, ${e.f.lugar || 'lugar por definir'})` });
    if (f.parts.some((x, j) => j !== pos && x && exhNk(x) === exhNk(n))) out.push({ t: 'choque', msg: `${n} está repetido en este mismo exhibidor` });
    const p = exhPartPorNombre(n);
    if (p && !exhDispo(p, f.diaSemana, exhBloqueHora(f.hora), iso)) out.push({ t: 'aviso', msg: `${n} no tiene marcada disponibilidad para ese horario` });
    return out;
}
// Usado por el modo Grupos: ¿este conductor ya tiene exhibidor ese día?
function exhChoqueConductor(c, iso) { return exhEnExh(nomC(c), exhTel(c.telefono), iso); }

// ---------- Aislamiento de Lugares (Exhibidores ↔ Grupos) ----------
// Lugares de Exhibidores = exh.lugares · Lugares de Grupos = territorios[].lugar. Cada operación solo puede tocar su propio ámbito.
function aislarLugares(ambito, fn) {
    const antes = ambito === 'exh' ? JSON.stringify(territorios) : JSON.stringify(exh.lugares);
    const r = fn();
    if (ambito === 'exh' && JSON.stringify(territorios) !== antes) territorios = JSON.parse(antes);
    if (ambito === 'grupos' && JSON.stringify(exh.lugares) !== antes) exh.lugares = JSON.parse(antes);
    return r;
}

// ---------- Hoy y mañana (Exhibidores) ----------
function exhVentana(hora) {
    const ts = [...String(hora || '').matchAll(/\d{1,2}:\d{2}\s*(?:AM|PM)/gi)].map(m => hMin(m[0]));
    const ini = ts.length ? ts[0] : 0; let fin = ts.length > 1 ? ts[1] : ini + 120; if (fin <= ini) fin = ini + 120;
    return { ini, fin };
}
function exhEstadoTurno(f, ahoraMin) { const v = exhVentana(f.hora); return ahoraMin >= v.fin ? 'fin' : (ahoraMin >= v.ini ? 'en' : 'prox'); }
function exhRenderHoy() {
    const el = document.getElementById('cardHoyExh'); if (!el) return;
    const h = new Date(), ahora = h.getHours() * 60 + h.getMinutes(), m = new Date(h.getFullYear(), h.getMonth(), h.getDate() + 1);
    const delDia = d => (exh.agendas[`${d.getFullYear()}-${d.getMonth() + 1}`] || []).filter(f => !f.bloqueado && f.diaMes === d.getDate() && (f.parts || []).some(Boolean)).sort((a, b) => exhVentana(a.hora).ini - exhVentana(b.hora).ini);
    const hoy = delDia(h).filter(f => exhEstadoTurno(f, ahora) !== 'fin'), man = delDia(m);
    if (!hoy.length && !man.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    let prox = -1; hoy.forEach((f, j) => { if (prox < 0 && exhEstadoTurno(f, ahora) === 'prox') prox = j; });
    const fila = (f, tag) => `<div class="hoy-row">${pillHora(f.hora)}<div><strong>${esc(f.lugar || 'Lugar por definir')}</strong>${tag}<br><small>${esc((f.parts || []).filter(Boolean).join(' · '))}</small></div></div>`;
    const col = (t, L, esHoy) => `<div><div class="hoy-dia">${t}</div>${L.map((f, j) => fila(f, esHoy ? (exhEstadoTurno(f, ahora) === 'en' ? ' <span class="tag en">En curso</span>' : j === prox ? ' <span class="tag prox">Próxima salida</span>' : '') : '')).join('') || '<small class="hint">Sin salidas</small>'}</div>`;
    el.innerHTML = `<div class="module-title" style="margin-bottom:14px">Hoy y mañana</div><div class="hoy-grid">${col('Hoy · ' + DIAS_LARGOS[DIAS[h.getDay()]] + ' ' + h.getDate(), hoy, true)}${col('Mañana · ' + DIAS_LARGOS[DIAS[m.getDay()]] + ' ' + m.getDate(), man, false)}</div>`;
}
// Pendiente = participante asignado que aún no tiene el doble check (✓✓) de confirmado
function exhActualizarBadge(L) {
    const b = document.getElementById('badgeExhAgenda'); if (!b) return;
    const n = (L || exhItemsContacto()).reduce((t, x) => t + (x.f.parts || []).reduce((u, nom, pos) => u + (nom && !(x.f.conf || [])[pos] ? 1 : 0), 0), 0);
    b.textContent = n; b.classList.toggle('hidden', !n);
}

// ---------- Resumen de Exhibidores ----------
function exhPoblarResSel() {
    const ms = document.getElementById('exhResMes'), as = document.getElementById('exhResAnio'); if (!ms || !as) return;
    const y = new Date().getFullYear(), set = new Set([y - 1, y, y + 1]);
    Object.keys(exh.agendas).forEach(k => set.add(parseInt(k, 10)));
    const prev = as.value; as.innerHTML = [...set].filter(Boolean).sort().map(v => `<option value="${v}">${v}</option>`).join('');
    const ea = exhAnio(); as.value = prev && set.has(+prev) ? prev : String(set.has(ea) ? ea : y);
    if (!ms.dataset.init) { ms.value = String(exhMes() || new Date().getMonth() + 1); ms.dataset.init = '1'; }
}
function exhRenderRes() {
    const cPart = document.getElementById('exhResPart'); if (!cPart) return;
    exhPoblarResSel();
    const mes = +document.getElementById('exhResMes').value, anio = +document.getElementById('exhResAnio').value;
    const pm = {}, pa = {}, lm = {}, la = {}, nombres = {}; let totM = 0, totA = 0, turnosM = 0;
    Object.keys(exh.agendas).forEach(k => {
        const [ka, km] = k.split('-').map(Number); if (ka !== anio) return;
        (exh.agendas[k] || []).forEach(f => {
            if (f.bloqueado) return;
            if (km === mes) turnosM++;
            if (f.lugar && norm(f.lugar) !== 'por definir') { la[f.lugar] = (la[f.lugar] || 0) + 1; if (km === mes) lm[f.lugar] = (lm[f.lugar] || 0) + 1; }
            (f.parts || []).forEach(n => { if (!n) return; const nk = exhNk(n); nombres[nk] = nombres[nk] || n; pa[nk] = (pa[nk] || 0) + 1; totA++; if (km === mes) { pm[nk] = (pm[nk] || 0) + 1; totM++; } });
        });
    });
    exh.participantes.forEach(p => { nombres[exhNk(exhNom(p))] = exhNom(p); });
    const activos = new Set(exh.participantes.filter(p => p.estado !== 'pausa').map(p => exhNk(exhNom(p))));
    const filas = Object.keys(nombres).map(nk => ({ n: nombres[nk], m: pm[nk] || 0, a: pa[nk] || 0, act: activos.has(nk) })).sort((x, y) => y.m - x.m || y.a - x.a || x.n.localeCompare(y.n, 'es'));
    const base = filas.filter(x => x.act), cm = base.map(x => x.m);
    const max = cm.length ? Math.max(...cm) : 0, min = cm.length ? Math.min(...cm) : 0, prom = cm.length ? cm.reduce((a, b) => a + b, 0) / cm.length : 0, dif = max - min;
    const nivel = !totM ? ['mid', 'Sin datos'] : dif <= 1 ? ['ok', 'Equilibrado'] : dif <= 2 ? ['mid', 'Aceptable'] : ['bad', 'Desbalanceado'];
    const mm = MESES[mes - 1], mc = mm.slice(0, 3);
    document.getElementById('exhResEstado').textContent = turnosM ? `${mm} ${anio}: ${turnosM} exhibidor(es) programado(s) · ${totM} participación(es).` : `No hay agenda de exhibidores generada para ${mm} ${anio}.`;
    const kpi = (v, l) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;
    document.getElementById('exhResKpis').innerHTML = `<div class="res-kpis">${kpi(totM, 'Participaciones en ' + mm)}${kpi(totA, 'Participaciones en ' + anio)}${kpi(max + ' / ' + min, 'Máximo / mínimo por persona (mes)')}<div class="kpi kpi-eq"><span>Reparto del mes</span><span class="eq ${nivel[0]}">${nivel[1]}</span><small>diferencia máx–mín: ${dif}</small></div></div>`;
    const barra = (v, mx) => `<span class="stat-bar"><i style="width:${mx ? Math.round(v / mx * 100) : 0}%"></i></span>`;
    const cab = t => `<div class="rot-row rot-head"><span>${t}</span><b>${mc}</b><b>Año</b><span>Mes</span></div>`;
    cPart.innerHTML = filas.length ? `<div class="rot-tabla">${cab('Hermano/a')}${filas.map(x => {
        const sat = x.act && x.m >= 2 && x.m - prom >= 2 && x.m > prom * 1.4;
        return `<div class="rot-row"><span class="rot-n">${esc(x.n)}${x.act ? '' : ' <span class="tag pausa">En pausa</span>'}${sat ? '<span class="tag sat">Saturado</span>' : ''}</span><b>${x.m}</b><b>${x.a}</b>${barra(x.m, max)}</div>`;
    }).join('')}</div>` : '<p class="hint">Aún no hay participantes registrados.</p>';
    const nl = {}; exh.lugares.forEach(l => { nl[l.nombre] = 1; }); Object.keys(la).forEach(n => { nl[n] = 1; });
    const lf = Object.keys(nl).map(n => ({ n, m: lm[n] || 0, a: la[n] || 0 })).sort((x, y) => y.m - x.m || y.a - x.a || x.n.localeCompare(y.n, 'es')), lmax = lf.length ? Math.max(...lf.map(x => x.m)) : 0;
    document.getElementById('exhResLug').innerHTML = lf.length ? `<div class="rot-tabla">${cab('Lugar')}${lf.map(x => `<div class="rot-row"><span class="rot-n">${esc(x.n)}</span><b>${x.m}</b><b>${x.a}</b>${barra(x.m, lmax)}</div>`).join('')}</div>` : '<p class="hint">Aún no hay lugares registrados.</p>';
}

// ---------- Vinculación de personas entre Grupos y Exhibidores ----------
// Una persona puede estar en ambos modos (Conductores y Participantes). Se detecta por nombre o teléfono normalizados;
// al vincular comparten teléfono, género y disponibilidad, de modo que los cruces anti-choques sean coherentes.
const vincEstado = { C: null, P: null }, vincIdTmp = { C: '', P: '' };
const vincUid = () => 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const vincValor = id => (document.getElementById(id) || {}).value || '';
const VINC_ICO = '<svg class="ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
function vincBuscarP(nk, tel, id) {
    let j = id ? exh.participantes.findIndex(p => p.vinc === id) : -1;
    if (j < 0) j = exh.participantes.findIndex(p => (nk && exhNk(exhNom(p)) === nk) || (tel && exhTel(p.telefono) === tel));
    return j;
}
function vincBuscarC(nk, tel, id) {
    let j = id ? conductores.findIndex(c => c.vinc === id) : -1;
    if (j < 0) j = conductores.findIndex(c => (nk && exhNk(nomC(c)) === nk) || (tel && exhTel(c.telefono) === tel));
    return j;
}
const vincDispC2P = c => (c.disponibilidadDias || []).filter(v => /^[^-]{3}-(AM|PM)$/.test(v) && EXH_DIAS.includes(v.slice(0, 3)));
function vincDispP2C(p) { const out = []; EXH_DIAS.forEach(d => { const b = ['AM', 'PM'].filter(x => (p.disp || []).includes(d + '-' + x)); if (b.length) { out.push(d); b.forEach(x => out.push(d + '-' + x)); } }); return out; }
const vincExtraC = c => [...new Set([...(c.fechasExtraDisp || []), c.fechaDisponible].filter(d => ISO_RE.test(d || '')))].sort();
function vincNoDispC(c) {
    const out = new Set();
    ausenciasDe(c).forEach(a => { const d = new Date(a.desde + 'T00:00:00'), h = new Date(a.hasta + 'T00:00:00'); let n = 0; while (d <= h && n < 366) { out.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`); d.setDate(d.getDate() + 1); n++; } });
    return [...out].sort();
}
function vincLeerForm(lado) {
    if (lado === 'C') {
        const idx = vincValor('editIndexConductor'), ant = idx !== '' ? conductores[idx] : null, n = vincValor('cNombre').trim(), a = vincValor('cApellido').trim();
        return { nk: n && a ? exhNk(n + ' ' + a) : '', tel: exhTel(limpiarTelefono(vincValor('cTelefono'))), id: vincIdTmp.C || (ant && ant.vinc) || '' };
    }
    const idx = parseInt(vincValor('epIdx'), 10), ant = idx >= 0 ? exh.participantes[idx] : null, n = vincValor('epNombre').trim(), a = vincValor('epApellido').trim();
    return { nk: n && a ? exhNk(n + ' ' + a) : '', tel: exhTel(limpiarTelefono(vincValor('epTel'))), id: vincIdTmp.P || (ant && ant.vinc) || '' };
}
function vincReset(lado) { vincEstado[lado] = null; vincIdTmp[lado] = ''; setTimeout(() => vincRefrescarBanner(lado), 0); }
function vincRefrescarBanner(lado) {
    const box = document.getElementById(lado === 'C' ? 'vincBannerC' : 'vincBannerP'); if (!box) return;
    const f = vincLeerForm(lado), j = lado === 'C' ? vincBuscarP(f.nk, f.tel, f.id) : vincBuscarC(f.nk, f.tel, f.id);
    if (j < 0) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const otro = lado === 'C' ? exh.participantes[j] : conductores[j], nom = lado === 'C' ? exhNom(otro) : nomC(otro), modo = lado === 'C' ? 'Predicación con Exhibidores' : 'Predicación por grupos';
    const vinculado = vincEstado[lado] !== 'desvinc' && (vincEstado[lado] === 'importado' || vincEstado[lado] === 'vincular' || (!!f.id && otro.vinc === f.id));
    const btn = (t, a, p) => `<button type="button" class="${p ? 'btn-primary' : 'btn-outline'} mini" onclick="vincAccion('${lado}','${a}')">${t}</button>`;
    let txt, bts;
    if (vincEstado[lado] === 'desvinc') { txt = `No se vinculará con «${esc(nom)}» (${modo}).`; bts = btn('Vincular', 'vincular'); }
    else if (vinculado) { txt = `Vinculado con «${esc(nom)}» en ${modo}. Teléfono, género y disponibilidad se mantienen sincronizados al guardar.`; bts = btn('Desvincular', 'desvincular'); }
    else { txt = `«${esc(nom)}» ya está registrado en ${modo} (mismo nombre o teléfono). Vincúlalo para evitar duplicados y mantener coherente su disponibilidad.`; bts = btn('Importar sus datos y vincular', 'importar', true) + btn('Vincular al guardar', 'vincular'); }
    box.innerHTML = `${VINC_ICO}<span class="vt">${txt}</span><span class="vb">${bts}</span>`; box.classList.remove('hidden');
}
function vincImportarEnC(p) {
    if (p.telefono) document.getElementById('cTelefono').value = limpiarTelefono(p.telefono) || p.telefono;
    document.getElementById('cGenero').value = (p.genero === 'M' || p.genero === 'F') ? p.genero : '';
    const disp = vincDispP2C(p);
    document.querySelectorAll('#disponibilidadSemanal input[type="checkbox"]').forEach(cb => { cb.checked = disp.includes(cb.value); });
    extraTmp = (p.extraDisp || []).filter(d => ISO_RE.test(d)).slice();
    ausTmp = ausTmp.filter(a => a.motivo !== 'Exhibidores').concat((p.noDisp || []).filter(d => ISO_RE.test(d)).map(d => ({ desde: d, hasta: d, motivo: 'Exhibidores' })));
    renderAusTmp();
}
function vincImportarEnP(c) {
    if (c.telefono) document.getElementById('epTel').value = limpiarTelefono(c.telefono) || c.telefono;
    document.getElementById('epGenero').value = generoDe(c) === 'F' ? 'F' : 'M';
    const disp = vincDispC2P(c);
    document.querySelectorAll('#epDisp input').forEach(cb => { cb.checked = disp.includes(cb.value); });
    exhTmp = { extra: vincExtraC(c), no: vincNoDispC(c) }; exhChips();
}
function vincAccion(lado, accion) {
    const f = vincLeerForm(lado), j = lado === 'C' ? vincBuscarP(f.nk, f.tel, f.id) : vincBuscarC(f.nk, f.tel, f.id); if (j < 0) return;
    const otro = lado === 'C' ? exh.participantes[j] : conductores[j];
    if (accion === 'importar') { if (lado === 'C') vincImportarEnC(otro); else vincImportarEnP(otro); vincEstado[lado] = 'importado'; vincIdTmp[lado] = otro.vinc || vincUid(); mostrarToast('Datos importados. Se vincularán al guardar.'); }
    else if (accion === 'vincular') { vincEstado[lado] = 'vincular'; vincIdTmp[lado] = otro.vinc || vincUid(); }
    else { vincEstado[lado] = 'desvinc'; vincIdTmp[lado] = ''; }
    vincRefrescarBanner(lado);
}
// Decide (y pregunta si hace falta) si el registro que se guarda queda vinculado con su equivalente del otro modo.
async function vincAlGuardar(lado, nuevo, anterior) {
    const nk = lado === 'C' ? exhNk(nomC(nuevo)) : exhNk(exhNom(nuevo)), tel = exhTel(nuevo.telefono);
    const id = (anterior && anterior.vinc) || vincIdTmp[lado] || '', estado = vincEstado[lado];
    if (anterior && anterior.sinVinc && estado !== 'importado' && estado !== 'vincular') nuevo.sinVinc = true;
    const j = lado === 'C' ? vincBuscarP(nk, tel, id) : vincBuscarC(nk, tel, id);
    const otro = j < 0 ? null : (lado === 'C' ? exh.participantes[j] : conductores[j]);
    if (estado === 'desvinc') { if (otro && otro.vinc && otro.vinc === id) delete otro.vinc; nuevo.sinVinc = true; delete nuevo.vinc; return { otro: null }; }
    if (!otro) { delete nuevo.vinc; return { otro: null }; }
    let vincular = (!!id && otro.vinc === id) || estado === 'importado' || estado === 'vincular';
    if (!vincular && !nuevo.sinVinc) {
        const modo = lado === 'C' ? 'Predicación con Exhibidores' : 'Predicación por grupos', nom = lado === 'C' ? exhNom(otro) : nomC(otro);
        vincular = (await dialogo('Persona ya registrada en el otro modo', `«${nom}» ya existe en ${modo} (coincide por nombre o teléfono).\n\n¿Vincular ambos registros? Compartirán teléfono, género y disponibilidad, evitando duplicados y manteniendo coherentes los cruces anti-choques.`, [{ t: 'Guardar sin vincular', v: false }, { t: 'Vincular y sincronizar', v: true, primario: true }])) === true;
        if (!vincular) nuevo.sinVinc = true;
    }
    if (!vincular) { delete nuevo.vinc; return { otro: null }; }
    const uid = id || otro.vinc || vincIdTmp[lado] || vincUid();
    nuevo.vinc = uid; otro.vinc = uid; delete nuevo.sinVinc; delete otro.sinVinc;
    return { otro };
}
function vincSincronizar(lado, src, dst) {
    if (src.telefono) dst.telefono = src.telefono;
    if (lado === 'C') {   // conductor → participante
        dst.genero = generoDe(src) === 'F' ? 'F' : 'M';
        dst.disp = vincDispC2P(src); dst.extraDisp = vincExtraC(src); dst.noDisp = vincNoDispC(src);
    } else {              // participante → conductor
        if (src.genero === 'M' || src.genero === 'F') dst.genero = src.genero;
        dst.disponibilidadDias = vincDispP2C(src);
        dst.fechasExtraDisp = (src.extraDisp || []).filter(d => ISO_RE.test(d));
        if (dst.fechaDisponible && !dst.fechasExtraDisp.includes(dst.fechaDisponible)) dst.fechaDisponible = '';
        const noD = (src.noDisp || []).filter(d => ISO_RE.test(d));
        if (dst.fechaNoDisponible && !noD.includes(dst.fechaNoDisponible)) dst.fechaNoDisponible = '';
        const manual = (dst.ausencias || []).filter(a => a.motivo !== 'Exhibidores'), cubiertas = new Set(vincNoDispC({ ausencias: manual, fechaNoDisponible: dst.fechaNoDisponible }));
        dst.ausencias = manual.concat(noD.filter(d => !cubiertas.has(d)).map(d => ({ desde: d, hasta: d, motivo: 'Exhibidores' })));
    }
}

// ---------- Cambio de modo ----------
function alternarModo() {
    cerrarMenu();
    modoApp = modoApp === 'grupos' ? 'exhibidores' : 'grupos';
    try { localStorage.setItem('vdm_modo', modoApp); } catch (e) {}
    aplicarModoUI(true);
    mostrarToast(modoApp === 'exhibidores' ? 'Predicación con Exhibidores' : 'Predicación por grupos');
}
function aplicarModoUI(cambiar) {
    const ex = modoApp === 'exhibidores';
    document.body.setAttribute('data-modo', modoApp);
    document.getElementById('tabBarGrupos').classList.toggle('hidden', ex);
    document.getElementById('tabBarExh').classList.toggle('hidden', !ex);
    document.getElementById('btnCambiarModoTxt').textContent = ex ? 'Predicación por grupos' : 'Predicación con Exhibidores';
    if (ex) exhRenderHoy();
    const validas = ex ? EXH_TABS : GRP_TABS, clave = ex ? 'vdm_active_tab_exh' : 'vdm_active_tab';
    let t = null; try { t = localStorage.getItem(clave); } catch (e) {}
    if (!validas.includes(t)) t = validas[0];
    const act = document.querySelector('.tab-content.active');
    if (cambiar || !act || !validas.includes(act.id)) switchTab(t);
}
function exhPoblarAnios() {
    const e = document.getElementById('exhAnio'); if (!e) return;
    const y = new Date().getFullYear(), set = new Set([y - 1, y, y + 1, y + 2]);
    Object.keys(exh.agendas).forEach(k => set.add(parseInt(k, 10)));
    const prev = e.value; e.innerHTML = [...set].filter(Boolean).sort().map(v => `<option value="${v}">${v}</option>`).join('');
    e.value = prev && set.has(+prev) ? prev : String(y);
    const m = document.getElementById('exhMes'); if (m && !m.dataset.init) { m.value = String(new Date().getMonth() + 1); m.dataset.init = '1'; }
}
function exhIniciar() { exhPoblarAnios(); aplicarModoUI(false); exhRenderTodo(); }
function exhOnTab(id) {
    if (id === 'tab-exh-agenda') exhRenderAgenda(), exhRenderContactos();
    else if (id === 'tab-exh-part') exhRenderPart();
    else if (id === 'tab-exh-lug') exhRenderLug();
    else if (id === 'tab-exh-res') exhRenderRes();
    else if (id === 'tab-exh-act') exhRenderAct();
}
function exhRenderTodo() { exhRenderAgenda(); exhRenderContactos(); exhRenderHoy(); exhRenderPart(); exhRenderLug(); exhRenderRes(); exhRenderAct(); }
function exhRefrescarChoques() {
    if (modoApp !== 'exhibidores') return;
    const t = document.getElementById('tab-exh-agenda'); if (t && t.classList.contains('active')) { exhRenderAgenda(); exhRenderContactos(); exhRenderHoy(); }
}

// ---------- Generación equitativa del mes ----------
async function exhGenerar() { if (_bloqueadoLector()) return;
    const key = exhKey(), a = exhAnio(), m = exhMes();
    if (!exh.participantes.some(p => p.estado !== 'pausa')) return mostrarToast('Primero registra participantes activos en la pestaña Participantes.', 'error');
    if ((exh.agendas[key] || []).length && !(await confirmar(`Ya existe una agenda de exhibidores para ${MESES[m - 1]} ${a}.\n\n✔ Se conservarán: ningún turno (en exhibidores no hay candados).\n✖ Se reemplazarán: ${exhResumenImpacto(exh.agendas[key])}.\n\nSe perderán también las ediciones manuales.`, 'Regenerar'))) return;
    const dias = new Date(a, m, 0).getDate(), ex = excepciones[key] || [], filas = [];
    const act = exh.participantes.filter(p => p.estado !== 'pausa').map(p => ({ p, n: exhNom(p), nk: exhNk(exhNom(p)), tel: exhTel(p.telefono), g: exhGenero(p) }));
    const semCnt = {}, mesCnt = {}, ult = {}, usadoDia = {}, usoLug = {}, ultLug = {};
    // Participaciones de semanas que cruzan con meses vecinos
    Object.keys(exh.agendas).forEach(k => { if (k === key) return; const [ka, km] = k.split('-').map(Number); (exh.agendas[k] || []).forEach(f => { if (f.bloqueado) return; const sw = exhLunes(ka, km, f.diaMes); (f.parts || []).forEach(n => { if (n) { const q = sw + '|' + exhNk(n); semCnt[q] = (semCnt[q] || 0) + 1; } }); }); });
    let slotN = 0, faltas = 0;
    for (let d = 1; d <= dias; d++) {
        const iso = exhIso(a, m, d), dia = DIAS[new Date(a, m - 1, d).getDay()], slots = exhSlots(dia); if (!slots.length) continue;
        const evt = ex.find(e => d >= e.desde && d <= e.hasta), ultSab = esUltimoSabado(a, m, d), sw = exhLunes(a, m, d);
        usadoDia[d] = usadoDia[d] || new Set();
        for (const t of slots) {
            const base = { diaSemana: dia, diaMes: d, turno: t.id, hora: t.hora };
            if (evt || ultSab) { filas.push(Object.assign(base, { punto: 1, lugar: '', parts: ['', '', ''], avis: [false, false, false], conf: [false, false, false], bloqueado: true, motivo: evt ? evt.motivo : 'Predicación de grupos' })); continue; }
            const bloque = exhBloque(t), puntos = Math.max(1, t.puntos[dia] | 0);
            // Excluye: sin disponibilidad, ya usado ese día y quienes ya dirigen grupo ese día (anti-choque)
            const pool = act.filter(x => exhDispo(x.p, dia, bloque, iso) && !usadoDia[d].has(x.nk) && !exhEnGrupos(x.n, x.tel, iso));
            const ordenar = arr => arr.sort((x, y) => ((semCnt[sw + '|' + x.nk] || 0) - (semCnt[sw + '|' + y.nk] || 0)) || ((mesCnt[x.nk] || 0) - (mesCnt[y.nk] || 0)) || ((ult[x.nk] ?? -9) - (ult[y.nk] ?? -9)) || x.nk.localeCompare(y.nk));
            const lugs = exh.lugares.filter(l => (l.dias || []).includes(dia + '-' + t.id)), usoSlot = {}, usados = new Set();
            for (let pn = 1; pn <= puntos; pn++) {
                const cand = lugs.filter(l => (usoSlot[l.nombre] || 0) < 1).sort((x, y) => ((usoLug[x.nombre] || 0) - (usoLug[y.nombre] || 0)) || ((ultLug[x.nombre] ?? -9) - (ultLug[y.nombre] ?? -9)) || x.nombre.localeCompare(y.nombre, 'es'));
                const lug = cand[0]; if (lug) { usoSlot[lug.nombre] = (usoSlot[lug.nombre] || 0) + 1; usoLug[lug.nombre] = (usoLug[lug.nombre] || 0) + 1; ultLug[lug.nombre] = slotN; }
                const libres = pool.filter(x => !usados.has(x.nk));
                let sel = ordenar(libres.filter(x => ult[x.nk] !== slotN - 1)).slice(0, 3);          // 1.º: no repetir turno consecutivo
                if (sel.length < 3) sel = sel.concat(ordenar(libres.filter(x => ult[x.nk] === slotN - 1)).slice(0, 3 - sel.length));
                if (sel.length === 2 && sel[0].g !== sel[1].g) sel = [];                               // nunca un hermano y una hermana solos
                if (sel.length < 3) faltas++;
                sel.forEach(x => { usados.add(x.nk); usadoDia[d].add(x.nk); semCnt[sw + '|' + x.nk] = (semCnt[sw + '|' + x.nk] || 0) + 1; mesCnt[x.nk] = (mesCnt[x.nk] || 0) + 1; ult[x.nk] = slotN; });
                const parts = sel.map(x => x.n); while (parts.length < 3) parts.push('');
                filas.push(Object.assign({}, base, { punto: pn, lugar: lug ? lug.nombre : 'Por definir', parts, avis: [false, false, false], conf: [false, false, false] }));
            }
            slotN++;
        }
    }
    exh.agendas[key] = filas; exhPoblarAnios();
    exhReg('Generar', `Agenda de exhibidores de ${MESES[m - 1]} ${a}`);
    exhRenderTodo();
    mostrarToast(faltas ? `Agenda generada. ${faltas} exhibidor(es) quedaron incompletos por falta de participantes disponibles.` : 'Agenda de exhibidores generada', faltas ? 'error' : undefined);
}

// ---------- Render de la agenda (por semanas) ----------
function exhSemanasDe(key) { const [a, m] = key.split('-').map(Number), F = exh.agendas[key] || [], mp = new Map(); F.forEach((f, i) => { const k = exhLunes(a, m, f.diaMes); if (!mp.has(k)) mp.set(k, []); mp.get(k).push(i); }); return [...mp.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([lun, idxs]) => ({ lun, idxs })); }
function exhEtiqueta(key, lun) {
    const [a, m] = key.split('-').map(Number), [la, lm, ld] = lun.split('-').map(Number), mon = new Date(la, lm - 1, ld), sab = new Date(la, lm - 1, ld + 5), dias = new Date(a, m, 0).getDate();
    const d1 = (mon.getMonth() + 1 === m && mon.getFullYear() === a) ? mon.getDate() : 1, d2 = (sab.getMonth() + 1 === m && sab.getFullYear() === a) ? sab.getDate() : dias;
    return d1 === d2 ? `SEMANA DEL ${d1} DE ${MESES[m - 1].toUpperCase()} DE ${a}` : `SEMANA DEL ${d1} AL ${d2} DE ${MESES[m - 1].toUpperCase()} DE ${a}`;
}
function exhHtmlSemanas(key, o) {
    o = o || {}; const F = exh.agendas[key] || [], ws = exhSemanasDe(key), edit = !!o.edit && !lectura, q = norm(o.q || '').trim().split(/\s+/).filter(Boolean);
    const npuntos = {}; F.forEach(f => { const k = f.diaMes + '|' + f.turno; npuntos[k] = (npuntos[k] || 0) + 1; });
    let out = '';
    ws.forEach((w, wi) => {
        if (o.solo != null && o.solo !== wi) return;
        const idxs = w.idxs.filter(i => { if (!q.length) return true; const f = F[i], tx = norm(`${DIAS_LARGOS[f.diaSemana]} ${f.diaSemana} ${f.diaMes} ${f.hora} ${f.lugar} ${(f.parts || []).join(' ')} ${f.motivo || ''}`); return q.every(x => tx.includes(x)); });
        if (!idxs.length) return;
        let filasHtml = '', j = 0;
        while (j < idxs.length) {
            const dm = F[idxs[j]].diaMes; let n = 0; while (j + n < idxs.length && F[idxs[j + n]].diaMes === dm) n++;
            for (let r = 0; r < n; r++) {
                const i = idxs[j + r], f = F[i];
                const dayCell = r === 0 ? `<td class="exh-dia" rowspan="${n}"><b>${esc(DIAS_LARGOS[f.diaSemana])}</b><span>${f.diaMes}</span></td>` : '';
                if (f.bloqueado) { filasHtml += `<tr>${dayCell}<td class="exh-hora">${esc(f.hora)}</td><td colspan="4" class="exh-bloq">${esc(f.motivo || 'Predicación de grupos')}</td></tr>`; continue; }
                const multi = npuntos[f.diaMes + '|' + f.turno] > 1;
                let cel = '';
                for (let pos = 0; pos < 3; pos++) {
                    const nom = f.parts[pos] || '', ch = edit ? exhChoques(key, f, pos) : [], rojo = ch.filter(x => x.t === 'choque'), av = ch.filter(x => x.t === 'aviso');
                    const ico = ch.length ? `<span class="exh-ico no-export" title="${esc(ch.map(x => x.msg).join(' · '))}" role="img" aria-label="${esc(ch.map(x => x.msg).join(' · '))}">${IC.aviso}</span>` : '';
                    cel += `<td class="exh-p${edit ? ' edit' : ''}${rojo.length ? ' choque' : av.length ? ' aviso' : ''}${nom ? '' : ' vacio'}"${edit ? ` onclick="exhAbrirSel('${key}',${i},${pos},'todos')"` : ''}>${nom ? esc(nom) : 'Sin asignar'}${ico}</td>`;
                }
                filasHtml += `<tr>${dayCell}<td class="exh-hora">${esc(f.hora)}</td><td class="exh-lug${edit ? ' edit' : ''}"${edit ? ` onclick="exhAbrirLugar('${key}',${i})"` : ''}>${esc(f.lugar || 'Por definir')}${multi ? `<small>Punto ${f.punto}</small>` : ''}</td>${cel}</tr>`;
            }
            j += n;
        }
        out += `<section class="exh-semana"><div class="exh-sem-head">${esc(exhEtiqueta(key, w.lun))}</div><table class="exh-table"><thead><tr><th>Día</th><th>Horario</th><th>Lugar</th><th>Participante 1</th><th>Participante 2</th><th>Participante 3</th></tr></thead><tbody>${filasHtml}</tbody></table><div class="exh-pautas">${EXH_PAUTAS.map(x => `<div>${esc(x)}</div>`).join('')}</div></section>`;
    });
    return out;
}
function exhLimpiarBusca() { const e = document.getElementById('exhBusca'); if (e) e.value = ''; exhRenderAgenda(); }
function exhRenderAgenda() {
    const cont = document.getElementById('exhSemanas'); if (!cont) return;
    const key = exhKey(), F = exh.agendas[key] || [], q = (document.getElementById('exhBusca') || {}).value || '';
    document.getElementById('exhResultado').classList.toggle('hidden', !F.length);
    document.getElementById('exhVacio').classList.toggle('hidden', !!F.length);
    const html = exhHtmlSemanas(key, { edit: true, q });
    cont.innerHTML = html || '<p class="hint" style="padding:12px">Ningún turno coincide con la búsqueda.</p>';
    const info = document.getElementById('exhBuscaInfo'); if (info) info.textContent = q.trim() ? `Filtrando por: "${q.trim()}"` : `${F.filter(f => !f.bloqueado).length} exhibidor(es) en el mes`;
}

// ---------- Selector de participante / lugar ----------
let exhSel = null;
function exhAbrirSel(key, idx, pos, modo) {
    const f = (exh.agendas[key] || [])[idx]; if (!f || f.bloqueado) return;
    if (modo === 'todos' && lectura) return;
    exhSel = { tipo: 'part', key, idx, pos, modo };
    document.getElementById('exhSelTitulo').textContent = modo === 'libres' ? 'Sustituir participante (sin choques)' : 'Cambiar participante';
    document.getElementById('exhSelSub').textContent = `${DIAS_LARGOS[f.diaSemana]} ${f.diaMes} · ${f.hora} · ${f.lugar || 'Por definir'}`;
    document.getElementById('exhSelBusca').value = ''; exhRenderSel(); openModal('modalExhSel');
}
function exhAbrirLugar(key, idx) {
    const f = (exh.agendas[key] || [])[idx]; if (!f || f.bloqueado || lectura) return;
    exhSel = { tipo: 'lugar', key, idx };
    document.getElementById('exhSelTitulo').textContent = 'Cambiar lugar';
    document.getElementById('exhSelSub').textContent = `${DIAS_LARGOS[f.diaSemana]} ${f.diaMes} · ${f.hora}`;
    document.getElementById('exhSelBusca').value = ''; exhRenderSel(); openModal('modalExhSel');
}
function exhEvaluar(p, key, f) {
    const n = exhNom(p), tel = exhTel(p.telefono), iso = exhIsoFila(key, f), motivos = [];
    if (p.estado === 'pausa') motivos.push('En pausa');
    else if (!exhDispo(p, f.diaSemana, exhBloqueHora(f.hora), iso)) motivos.push('Sin disponibilidad en ese horario');
    if (exhEnGrupos(n, tel, iso)) motivos.push('Choque: ya tiene turno en Predicación de Grupos ese día');
    const e = exhEnExh(n, tel, iso, f); if (e) motivos.push('Choque: ya está en otro exhibidor ese día');
    if (f.parts.some(x => x && exhNk(x) === exhNk(n))) motivos.push('Ya está en este exhibidor');
    return motivos;
}
function exhRenderSel() {
    if (!exhSel) return; const { key, idx } = exhSel, f = (exh.agendas[key] || [])[idx]; if (!f) return;
    const q = norm(document.getElementById('exhSelBusca').value).trim(), lista = document.getElementById('exhSelLista');
    if (exhSel.tipo === 'lugar') {
        const slot = f.diaSemana + '-' + f.turno, L = exh.lugares.map((l, i) => ({ l, i, ok: (l.dias || []).includes(slot) })).filter(x => !q || norm(x.l.nombre).includes(q)).sort((a, b) => (b.ok - a.ok) || a.l.nombre.localeCompare(b.l.nombre, 'es'));
        lista.innerHTML = L.map(x => `<div class="group-card"><div><strong>${esc(x.l.nombre)}</strong>${x.l.nombre === f.lugar ? ' <span class="tag">Actual</span>' : ''}<br><small>${x.ok ? 'Permitido en este día y turno' : 'No está habilitado para este día y turno'}</small></div><div><button type="button" class="btn-edit-outline" onclick="exhElegirLugar(${x.i})">Elegir</button></div></div>`).join('') || '<p class="hint">Sin lugares registrados.</p>';
        return;
    }
    const { mes, sem } = exhConteos(), lunF = exhLunes(...key.split('-').map(Number), f.diaMes);
    let L = exh.participantes.map((p, i) => ({ p, i, mot: exhEvaluar(p, key, f) })).filter(x => !q || norm(exhNom(x.p)).includes(q));
    if (exhSel.modo === 'libres') L = L.filter(x => !x.mot.length);
    L.sort((a, b) => (a.mot.length - b.mot.length) || ((mes[exhNk(exhNom(a.p))] || 0) - (mes[exhNk(exhNom(b.p))] || 0)) || exhNom(a.p).localeCompare(exhNom(b.p), 'es'));
    const quitar = exhSel.modo === 'todos' && !q ? `<div class="group-card"><div><strong>Sin asignar</strong></div><button type="button" class="btn-edit-outline" onclick="exhElegirPart(-1)">Quitar</button></div>` : '';
    lista.innerHTML = quitar + (L.map(x => { const nk = exhNk(exhNom(x.p)); return `<div class="group-card"><div><strong>${esc(exhNom(x.p))}</strong>${x.p.estado === 'pausa' ? ' <span class="tag pausa">En pausa</span>' : ''}<br><small>${x.mot.length ? esc(x.mot.join(' · ')) : 'Libre en este horario'} · ${mes[nk] || 0} turno(s) en el mes</small></div><div><button type="button" class="btn-edit-outline" onclick="exhElegirPart(${x.i})">Asignar</button></div></div>`; }).join('') || '<p class="hint">Sin participantes que cumplan las condiciones (sin choques).</p>');
}
function exhElegirLugar(li) {
    const { key, idx } = exhSel, F = exh.agendas[key], f = F[idx], l = exh.lugares[li]; if (!f || !l) return;
    const ant = f.lugar; f.lugar = l.nombre;
    const rep = F.filter(x => x !== f && !x.bloqueado && x.diaMes === f.diaMes && x.turno === f.turno && x.lugar === l.nombre).length;
    closeModal('modalExhSel'); exhReg('Editar', `Lugar: "${ant}" → "${f.lugar}" (día ${f.diaMes})`); exhRenderAgenda();
    if (rep >= 1) mostrarToast(`Aviso: ${l.nombre} ya tiene un exhibidor ese día y turno (cada punto funciona con 1 exhibidor).`, 'error');
}
function exhElegirPart(pi) {
    const { key, idx, pos } = exhSel, f = exh.agendas[key][idx], p = pi >= 0 ? exh.participantes[pi] : null; if (!f) return;
    const ant = f.parts[pos]; f.parts[pos] = p ? exhNom(p) : ''; f.avis[pos] = false; f.conf[pos] = false;
    closeModal('modalExhSel');
    exhReg('Editar', `Participante: "${ant || 'Sin asignar'}" → "${f.parts[pos] || 'Sin asignar'}" (${DIAS_LARGOS[f.diaSemana]} ${f.diaMes}, ${f.hora})`);
    exhRenderTodo();
    const ch = p ? exhChoques(key, f, pos).filter(x => x.t === 'choque') : [];
    if (ch.length) mostrarToast('Choque: ' + ch.map(x => x.msg).join(' · '), 'error');
}

// ---------- Contactar (2 días, agrupado por turno) ----------
function exhItemsContacto() {
    const hoy = new Date(), items = [], ahoraMin = hoy.getHours() * 60 + hoy.getMinutes();
    [0, 1].forEach(off => {
        const dt = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + off), key = `${dt.getFullYear()}-${dt.getMonth() + 1}`;
        (exh.agendas[key] || []).forEach((f, i) => { if (!f.bloqueado && f.diaMes === dt.getDate() && (f.parts || []).some(Boolean) && (off === 1 || exhEstadoTurno(f, ahoraMin) !== 'fin')) items.push({ key, i, f, dt }); });
    });
    return items.sort((x, y) => (x.dt - y.dt) || (hMin(exhIniHora(x.f.hora)) - hMin(exhIniHora(y.f.hora))));
}
const exhIniHora = h => { const m = /\d{1,2}:\d{2}\s*(AM|PM)/i.exec(String(h || '')); return m ? m[0] : '12:00 AM'; };
function exhMensaje(p, f, key) {
    const m = +key.split('-')[1], comp = f.parts.filter(x => x && exhNk(x) !== exhNk(exhNom(p)));
    return `¡Hola ${exhGenero(p) === 'F' ? 'hermana' : 'hermano'} ${p.nombre}! ¿Cómo estás? Este mensaje es para notificarte que tienes el privilegio de participar en la predicación con exhibidor el ${DIAS_LARGOS[f.diaSemana].toLowerCase()} ${f.diaMes} de ${MESES[m - 1].toLowerCase()}, en el horario de ${f.hora}. El lugar de encuentro será en ${f.lugar || 'por definir'}.${comp.length ? ' Te acompañarán: ' + comp.join(', ') + '.' : ''} Recuerda llegar 10 minutos antes de la hora pautada. ¿Podrías confirmarme si vas a asistir? Estaré atento a tu respuesta. ¡Muchas gracias!`;
}
function exhRenderContactos() {
    const cont = document.getElementById('exhContactos'); if (!cont) return;
    const L = exhItemsContacto();
    exhActualizarBadge(L);
    if (!L.length) { cont.innerHTML = '<p class="hint">No hay exhibidores en curso ni próximos para hoy y mañana.</p>'; return; }
    cont.innerHTML = exhBannerUrg(L) + L.map(x => {
        const f = x.f, m = x.dt.getMonth();
        const filas = f.parts.map((n, pos) => {
            if (!n) return `<div class="exh-card-p"><span class="hint">Participante ${pos + 1}: sin asignar</span> <button type="button" class="btn-outline mini" onclick="exhAbrirSel('${x.key}',${x.i},${pos},'libres')">Asignar</button></div>`;
            const p = exhPartPorNombre(n), ch = exhChoques(x.key, f, pos).filter(c => c.t === 'choque');
            const chk = f.conf[pos] ? `<span class="chk ok" title="Confirmado">${IC.checkAll}</span>` : (f.avis[pos] ? `<span class="chk" title="Avisado">${IC.check}</span>` : '');
            const pendTag = !f.conf[pos] ? ` <span class="tag">${f.avis[pos] ? 'Por confirmar' : 'Por avisar'}</span>` : '';
            const tag = ch.length ? ` <span class="tag alerta" title="${esc(ch.map(c => c.msg).join(' · '))}" style="background:var(--red-container);color:var(--red)">Choque</span>` : '';
            const sinTel = !p || !telefonoValido(p) ? ' <span class="tag sin-tel">Sin teléfono válido</span>' : '';
            return `<div class="exh-card-p"><strong>${esc(n)}</strong> ${chk}${pendTag}${tag}${sinTel}
                    <div class="contact-actions">
                        <button type="button" class="btn-whatsapp" onclick="exhWhatsApp('${x.key}',${x.i},${pos})">WhatsApp</button>
                        <button type="button" class="btn-outline mini" onclick="exhCopiarMsg('${x.key}',${x.i},${pos})">Copiar</button>
                        <button type="button" class="btn-outline mini conf${f.conf[pos] ? ' on' : ''}" onclick="exhConfirmar('${x.key}',${x.i},${pos})">${f.conf[pos] ? IC.checkAll : IC.check}<span>Confirmado</span></button>
                        <button type="button" class="btn-outline mini" onclick="exhAbrirSel('${x.key}',${x.i},${pos},'libres')">Sustituir</button>
                    </div></div>`;
        }).join('');
        return `<div class="exh-card"><div class="exh-card-head"><b>${esc(DIAS_LARGOS[f.diaSemana])} ${f.diaMes} de ${MESES[m].toLowerCase()}</b><small>${esc(f.hora)}</small><small>Lugar: ${esc(f.lugar || 'Por definir')}</small></div>${filas}</div>`;
    }).join('');
}
function exhWhatsApp(key, i, pos) {
    const f = exh.agendas[key][i], p = exhPartPorNombre(f.parts[pos]);
    if (!p) return mostrarToast(`${f.parts[pos]} no está registrado en Participantes; no se puede abrir WhatsApp.`, 'error');
    if (!telefonoValido(p)) return mostrarToast(`${exhNom(p)} no tiene un teléfono válido guardado. Edítalo en Participantes con formato internacional (ej. +58 414 1234567).`, 'error');
    window.open(waUrl(limpiarTelefono(p.telefono).replace('+', ''), exhMensaje(p, f, key)), '_blank', 'noopener');
    f.avis[pos] = true; guardarLocal(); exhRenderContactos();
}
async function exhCopiarMsg(key, i, pos) {
    const f = exh.agendas[key][i], p = exhPartPorNombre(f.parts[pos]); if (!p) return mostrarToast('Participante no registrado.', 'error');
    if (await copiar(exhMensaje(p, f, key))) { mostrarToast('Mensaje copiado al portapapeles'); f.avis[pos] = true; guardarLocal(); exhRenderContactos(); } else mostrarToast('No se pudo copiar el texto', 'error');
}
function exhConfirmar(key, i, pos) { if (_bloqueadoLector()) return; const f = exh.agendas[key][i]; f.conf[pos] = !f.conf[pos]; if (f.conf[pos]) f.avis[pos] = true; guardarLocal(); exhRenderContactos(); }

// ---------- Participantes ----------
function exhConteos() {
    const key = exhKey(), h = new Date(), lunHoy = exhLunes(h.getFullYear(), h.getMonth() + 1, h.getDate()), mes = {}, sem = {};
    Object.keys(exh.agendas).forEach(k => { const [ka, km] = k.split('-').map(Number); (exh.agendas[k] || []).forEach(f => { if (f.bloqueado) return; const w = exhLunes(ka, km, f.diaMes); (f.parts || []).forEach(n => { if (!n) return; const nk = exhNk(n); if (k === key) mes[nk] = (mes[nk] || 0) + 1; if (w === lunHoy) sem[nk] = (sem[nk] || 0) + 1; }); }); });
    return { mes, sem };
}
function exhRenderPart() {
    const cont = document.getElementById('exhListaPart'); if (!cont) return;
    const q = norm((document.getElementById('exhBuscaPart') || {}).value), { mes, sem } = exhConteos();
    const L = exh.participantes.map((p, i) => ({ p, i })).filter(x => !q || norm(`${exhNom(x.p)} ${x.p.telefono}`).includes(q)).sort((a, b) => exhNom(a.p).localeCompare(exhNom(b.p), 'es'));
    cont.innerHTML = L.map(({ p, i }) => {
        const d = p.disp || [], on = x => d.some(y => y.startsWith(x + '-')), nk = exhNk(exhNom(p));
        const circ = EXH_DIAS.map((x, j) => `<i class="${on(x) ? 'on' : ''}" title="${DIAS_LARGOS[x]}">${'LMMJVSD'[j]}</i>`).join('');
        return `<div class="group-card"><div><strong>${esc(exhNom(p))}</strong> <span class="tag">${exhGenero(p) === 'F' ? 'Hermana' : 'Hermano'}</span>${p.vinc ? ' <span class="tag prox" title="Vinculado con un conductor de Predicación por grupos">Vinculado</span>' : ''}${p.estado === 'pausa' ? ' <span class="tag pausa">En pausa</span>' : ''}<br><small>${esc(p.telefono || '')}</small><div class="dias-mini">${circ}</div><small>Esta semana: <b>${sem[nk] || 0}</b> · ${MESES[exhMes() - 1]}: <b>${mes[nk] || 0}</b> participación(es)</small></div>
                <div class="row-actions"><button type="button" class="btn-edit-outline icon-btn" title="${p.estado === 'pausa' ? 'Activar' : 'Pausar'}" aria-label="${p.estado === 'pausa' ? 'Activar' : 'Pausar'}" onclick="exhAlternarPart(${i})">${p.estado === 'pausa' ? IC.play : IC.pausa}</button><button type="button" class="btn-edit-outline icon-btn" title="Editar" aria-label="Editar" onclick="exhAbrirPart(${i})">${IC.edit}</button><button type="button" class="btn-edit-outline icon-btn" title="Eliminar" aria-label="Eliminar" onclick="exhEliminarPart(${i})">${IC.trash}</button></div></div>`;
    }).join('') || '<p class="hint">Aún no hay participantes. Pulsa «Añadir participante».</p>';
}
let exhTmp = { extra: [], no: [] };
function exhAbrirPart(i) {
    const p = i >= 0 ? exh.participantes[i] : null;
    document.getElementById('epIdx').value = i; document.getElementById('epTitulo').textContent = p ? 'Editar participante' : 'Nuevo participante';
    document.getElementById('epNombre').value = p ? p.nombre : ''; document.getElementById('epApellido').value = p ? p.apellido : '';
    document.getElementById('epTel').value = p ? (p.telefono || '+58 ') : '+58 '; document.getElementById('epGenero').value = p ? exhGenero(p) : 'M'; document.getElementById('epEstado').value = p ? (p.estado || 'activo') : 'activo';
    document.getElementById('epDisp').innerHTML = EXH_DIAS.map(d => `<div class="day-row"><span class="chip-button" style="pointer-events:none">${DIAS_LARGOS[d]}</span><div class="time-options">${['AM', 'PM'].map(b => `<label class="chip-button"><input type="checkbox" value="${d}-${b}"${p && (p.disp || []).includes(d + '-' + b) ? ' checked' : ''}> ${b}</label>`).join('')}</div></div>`).join('');
    exhTmp = { extra: p ? (p.extraDisp || []).slice() : [], no: p ? (p.noDisp || []).slice() : [] }; exhChips(); vincReset('P'); openModal('modalExhPart');
}
function exhChips() {
    const mk = (arr, t) => arr.map((f, i) => `<span class="tag" title="Quitar" onclick="exhQuitarFecha('${t}',${i})">${esc(fCorta(f))} &times;</span>`).join('');
    document.getElementById('epChipsDisp').innerHTML = mk(exhTmp.extra, 'extra'); document.getElementById('epChipsNo').innerHTML = mk(exhTmp.no, 'no');
}
function exhAddFecha(t) {
    const e = document.getElementById(t === 'extra' ? 'epFechaDisp' : 'epFechaNo'), v = e.value; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return mostrarToast('Elige una fecha válida', 'error');
    if (!exhTmp[t].includes(v)) exhTmp[t].push(v); exhTmp[t].sort(); e.value = ''; exhChips();
}
function exhQuitarFecha(t, i) { exhTmp[t].splice(i, 1); exhChips(); }
async function exhGuardarPart(e) { if (_bloqueadoLector()) return;
    e.preventDefault(); if (!antiDoble(e)) return;
    const i = parseInt(document.getElementById('epIdx').value, 10), nombre = sanearTexto(document.getElementById('epNombre').value), apellido = sanearTexto(document.getElementById('epApellido').value), tel = limpiarTelefono(document.getElementById('epTel').value);
    if (!nombre || !apellido) return mostrarToast('Escribe nombre y apellido', 'error');
    const p = { nombre, apellido, telefono: tel || '', genero: document.getElementById('epGenero').value, estado: document.getElementById('epEstado').value, disp: [...document.querySelectorAll('#epDisp input:checked')].map(x => x.value), extraDisp: exhTmp.extra.slice(), noDisp: exhTmp.no.slice() };
    const dup = exh.participantes.findIndex((x, j) => j !== i && exhNk(exhNom(x)) === exhNk(exhNom(p))); if (dup >= 0) return mostrarToast('Ya existe un participante con ese nombre', 'error');
    const vinc = await vincAlGuardar('P', p, i >= 0 ? exh.participantes[i] : null);
    if (i >= 0) { const ant = exhNom(exh.participantes[i]); exh.participantes[i] = p; if (ant !== exhNom(p)) Object.values(exh.agendas).forEach(R => R.forEach(f => { f.parts = (f.parts || []).map(n => n === ant ? exhNom(p) : n); })); exhReg('Editar', `Participante ${exhNom(p)}`); }
    else { exh.participantes.push(p); exhReg('Añadir', `Participante ${exhNom(p)}`); }
    if (vinc.otro) { vincSincronizar('P', p, vinc.otro); registrarActividad('Sincronizar', `Conductor ${nomC(vinc.otro)} actualizado desde Exhibidores`); guardarLocal(); renderListaConductores(); }
    closeModal('modalExhPart'); exhRenderTodo();
}
function exhAlternarPart(i) { if (_bloqueadoLector()) return; const p = exh.participantes[i]; p.estado = p.estado === 'pausa' ? 'activo' : 'pausa'; exhReg('Editar', `${exhNom(p)}: ${p.estado === 'pausa' ? 'En pausa' : 'Activo'}`); exhRenderPart(); }
async function exhEliminarPart(i) { if (_bloqueadoLector()) return;
    const p = exh.participantes[i]; if (!(await confirmar(`¿Eliminar a ${exhNom(p)}? Las agendas ya generadas conservarán su nombre.`, 'Eliminar'))) return;
    exh.participantes.splice(i, 1); exhReg('Eliminar', `Participante ${exhNom(p)}`); exhRenderTodo();
}

// ---------- Lugares ----------
function exhRenderLug() {
    const cont = document.getElementById('exhListaLug'); if (!cont) return;
    cont.innerHTML = exh.lugares.map((l, i) => {
        const dias = EXH_DIAS.map(d => { const ts = exh.config.turnos.filter(t => (l.dias || []).includes(d + '-' + t.id)).map(t => t.nombre); return ts.length ? `${DIAS_LARGOS[d].slice(0, 3)} (${ts.join('/')})` : ''; }).filter(Boolean).join(' · ') || 'Sin días asignados';
        return `<div class="group-card"><div><strong>${esc(l.nombre)}</strong> <span class="tag">1 exhibidor por turno</span><br><small>${esc(dias)}</small></div><div class="row-actions"><button type="button" class="btn-edit-outline icon-btn" title="Editar" aria-label="Editar" onclick="exhAbrirLug(${i})">${IC.edit}</button><button type="button" class="btn-edit-outline icon-btn" title="Eliminar" aria-label="Eliminar" onclick="exhEliminarLug(${i})">${IC.trash}</button></div></div>`;
    }).join('') || '<p class="hint">Aún no hay lugares. Pulsa «Añadir lugar».</p>';
}
function exhAbrirLug(i) {
    const l = i >= 0 ? exh.lugares[i] : null;
    document.getElementById('elIdx').value = i; document.getElementById('elTitulo').textContent = l ? 'Editar lugar' : 'Nuevo lugar';
    document.getElementById('elNombre').value = l ? l.nombre : '';
    document.getElementById('elDias').innerHTML = EXH_DIAS.map(d => `<div class="day-row"><span class="chip-button" style="pointer-events:none">${DIAS_LARGOS[d]}</span><div class="time-options">${exh.config.turnos.map(t => { const v = d + '-' + t.id, chk = l ? (l.dias || []).includes(v) : (t.puntos[d] | 0) > 0; return `<label class="chip-button"><input type="checkbox" value="${v}"${chk ? ' checked' : ''}> ${esc(t.nombre)}</label>`; }).join('')}</div></div>`).join('');
    openModal('modalExhLug');
}
function exhGuardarLug(e) { if (_bloqueadoLector()) return;
    e.preventDefault(); if (!antiDoble(e)) return;
    const i = parseInt(document.getElementById('elIdx').value, 10), nombre = sanearTexto(document.getElementById('elNombre').value); if (!nombre) return mostrarToast('Escribe el nombre del lugar', 'error');
    if (exh.lugares.some((x, j) => j !== i && norm(x.nombre) === norm(nombre))) return mostrarToast('Ya existe un lugar con ese nombre', 'error');
    const l = { nombre, simult: 1, dias: [...document.querySelectorAll('#elDias input:checked')].map(x => x.value) };
    aislarLugares('exh', () => {
        if (i >= 0) { const ant = exh.lugares[i].nombre; exh.lugares[i] = l; if (ant !== nombre) Object.values(exh.agendas).forEach(R => R.forEach(f => { if (f.lugar === ant) f.lugar = nombre; })); exhReg('Editar', `Lugar ${nombre}`); } else { exh.lugares.push(l); exhReg('Añadir', `Lugar ${nombre}`); }
    });
    closeModal('modalExhLug'); exhRenderTodo();
}
async function exhEliminarLug(i) { if (_bloqueadoLector()) return; const l = exh.lugares[i]; if (!(await confirmar(`¿Eliminar el lugar «${l.nombre}»?`, 'Eliminar'))) return; aislarLugares('exh', () => { exh.lugares.splice(i, 1); }); exhReg('Eliminar', `Lugar ${l.nombre}`); exhRenderLug(); }

// ---------- Actividad ----------
function exhRenderAct() {
    const cont = document.getElementById('exhListaAct'); if (!cont) return; cont.innerHTML = '';
    if (!exh.actividad.length) { cont.innerHTML = '<p style="color:var(--text-sub);font-size:.9rem;font-weight:500">No hay actividad registrada aún.</p>'; return; }
    exh.actividad.forEach(a => { const it = document.createElement('div'); it.className = 'historial-item'; const s = document.createElement('strong'); s.textContent = String(a.accion ?? ''); const c = document.createElement('small'); c.textContent = String(a.fecha ?? ''); it.append(s, document.createTextNode(': ' + String(a.detalle ?? '') + ' '), c); cont.appendChild(it); });
}
async function exhBorrarAct() { if (_bloqueadoLector()) return; if (!exh.actividad.length || !(await confirmar(`¿Borrar todo el historial de actividad de Exhibidores?\n\n✖ Se eliminarán ${exh.actividad.length} registro(s). Las agendas no se modifican.`, 'Borrar'))) return; exh.actividad = []; guardarLocal(); exhRenderAct(); }

// ---------- Copia de seguridad (historial) del mes ----------
function exhGuardarHist() { if (_bloqueadoLector()) return; const k = exhKey(); if (!(exh.agendas[k] || []).length) return mostrarToast('Primero genera la agenda del mes.', 'error'); exh.historial[k] = { fecha: new Date().toLocaleString('es-VE'), filas: clonar(exh.agendas[k]) }; exhReg('Guardar', `Copia de exhibidores de ${MESES[exhMes() - 1]} ${exhAnio()}`); mostrarToast('Copia guardada'); }
async function exhCargarHist() { if (_bloqueadoLector()) return; const k = exhKey(), h = exh.historial[k]; if (!h) return mostrarToast('No hay una copia guardada para este mes.', 'error'); if (!(await confirmar(`Restaurar la copia guardada el ${h.fecha}?\n\n✖ Se reemplazará: ${exhResumenImpacto(exh.agendas[k])}.\n✔ Se cargará la copia: ${exhResumenImpacto(h.filas)}. (En exhibidores no hay candados.)`, 'Restaurar'))) return; exh.agendas[k] = clonar(h.filas); exhReg('Restaurar', `Copia de exhibidores de ${MESES[exhMes() - 1]} ${exhAnio()}`); exhRenderTodo(); }

// ---------- Configuración de horarios ----------
function exhPoblarCfg() {
    const box = document.getElementById('cfgExhBox'); if (!box) return;
    box.innerHTML = exh.config.turnos.map((t, ti) => `<div class="exh-cfg-t"><b>Turno ${esc(t.nombre.toLowerCase())}</b><input type="text" value="${esc(t.hora)}" placeholder="9:00 AM a 11:00 AM" onchange="exhCfgHora(${ti},this.value)" style="margin-top:8px"><div class="exh-cfg-dias">${EXH_DIAS.map(d => `<label>${d}<select onchange="exhCfgPuntos(${ti},'${d}',this.value)">${[0, 1, 2, 3].map(n => `<option value="${n}"${(t.puntos[d] | 0) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`).join('')}</div></div>`).join('')
        + `<div style="margin-top:12px"><button type="button" class="btn-outline" onclick="exhCfgRestablecer()">Restablecer horarios de exhibidores</button></div>`;
}
function exhCfgHora(ti, v) { v = sanearTexto(v); if (!/\d{1,2}:\d{2}\s*(AM|PM)/i.test(v)) { mostrarToast('Usa un formato como 9:00 AM a 11:00 AM', 'error'); return exhPoblarCfg(); } exh.config.turnos[ti].hora = v; guardarLocal(); actualizarContadores(); avisarCambioReglas('exh'); mostrarToast('Horario guardado'); }
function exhCfgPuntos(ti, d, v) { exh.config.turnos[ti].puntos[d] = parseInt(v, 10) || 0; guardarLocal(); actualizarContadores(); avisarCambioReglas('exh'); }
function exhCfgRestablecer() { exh.config = exhConfigDef(); guardarLocal(); exhPoblarCfg(); actualizarContadores(); avisarCambioReglas('exh'); mostrarToast('Horarios de exhibidores restablecidos'); }

// ---------- Exportación: PNG, PDF, CSV, resumen WhatsApp ----------
function exhTituloApp() { return (config.titulo || '').trim() || defConfig().titulo; }
function exhConstruirExport(key, solo) {
    const [a, m] = key.split('-').map(Number), w = document.createElement('div');
    w.id = 'exhExportar'; w.className = 'exh-export'; w.style.cssText = 'position:fixed;left:-12000px;top:0;width:900px;background:#fff;padding:24px';
    w.innerHTML = `<div class="exh-exp-head"><div class="export-app">${esc(exhTituloApp())}</div><h2>Predicación con Exhibidores</h2><p>${MESES[m - 1]} ${a}</p><div class="export-bar"></div></div>${exhHtmlSemanas(key, { edit: false, solo })}`;
    purgarContactoDOM(w); document.body.appendChild(w); return w;
}
function exhAbrirDescarga() {
    const key = exhKey(), ws = exhSemanasDe(key); if (!ws.length) return mostrarToast('Primero genera la agenda del mes.', 'error');
    const c = document.getElementById('exhOpcDescarga'); c.innerHTML = '';
    ws.forEach((w, i) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'download-option'; b.innerHTML = `<span>Semana ${i + 1}</span><small>${esc(exhEtiqueta(key, w.lun).replace('SEMANA DEL ', 'Del '))}</small>`; b.onclick = () => exhPNG(i); c.appendChild(b); });
    const f = document.createElement('button'); f.type = 'button'; f.className = 'download-option full'; f.innerHTML = '<span>Mes completo</span><small>Todas las semanas</small>'; f.onclick = () => exhPNG(null); c.appendChild(f);
    openModal('modalExhDescarga');
}
async function exhPNG(solo) {
    closeModal('modalExhDescarga'); const key = exhKey(), [a, m] = key.split('-').map(Number); mostrarToast('Generando imagen...');
    const el = exhConstruirExport(key, solo);
    try {
        await document.fonts.ready;
        const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', logging: false, windowWidth: 1000, onclone: doc => {
            doc.documentElement.setAttribute('data-theme', 'light'); doc.documentElement.style.setProperty('--zoom', '1'); doc.documentElement.removeAttribute('data-densidad');
            const e = doc.getElementById('exhExportar'); e.style.left = '0'; e.style.position = 'absolute';
            e.querySelectorAll('.no-export').forEach(x => x.remove());
            const st = doc.createElement('style'); st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; doc.head.appendChild(st);
        } });
        const l = document.createElement('a'); l.download = `Exhibidores-${pad(m)}-${a}-${solo == null ? 'mes-completo' : 'semana-' + (solo + 1)}.png`; l.href = canvas.toDataURL('image/png'); l.click();
        exhReg('Descargar', `Imagen de exhibidores (${solo == null ? 'mes completo' : 'semana ' + (solo + 1)})`);
    } catch (err) { mostrarToast('No se pudo generar la imagen. Inténtalo de nuevo.', 'error'); }
    el.remove();
}
function exhPDF() {
    const key = exhKey(); if (!(exh.agendas[key] || []).length) return mostrarToast('Primero genera la agenda del mes.', 'error');
    const [a, m] = key.split('-').map(Number), w = window.open('', '_blank'); if (!w) return mostrarToast('Permite las ventanas emergentes para exportar el PDF', 'error');
    const css = cssDeLaApp();
    w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Exhibidores ${esc(MESES[m - 1])} ${a}</title><style>${css}
            @page{size:letter;margin:12mm}html,body{background:#fff!important;margin:0;color:#1f1f1f}body{zoom:1;padding:0}*{animation:none!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
            .exh-table{min-width:0!important;font-size:.78rem}.exh-table td{padding:7px 9px}.exh-semana{margin-bottom:14px}</style></head><body data-modo="exhibidores"><div class="exh-exp-head"><div class="export-app">${esc(exhTituloApp())}</div><h2>Predicación con Exhibidores</h2><p>${MESES[m - 1]} ${a}</p><div class="export-bar"></div></div>${exhHtmlSemanas(key, { edit: false })}</body></html>`);
    w.document.documentElement.setAttribute('data-theme', 'light');
    w.document.close(); setTimeout(() => { w.focus(); w.print(); }, 500);
    exhReg('Exportar', 'Exhibidores en PDF');
}
function exhCSV() {
    const key = exhKey(), F = exh.agendas[key] || []; if (!F.length) return mostrarToast('Primero genera la agenda del mes.', 'error');
    const [a, m] = key.split('-').map(Number), q = v => `"${sinDatosContacto(v ?? '').replace(/"/g, '""')}"`, rows = [['Semana', 'Día', 'Fecha', 'Horario', 'Lugar', 'Participante 1', 'Participante 2', 'Participante 3']];
    exhSemanasDe(key).forEach(w => w.idxs.forEach(i => { const f = F[i]; rows.push([exhEtiqueta(key, w.lun), DIAS_LARGOS[f.diaSemana], f.diaMes, f.hora, f.bloqueado ? (f.motivo || 'Predicación de grupos') : f.lugar, ...(f.bloqueado ? ['', '', ''] : f.parts)]); }));
    const csv = '\ufeff' + rows.map(r => r.map(q).join(';')).join('\r\n'), l = document.createElement('a');
    l.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); l.download = `Exhibidores-${pad(m)}-${a}.csv`; l.click();
    exhReg('Exportar', 'Exhibidores en CSV (Excel)');
}
function exhAbrirResumen() {
    const key = exhKey(), ws = exhSemanasDe(key); if (!ws.length) return mostrarToast('Primero genera la agenda del mes.', 'error');
    const c = document.getElementById('exhOpcResumen'); c.innerHTML = '';
    ws.forEach((w, i) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'download-option'; b.innerHTML = `<span>Semana ${i + 1}</span><small>${esc(exhEtiqueta(key, w.lun).replace('SEMANA DEL ', 'Del '))}</small>`; b.onclick = () => exhCopiarResumen(i); c.appendChild(b); });
    openModal('modalExhResumen');
}
async function exhCopiarResumen(wi) {
    const key = exhKey(), F = exh.agendas[key] || [], w = exhSemanasDe(key)[wi]; if (!w) return;
    let t = `*PREDICACIÓN CON EXHIBIDORES*\n*${exhEtiqueta(key, w.lun)}*\n`, dia = null;
    w.idxs.forEach(i => {
        const f = F[i]; if (f.diaMes !== dia) { dia = f.diaMes; t += `\n*${DIAS_LARGOS[f.diaSemana]} ${f.diaMes}*\n`; }
        t += f.bloqueado ? `- ${f.hora}: ${f.motivo || 'Predicación de grupos'}\n` : `- ${f.hora} · ${f.lugar || 'Por definir'}: ${f.parts.filter(Boolean).join(', ') || 'Sin asignar'}\n`;
    });
    t += `\n*${EXH_PAUTAS[0]}*\n*${EXH_PAUTAS[1]}*\n*${EXH_PAUTAS[2]}*`;
    closeModal('modalExhResumen');
    if (await copiar(sinDatosContacto(t))) { mostrarToast('Resumen copiado al portapapeles'); exhReg('Copiar', `Resumen semanal de exhibidores (semana ${wi + 1})`); } else mostrarToast('No se pudo copiar el texto', 'error');
}

// =====================================================================
// === MÓDULO 8: ONBOARDING, RENDIMIENTO MÓVIL Y PREVENCIÓN DE ERRORES ===
// =====================================================================
// --- Debounce genérico por clave (búsquedas en vivo y guardado automático de ajustes) ---
var _dbnT = {}, _dbnP = {};
function dbn(k, fn, ...args) {
    _dbnP[k] = { fn, args }; clearTimeout(_dbnT[k]);
    _dbnT[k] = setTimeout(() => flushDeb(k), k.startsWith('save') ? 500 : 200);
}
function flushDeb(k) {   // ejecuta de inmediato lo pendiente (al cerrar un diálogo o salir de la página)
    Object.keys(k ? { [k]: 1 } : _dbnP).forEach(x => { clearTimeout(_dbnT[x]); const p = _dbnP[x]; delete _dbnP[x]; if (p) p.fn(...p.args); });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { flushDeb(); flushSync(); } });
window.addEventListener('pagehide', () => { flushDeb(); flushSync(); });

// --- Conteos para confirmaciones ---
function impactoAgenda(filas) {
    const F = (Array.isArray(filas) ? filas : []).filter(f => f && !f.evento), fij = F.filter(f => f.fijado).length;
    return { total: F.length, fij, rest: F.length - fij, marcas: F.filter(f => !f.fijado && (f.avisado || f.confirmado)).length };
}
function contarFijados(mapa) { return Object.values(mapa || {}).reduce((n, R) => n + impactoAgenda(R).fij, 0); }
function exhResumenImpacto(filas) {
    const F = (Array.isArray(filas) ? filas : []).filter(f => f && !f.bloqueado);
    const asig = F.reduce((n, f) => n + (f.parts || []).filter(Boolean).length, 0), conf = F.reduce((n, f) => n + (f.conf || []).filter(Boolean).length, 0);
    return `${F.length} turno(s) con ${asig} participante(s) asignado(s)${conf ? `, ${conf} ya confirmado(s)` : ''}`;
}

// --- Contactar: resumen de avisos urgentes (hoy y mañana sin confirmar) ---
function bannerUrgentes(lista) {
    const [h] = proximos2(); let hoy = 0, man = 0, urg = 0, sinTel = 0;
    lista.forEach(x => {
        if (!asignado(x.f) || x.f.confirmado) return;
        if (x.d.getDate() === h.getDate() && x.d.getMonth() === h.getMonth()) hoy++; else man++;
        const a = alertaTurno(x); if (a && a.cls !== 'cercano') urg++;
        if (!telefonoValido(conductorDe(x.f))) sinTel++;
    });
    if (!hoy && !man) return '<div class="aviso-urg ok" role="status">✔ Todo confirmado para hoy y mañana.</div>';
    return `<div class="aviso-urg" role="alert"><div class="aviso-txt"><b>⚠ ${hoy + man} turno(s) sin confirmar</b><span>${hoy} hoy · ${man} mañana${urg ? ` · <u>${urg} urgente(s)</u>` : ''}${sinTel ? ` · ${sinTel} sin teléfono válido` : ''}</span></div><button type="button" class="btn-outline mini" onclick="setFiltroContacto('pend')">Ver pendientes</button></div>`;
}
function ordenarUrgentes(v) {
    const p = x => { const a = alertaTurno(x); return a ? (a.cls === 'cercano' ? 1 : 0) : 2; };
    return v.slice().sort((a, b) => p(a) - p(b) || inicioMs(a) - inicioMs(b));
}
function exhBannerUrg(L) {
    const [h] = proximos2(); let hoy = 0, man = 0;
    L.forEach(x => (x.f.parts || []).forEach((n, i) => { if (!n || (x.f.conf || [])[i]) return; if (x.dt.getDate() === h.getDate() && x.dt.getMonth() === h.getMonth()) hoy++; else man++; }));
    if (!hoy && !man) return '<div class="aviso-urg ok" role="status">✔ Todo confirmado para hoy y mañana.</div>';
    return `<div class="aviso-urg" role="alert"><div class="aviso-txt"><b>⚠ ${hoy + man} participante(s) sin confirmar</b><span>${hoy} hoy · ${man} mañana</span></div></div>`;
}

// --- Guía de inicio de 3 pasos (primer acceso en el dispositivo; también desde ¿Cómo usar?) ---
const ONB_KEY = 'vdm_onboarding_visto';
const ONB_PASOS = [
    ['1. Revisa Hoy y Mañana', 'Al abrir la Agenda verás arriba las salidas de hoy y mañana: quién conduce, dónde y a qué hora.'],
    ['2. Filtra o contacta por WhatsApp en un toque', 'Usa el buscador y los filtros para hallar un turno. En Contactar, toca WhatsApp para avisar y Confirmado para marcarlo.'],
    ['3. Genera o fija turnos con candado', 'Genera el mes con un toque. Toca el candado de un turno para fijarlo: se conserva cuando regeneres la agenda.']
];
let _onbPaso = 0;
function mostrarOnboardingSiCorresponde() { let v = false; try { v = localStorage.getItem(ONB_KEY) === '1'; } catch (e) {} if (!v) abrirOnboarding(); }
function abrirOnboarding() { _onbPaso = 0; onbRender(); openModal('modalOnboarding'); }
function onbRender() {
    const p = ONB_PASOS[_onbPaso];
    document.getElementById('onbTitulo').textContent = p[0];
    document.getElementById('onbTxt').textContent = (_onbPaso === 2 && !puedeEditar()) ? 'Tu cuenta es de solo lectura: verás los turnos fijados con candado, pero no podrás cambiarlos.' : p[1];
    document.getElementById('onbInd').innerHTML = ONB_PASOS.map((_, i) => `<i class="${i <= _onbPaso ? 'on' : ''}"></i>`).join('');
    document.getElementById('onbAtras').classList.toggle('hidden', _onbPaso === 0);
    document.getElementById('onbSig').textContent = _onbPaso === ONB_PASOS.length - 1 ? 'Entendido' : 'Siguiente';
}
function onbIr(d) {
    if (_onbPaso + d >= ONB_PASOS.length) { try { localStorage.setItem(ONB_KEY, '1'); } catch (e) {} return onbCerrar(); }
    _onbPaso = Math.max(0, _onbPaso + d); onbRender();
}
function onbCerrar() { closeModal('modalOnboarding'); }
function onbNoMostrar() { try { localStorage.setItem(ONB_KEY, '1'); } catch (e) {} onbCerrar(); mostrarToast('Guía oculta. Siempre puedes verla en ¿Cómo usar?'); }

