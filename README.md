# nyburger-reportes

Panel de ventas (sales dashboard) de New York Burger para el propietario: ventana de hasta 7 días, totales por día, por hora y por producto, y ticket promedio, leídos de los archivos de cierre ("Históricos") del mismo backend que usan el comensal, la cocina y la caja. Sitio estático puro (sin framework, sin bundler), pensado para GitHub Pages.

El backend (Google Apps Script) vive en el repositorio privado de New York Burger (la [NYBurger backend repository](https://github.com/MelvinRamirez/NYBurger)). Este repositorio no duplica ningún archivo de ese backend; solo consume el endpoint HTTP `getSalesHistory`, documentado en sus specs (`sales-history-api`, `caja-pin-api`, `api-transport`, `day-close-archival`).

## Desarrollo local

Requiere Node.js >= 22.

```bash
npm test
```

## CSS

A diferencia de `nyburger-caja`, el `css/app.css` de este repositorio sigue sin generarse con el CLI de Tailwind: es una hoja de estilos escrita a mano que cubre las clases que emiten `js/views/pin-view.js` y, desde R2, también `js/views/report-view.js` (KPIs, filas por día, lista de productos, barras de horas). `css/input.css` ya trae las mismas directivas Tailwind v4 que `nyburger-caja`, por si en el futuro se decide regenerar `app.css` con utilidades de verdad, con el mismo procedimiento que documenta el README de `nyburger-caja` (binario standalone de Tailwind fijado por versión, commiteado el resultado, sin build en el deploy).

## Estado actual

Este repositorio está en construcción, en orden (mismo patrón que `nyburger-caja`/`nyburger-kds`):

- **R1 (completo)**: scaffold y módulos puros/casi puros (`store`, `config`, `messages`, `pin`, `api`, `actions`, `effects`), la pantalla de PIN (`views/pin-view.js`) y un `main.js` mínimo que solo resolvía el gate de PIN (`reportes-access`). Sin vista de reporte, sin selector de fecha, sin service worker, nada desplegado.
- **R2 (completo)**: `js/report.js` (puro: fecha por defecto, validación, clasificación de resultado, view-model), `js/views/report-view.js` (selector de fecha, acción "Ver", KPIs, filas por día, productos, distribución por hora), extensión de `main.js` (secuenciación de requests por número de secuencia, manejo de `UNAUTHORIZED` en `getSalesHistory` -> relock), `manifest.webmanifest`, `docs/reportes.md` (checklist manual completo, en este repositorio). Sin service worker (design Decision 6).
- **Deploy (completo)**: repositorio público remoto creado, GitHub Pages habilitado, backend (`B1`-`B3` en `NYBurger`) desplegado a producción.

El backend necesario (`getSalesHistory`) está desplegado a producción en `NYBurger` (`openspec/changes/archive/sales-dashboard`). El `API_URL` en `js/config.js` apunta al `/exec` real de producción (mismo backend que `nyburger-caja`).

## Deploy

**En línea:** `https://melvinramirez.github.io/nyburger-reportes/`. Ver `docs/reportes.md` en este repositorio para el procedimiento completo y el checklist manual (pendiente solo la medición a mano del punto 3.4, touch-targets de 44px).

## Sin service worker (v1)

A diferencia de `nyburger-caja`, esta app **no** registra un service worker ni precachea un app shell (design.md Decision 6): el panel no tiene nada útil que mostrar sin conexión al servidor, y la actualización del shell depende solo del caché HTTP normal de GitHub Pages más un query string de versión en `css/app.css`/`js/main.js` (agregado en R2, en el mismo commit que cualquier cambio de shell).
