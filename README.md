# Gestión de Territorios Vista Al Mar

Aplicación web y **PWA (Progressive Web App)** desarrollada para organizar asignaciones de territorios, turnos, grupos, exhibidores, agenda y seguimiento operativo con sincronización en la nube mediante **Supabase** y despliegue continuo en **GitHub Pages**.

## Características principales

* **Gestión de Grupos y Exhibidores:** control de turnos, horarios, asignaciones, lugares de exhibidor, resúmenes y vistas rápidas de actividad.
* **Contacto y coordinación:** acceso directo a acciones de seguimiento, avisos, confirmaciones y sustitución de turnos.
* **Sincronización en la nube (Supabase):** persistencia de datos, control de sesiones y actualización de estados en tiempo real.
* **Experiencia PWA y modo sin conexión:** instalable en el dispositivo con *Service Worker* (`sw.js`), icono personalizado (`icono.png`) y soporte de caché para consultas rápidas.
* **Exportación y compartición:** herramientas para respaldar historial, exportar resúmenes y compartir información clave.

## Estructura del proyecto

* `index.html` — Estructura principal de la aplicación y carga de estilos y scripts.
* `styles.css` — Estilos visuales, diseño adaptable (*responsive*) y ajustes de interfaz.
* `supabase.js` — Conexión, autenticación, lectura y sincronización con Supabase.
* `app.js` — Lógica central de vistas, estados, eventos, modales y comportamiento PWA.
* `sw.js` — Gestión de caché, actualización de versiones y funcionamiento sin conexión.
* `icono.png` — Ícono principal de la aplicación y accesos directos.

## Notas de mantenimiento y versiones

* **Punto de restauración:** antes de cambios mayores o reestructuraciones, se conserva la versión estable etiquetada (`v1.0-estable`) como respaldo seguro.
* **Actualizaciones:** al publicar cambios nuevos, se actualiza la versión de caché en `sw.js` y el parámetro `?v=` en las referencias de `index.html` para evitar que los dispositivos carguen archivos antiguos.
