/* ==========================================================================
 * supabase.js — Gestión de Territorios Vista Al Mar
 * Conexión con Supabase: configuración del cliente, autenticación (Auth + roles),
 * lectura de la nube y sincronización con control de versión (conflictos, reintentos).
 *
 * Se carga ANTES de app.js (depende de la librería @supabase/supabase-js del <head>).
 * Las funciones de interfaz que se invocan desde aquí (mostrarToast, initApp,
 * actualizarSyncUI, aplicarPayload, etc.) viven en app.js y se resuelven al ejecutarse,
 * nunca al cargar el archivo.
 * ========================================================================== */

// Estado de sesión, rol y versión de datos (compartido con app.js)
let _rol = 'lector', _rolListo = false, _verBase = 0;

const puedeEditar = () => _rol === 'editor';

// El rol vive en app_metadata del JWT (solo editable con service_role, nunca desde el navegador)
function rolDeSesion(ses) { const r = ses && ses.user && ses.user.app_metadata && ses.user.app_metadata.rol; return r === 'editor' ? 'editor' : 'lector'; }

// === MÓDULO 4: SUPABASE AUTH, RLS Y SINCRONIZACIÓN ===
// === SUPABASE ===
// La clave "publishable" es pública por diseño: la protección real la dan Supabase Auth + RLS en public.estado_app.
const SUPABASE_URL = "https://srtoeambotobemygadvy.supabase.co";

const SUPABASE_ANON_KEY = "sb_publishable_w6oz1etGxhF5A2yRVhMFmg_DlViQ1nC";

const supabaseClient = (window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// === AUTENTICACIÓN (Supabase Auth) ===
// _sesionActiva solo es true entre un inicio de sesión válido y el cierre/expiración de la sesión.
// Mientras sea false no se lee, se renderiza ni se guarda nada de estado_app (ni en la nube ni en caché local).
let _sesionActiva = false;

let _appIniciada = false;

const CLAVES_DATOS_LOCALES = ['vdm_data', 'vdm_sync_pendiente'];

function limpiarCacheLocal() {
    try { CLAVES_DATOS_LOCALES.forEach(k => localStorage.removeItem(k)); } catch (e) {}
}

function mostrarErrorAuth(msg) {
    const el = document.getElementById('auth-msg-error');
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
}

function mostrarLogin(mensaje) {
    _sesionActiva = false;
    document.getElementById('app-content').style.display = 'none';
    document.getElementById('auth-overlay').style.display = 'flex';
    document.getElementById('auth-sub').textContent = 'Inicia sesión con tu correo y contraseña';
    document.getElementById('form-auth').classList.remove('hidden');
    mostrarErrorAuth(mensaje || '');
    const em = document.getElementById('auth-email');
    if (em && !em.value) em.focus(); else document.getElementById('auth-pass').focus();
}

async function iniciarSesion(e) {
    if (e) e.preventDefault();
    if (!supabaseClient) { mostrarErrorAuth('No se pudo cargar el servicio de acceso. Revisa tu conexión y recarga la página.'); return; }
    const email = document.getElementById('auth-email').value.trim();
    const passEl = document.getElementById('auth-pass');
    const password = passEl.value;
    if (!email || !password) { mostrarErrorAuth('Escribe tu correo y tu contraseña.'); return; }

    const btn = document.getElementById('auth-submit');
    btn.disabled = true; mostrarErrorAuth('');
    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error || !data || !data.session) {
            const st = error && error.status;
            mostrarErrorAuth(st === 429 ? 'Demasiados intentos. Espera un momento e inténtalo de nuevo.'
                : (st === 400 || st === 401 || st === 422) ? 'Correo o contraseña incorrectos.'
                : 'No se pudo iniciar sesión. Revisa tu conexión e inténtalo de nuevo.');
            passEl.value = '';
            return;
        }
        passEl.value = '';
        desbloquearInterfaz();
    } catch (err) {
        mostrarErrorAuth('No se pudo iniciar sesión. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
        btn.disabled = false;
    }
}

async function desbloquearInterfaz() {
    if (_appIniciada) return;
    _sesionActiva = true; _appIniciada = true;
    let ses = null; try { const r = await supabaseClient.auth.getSession(); ses = r && r.data && r.data.session; } catch (e) {}
    if (!ses) { _sesionActiva = false; _appIniciada = false; limpiarCacheLocal(); mostrarLogin(); return; }
    _rol = rolDeSesion(ses);
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('app-content').style.display = 'block';
    initApp();
}

// Cierra la sesión, borra la caché local con datos y recarga para vaciar toda la memoria de la página
async function cerrarSesion() {
    _sesionActiva = false;
    try { if (supabaseClient) await supabaseClient.auth.signOut({ scope: 'local' }); } catch (e) {}
    limpiarCacheLocal();
    window.location.reload();
}

// Sesión terminada (cierre manual, otra pestaña, token vencido o revocado): bloquear todo de inmediato
function bloquearPorSesionTerminada() {
    _sesionActiva = false;
    limpiarCacheLocal();
    if (_appIniciada) window.location.reload(); else mostrarLogin();
}

async function arrancarAuth() {
    if (!supabaseClient) {
        document.getElementById('auth-sub').textContent = '';
        document.getElementById('form-auth').classList.remove('hidden');
        mostrarErrorAuth('No se pudo cargar el servicio de acceso. Revisa tu conexión y recarga la página.');
        return;
    }
    // Escucha cambios de sesión (callback síncrono: sin llamadas a Supabase dentro)
    supabaseClient.auth.onAuthStateChange((evento, sesion) => {
        if (evento === 'SIGNED_OUT' || (!sesion && _appIniciada)) bloquearPorSesionTerminada();
    });
    let sesion = null;
    try { const r = await supabaseClient.auth.getSession(); sesion = r && r.data && r.data.session; } catch (e) {}
    if (sesion) desbloquearInterfaz();
    else { limpiarCacheLocal(); mostrarLogin(); }
}

window.addEventListener('DOMContentLoaded', arrancarAuth);

async function leerNube() {
    // Devuelve el objeto 'datos' de la fila id=1, o null si no hay nube / no hay datos / falla la red
    if (!supabaseClient || !_sesionActiva) return null;
    try {
        const consulta = supabaseClient.from('estado_app').select('datos').eq('id', 1).maybeSingle();
        const limite = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
        const { data, error } = await Promise.race([consulta, limite]);
        if (error) {
            // Sesión inválida o vencida en el servidor: volver a pedir inicio de sesión
            if (error.status === 401 || error.status === 403 || /jwt/i.test(error.message || '')) bloquearPorSesionTerminada();
            throw error;
        }
        return (data && data.datos && Object.keys(data.datos).length) ? data.datos : null;
    } catch (e) { return null; }
}

// Subida a Supabase en segundo plano (en cola, para que lleguen en orden) con control de versión
let _colaSync = Promise.resolve(), _verSync = 0, _ultAvisoSync = 0, _syncPend = 0, _syncFallo = false, _syncRetryT = null, _syncReintentos = 0, _conflictoAbierto = false, _syncDebT = null;

async function subirConVersion(forzar) {
    const p = payloadCompleto(); p.version = _verBase + 1; p.updated_at = new Date().toISOString();
    const v = validarEstadoApp(p); if (!v.ok) { alertaEstadoInvalido(v.errores); return 'invalido'; }
    if (!forzar && _verBase > 0) {
        // Compara y escribe en una sola operación: solo actualiza si la nube sigue en la versión que leímos
        const { data, error } = await supabaseClient.from('estado_app').update({ datos: p }).eq('id', 1).eq('datos->>version', String(_verBase)).select('id');
        if (error) throw error;
        if (!data || !data.length) return 'conflicto';
    } else {
        if (!forzar) {
            const q = await supabaseClient.from('estado_app').select('ver:datos->>version').eq('id', 1).maybeSingle();
            if (q.error) throw q.error;
            if (q.data && (Number(q.data.ver) || 0) > 0) return 'conflicto';
        }
        const { error } = await supabaseClient.from('estado_app').upsert({ id: 1, datos: p });
        if (error) throw error;
    }
    _verBase = p.version; try { localStorage.setItem('vdm_data', JSON.stringify(p)); } catch (e) {}
    return 'ok';
}

async function resolverConflicto() {
    if (_conflictoAbierto) return; _conflictoAbierto = true;
    try {
        const op = await dialogo('Cambios en la nube', 'Hay cambios más recientes en la nube. ¿Deseas recargar la versión actual o sobrescribir con tus cambios?', [{ t: 'Recargar versión de la nube', v: 'recargar' }, { t: 'Sobrescribir con mis cambios', v: 'sobrescribir', primario: true }]);
        if (!op) { mostrarToast('Sin sincronizar: hay cambios más recientes en la nube.', 'error'); _syncFallo = true; actualizarSyncUI(); return; }
        const nube = await leerNube();
        if (!nube) { _syncFallo = true; mostrarToast('No se pudo leer la nube. Inténtalo de nuevo.', 'error'); return; }
        _verBase = Number(nube.version) || 0;
        if (op === 'recargar') { try { localStorage.removeItem('vdm_sync_pendiente'); } catch (e) {} aplicarPayload(nube, true); mostrarToast('Versión de la nube cargada'); }
        else if (await subirConVersion(true) === 'ok') { try { localStorage.removeItem('vdm_sync_pendiente'); } catch (e) {} mostrarToast('Tus cambios sobrescribieron la versión de la nube'); }
    } finally { _conflictoAbierto = false; }
}

function sincronizarNube() {
    if (!supabaseClient || !_sesionActiva || !puedeEditar()) return;
    const miVer = ++_verSync;
    try { localStorage.setItem('vdm_sync_pendiente', '1'); } catch (e) {}
    _syncPend++; actualizarSyncUI();
    _colaSync = _colaSync.then(async () => {
        if (!_sesionActiva) return;
        const r = await subirConVersion(false);
        if (r === 'conflicto') { await resolverConflicto(); return; }
        if (r !== 'ok') { _syncFallo = true; return; }   // inválido u otro fallo: el indicador lo muestra y permite reintentar
        _syncFallo = false; _syncReintentos = 0;
        if (miVer === _verSync) { try { localStorage.removeItem('vdm_sync_pendiente'); } catch (e) {} }
    }).catch(e => {
        _syncFallo = true; programarReintentoSync();
        if (Date.now() - _ultAvisoSync > 10000) { _ultAvisoSync = Date.now(); mostrarToast("Error al sincronizar con la nube", "error"); }
    }).finally(() => { _syncPend = Math.max(0, _syncPend - 1); actualizarSyncUI(); });
}

async function esperarSincronizacion() {
    if (!supabaseClient || navigator.onLine === false) return false;
    flushSync();
    await Promise.race([_colaSync, new Promise(r => setTimeout(r, 12000))]);
    let pend = false; try { pend = localStorage.getItem('vdm_sync_pendiente') === '1'; } catch (e) {}
    return !pend && !_syncFallo && _syncPend === 0;
}

// Reintento automático (máx. 3 veces) tras un fallo de subida con red disponible
function programarReintentoSync() {
    if (_syncRetryT || _syncReintentos >= 3 || navigator.onLine === false) return;
    _syncReintentos++;
    _syncRetryT = setTimeout(() => { _syncRetryT = null; if (_syncFallo) sincronizarNube(); }, 20000);
}

// Indicador de estado de la nube en el header
function estadoSync() {
    if (!supabaseClient) return null;
    let pend = false; try { pend = localStorage.getItem('vdm_sync_pendiente') === '1'; } catch (e) {}
    if (navigator.onLine === false || _syncFallo) return 'offline';
    if (_syncPend > 0 || _syncDebT || pend) return 'pending';
    return 'ok';
}

function programarSync() {
    if (!supabaseClient || !_sesionActiva || !puedeEditar()) return;
    try { localStorage.setItem('vdm_sync_pendiente', '1'); } catch (e) {}
    clearTimeout(_syncDebT); _syncDebT = setTimeout(() => { _syncDebT = null; sincronizarNube(); }, 700);
    actualizarSyncUI();
}

function flushSync() { if (_syncDebT) { clearTimeout(_syncDebT); _syncDebT = null; sincronizarNube(); } }

function reintentarSync() {
    if (navigator.onLine === false) return mostrarToast('Sigues sin conexión: tus cambios están guardados en este dispositivo y se subirán al reconectar.', 'error');
    _syncFallo = false; _syncReintentos = 0; clearTimeout(_syncRetryT); _syncRetryT = null; clearTimeout(_syncDebT); _syncDebT = null;
    actualizarSyncUI(); sincronizarNube();
}

// Se registran una sola vez, aunque la interfaz se vuelva a dibujar
if (!window.__vdmSyncListeners) {
    window.__vdmSyncListeners = true;
    window.addEventListener('online', () => {
        let pend = false; try { pend = localStorage.getItem('vdm_sync_pendiente') === '1'; } catch (e) {}
        _syncReintentos = 0; actualizarSyncUI();
        if (_sesionActiva && (pend || _syncFallo)) sincronizarNube();
    });
    window.addEventListener('offline', () => actualizarSyncUI());
}
