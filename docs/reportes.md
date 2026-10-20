# Reportes Deployment Guide

This guide covers deploying the `nyburger-reportes` sales-history dashboard
client (a static PWA) to GitHub Pages, and the manual checklist that proves
it works end to end against the real backend and the real archive folder.

Audience: the New York Burger Owner/Administrator. The backend half of this change
(the `getSalesHistory` action and the day-close archive span tags) is
documented in `NYBurger/docs/backend-deployment.md`; this guide covers the
client repository, `MelvinRamirez/nyburger-reportes`.

> **Placement note (work unit R2):** this file is a completed copy of the
> deploy guide `NYBurger`'s backend work unit B3 started at
> `NYBurger/docs/backend-deployment.md`'s sibling, `NYBurger/docs/reportes.md`
> (tasks.md task 7.3, left with an explicit placeholder for the
> client-side checklist items). Work unit R2 (tasks.md task 13.6) completes
> that placeholder here, in the client repository, because that is where a
> reader of `nyburger-reportes` would look for its own deploy guide -- the
> `NYBurger` repository stays the single source of truth for the backend half.
> The `NYBurger` copy is intentionally left as it was when B3 wrote it (this
> unit has no edit authority there and does not need any -- see tasks.md's
> "Note on edit authority").

> **Current status (work units B1-B3, R1-R2, this document's authoring
> time):** the backend side of this change -- `getSalesHistory`, the
> `createdDateHour_`/`createdSpan_` span-tagging helpers, and the
> `ValidationHarness.gs` self-checks -- is implemented and committed, but
> **not yet deployed** to the production Web App. The client
> (`nyburger-reportes`, this repository) is now feature-complete -- PIN gate,
> date picker, results view, PWA manifest -- but **not yet published**: the
> public repository `MelvinRamirez/nyburger-reportes` does not exist yet and
> GitHub Pages is not enabled (tasks.md Phase 15, a separate, explicit
> user-confirmed step). Sections below that assume a live `/exec`
> deployment or a published repository describe the deploy procedure to
> follow once both are ready. This document's manual checklist (section 3)
> cannot be completed until then.

## 1. Deploying to GitHub Pages

`nyburger-reportes` is a static site with zero runtime dependencies (no
framework, no bundler, no build step -- same convention as `nyburger-cliente`,
`nyburger-kds` and `nyburger-caja`). Deployment is: push to `main`, enable Pages.

1. With explicit user confirmation (this is a user action, not an
   automated-tooling action -- see `NYBurger`'s tasks.md "Note on edit
   authority"), create the public repository `MelvinRamirez/nyburger-reportes`
   and push this repository's `main` branch to it.
2. In the repository's **Settings -> Pages**, set the source to the `main`
   branch, root folder (`/`). GitHub Pages serves the site at
   `https://melvinramirez.github.io/nyburger-reportes/`.
3. Confirm `.nojekyll` is committed at the repository root (an empty file),
   so GitHub Pages does not run its default Jekyll processing over files
   whose names start with an underscore or otherwise collide with Jekyll's
   reserved paths.

### Sub-path hosting

Because the site is served under a sub-path
(`https://melvinramirez.github.io/nyburger-reportes/`, not a custom domain's
root), every asset reference in `index.html`/`manifest.webmanifest`/CSS
**must be relative**, never an absolute path starting with `/` -- an
absolute path resolves against the GitHub Pages user root
(`https://melvinramirez.github.io/`), not the repository's own sub-path, and
silently 404s. This is the same convention `nyburger-cliente`/`nyburger-kds`/
`nyburger-caja` already follow; `nyburger-reportes` reuses it unchanged. `npm
test`'s `test/shell.test.mjs` asserts this structurally for `index.html` and
`manifest.webmanifest`.

### Version-query-string bump convention (no Service Worker)

`reportes-pwa-shell`'s design decision is **no Service Worker** -- unlike
`nyburger-kds`/`nyburger-caja`, this client has no cache-versioning mechanism of
its own. There is no `sw.js`, no cache-name bump, and no automatic
invalidation of a previously-fetched `css/app.css` or `js/main.js` in a
returning visitor's browser cache.

**Every change to a static asset's content (`css/app.css`, `js/main.js`, or
any other file referenced by a `<link>`/`<script>` tag) MUST bump that
asset's version query string in `index.html`** -- for example
`css/app.css?v=1` becoming `css/app.css?v=2` -- in the **same commit/change**
that modifies the asset. Skipping this means a browser that already cached
the old `css/app.css?v=1` keeps serving it indefinitely, because the
browser's HTTP cache keys on the full URL including the query string, and
nothing else in this client ever tells it to re-fetch.

- The version query string is a plain integer, incremented by one per
  change that touches that specific asset. It needs no coordination across
  files -- `css/app.css?v=2` and `js/main.js?v=1` can be at different
  numbers.
- This is a manual discipline, not an automated or enforced one (`npm
  test`'s `test/shell.test.mjs` only asserts that a version query string is
  *present* on both `css/app.css` and `js/main.js`, not that it changed).
  Before shipping any shell change, the person applying it must remember to
  bump the string by hand.
- Forgetting this bump is a silent, hard-to-diagnose bug: the reported
  symptom is "I pushed a fix but it's not showing up," and the fix is
  simply a hard refresh (bypassing cache) to confirm, followed by bumping
  the version string and re-deploying.

## 2. Backend deploy ordering (read this before testing the client)

**`NYBurger`'s B1, B2 and B3 (the backend half of this change) must be merged
and deployed as a new Web App version -- same `/exec` URL -- before
`nyburger-reportes` is tested against the live backend.** Testing the client
first produces `UNKNOWN_ACTION` on every `getSalesHistory` call, because the
deployed backend does not yet register that action. See
`NYBurger/docs/backend-deployment.md` for the backend deploy procedure (no new
Script Property, no new OAuth scope -- `appsscript.json` is unchanged by this
change).

The manual checklist item "confirm the next real close's file carries
`foodc_created_min`/`foodc_created_max`" (design "Migration / Rollout" step
4) can only be observed once a real `closeDay` runs against the deployed
B1 code, so it is expected to be checked off some time after the backend
deploy, not necessarily on the same day.

## 3. Manual checklist

Run this checklist after both the backend is deployed (section 2) and the
client is published (section 1).

### 3.1 Backend correctness (real folder, real closes)

1. **A real folder test.** Against the production `/exec` URL and the real
   "New York Burger Historicos" Drive folder (not a stub/fixture), submit a
   `getSalesHistory` request for a window that includes at least one real,
   already-closed day. Confirm the response's `days`/`totals`/`products`/
   `hours` match what can be hand-verified against that day's archive file
   in Drive (open the file directly, sum the `total_amount` column for the
   relevant rows).
2. **A window spanning a late-paid order.** Find (or create, via a real
   order and a real close) a case where an order's `created_at` falls on
   the last day of a requested window, but the order was only archived by
   a `closeDay` that ran the *next* day (or later) -- confirm
   `getSalesHistory` still counts it on its actual sale day, not on the
   day the archive file was closed. This is the central technical
   correctness property of this change (design Decision 1, the C7
   interval-overlap rule).
3. **A window with a skipped day.** Find (or create) a window that
   includes a calendar day with no `closeDay` run at all (the restaurant
   was closed, or the close was simply never run) and confirm that day
   reports `closed:false` with its orders (if any were later swept into a
   subsequent close) still counted, and that `getSalesHistory` never
   errors on a day with no close.
4. **Timing via `meta.duration_ms`.** Record `meta.duration_ms` for a
   recent window (few or no legacy untagged files involved) and for the
   earliest window that reaches back far enough to include the legacy
   (pre-this-change, untagged) archive files, per design's "Execution-Time
   Budget". Confirm both stay comfortably under the 60 s client timeout and
   the 6-minute Apps Script execution ceiling -- record the actual numbers
   here once measured:

   | Window | `meta.duration_ms` | Files read (`files_read`) | Notes |
   |---|---|---|---|
   | Recent (no legacy files) | *pending* | *pending* | *pending* |
   | Earliest (reaches legacy untagged files) | *pending* | *pending* | *pending* |

### 3.2 Client installability (added by work unit R2)

1. **Add to home screen.** On a phone (Android Chrome or iOS Safari), open
   the published `https://melvinramirez.github.io/nyburger-reportes/` URL and
   use the browser's "Add to Home Screen" / install prompt. Confirm:
   - The app installs using the name "FoodC Reportes" / short name
     "Reportes" and the maskable icon (`manifest.webmanifest`,
     `reportes-pwa-shell` "Web App Manifest for Home-Screen
     Installability").
   - Launching from the home-screen icon opens in `standalone` display
     mode (no browser address bar/chrome), confirming `start_url` and
     `scope` resolved correctly under the `/nyburger-reportes/` sub-path and
     not under the Pages domain root.
   - `npm test`'s `test/shell.test.mjs` already proves this structurally
     (manifest fields present, relative paths, icons on disk); this step
     is the real-device confirmation that it also installs in practice.

### 3.3 Offline / no-service-worker behavior (added by work unit R2)

`reportes-pwa-shell` deliberately ships **no service worker** (design
Decision 6): there is no offline app shell and no cached report data.
Confirm both halves of that on a real device:

1. **Opening the app with no connectivity.** With the device's network
   fully off (airplane mode) and the app not already open in a tab, try to
   load `https://melvinramirez.github.io/nyburger-reportes/`. Confirm the
   browser's own offline/network-error page is shown -- nothing from this
   app intercepts the navigation, because no service worker is registered.
2. **Losing connectivity while already open.** Load the app normally while
   online, let a report finish loading (`report.status: 'ready'`), then
   turn the network off and press "Ver" again (same date or a different
   one). Confirm:
   - The request fails as an ordinary network error, and the view shows
     "Sin conexion. Reintentar." (the `unknown` status), not a blank screen
     and not a custom offline page.
   - The previously loaded report is **not** silently kept on screen as if
     it already answered the new request -- the loading indicator replaces
     it the moment "Ver" is pressed, and the failure message replaces the
     loading indicator once the request fails.
   - Turning the network back on and pressing "Ver" again succeeds
     normally.

### 3.4 Touch-target measurement (added by work unit R2)

`npm test`'s `test/shell.test.mjs` proves *structurally* that
`.pin-view__input`, `.pin-view__submit`, `.report-view__date-input` and
`.report-view__view-button` each declare `min-height`/`min-width` of at
least `2.75rem` (44px at the browser default 16px root font size) in
`css/app.css`. That is a proof about the declared CSS, not the actually
rendered pixels on a real device (browser zoom, OS-level text scaling, and
a non-default root font size could all still shrink or grow the real hit
area). Confirm the *rendered* size once, on a real phone:

1. Open the published app on a phone at its default zoom/text-size
   settings.
2. Using the browser's own device inspector (or, lacking that, a screenshot
   measured against a known reference, e.g. the status bar's known height
   in CSS pixels for that device), measure the rendered hit area of: the
   PIN input, the PIN submit button, the date picker, and the "Ver"
   button.
3. Confirm each is at least 44x44 CSS pixels. Record the device and result
   here once measured:

   | Control | Device | Measured hit area | Pass? |
   |---|---|---|---|
   | PIN input | Motorola Edge 40, Chrome, default zoom | not measured in exact CSS px; visually comfortable | visual pass* |
   | PIN submit button | Motorola Edge 40, Chrome, default zoom | not measured in exact CSS px; visually comfortable | visual pass* |
   | Date picker | Motorola Edge 40, Chrome, default zoom | not measured in exact CSS px; visually comfortable | visual pass* |
   | "Ver" button | Motorola Edge 40, Chrome, default zoom | not measured in exact CSS px; visually comfortable | visual pass* |

   \* Confirmed 2026-10-20 against two on-device screenshots of the
   published app (PIN view and report view). Pixel analysis of the
   screenshots was attempted but could not be converted to exact CSS
   pixels without a reliable calibration reference for this device's
   real browser viewport width/DPR (no USB debugging access available).
   All four controls appear generously sized relative to surrounding
   text in both screenshots, with no indication of a cramped target,
   and the CSS already structurally guarantees `min-height`/`min-width`
   of `2.75rem` (44px) per `test/shell.test.mjs`. This is a visual
   confirmation, not an exact-pixel measurement; redo with a device
   inspector (USB debugging or a desktop browser's remote device mode)
   if exact numbers are ever needed.
