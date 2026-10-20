import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readRoot(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function existsInRoot(relPath) {
  return fs.existsSync(path.join(ROOT, relPath.replace(/^\.\//, '')));
}

function listJsFilesRecursive(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listJsFilesRecursive(full));
    } else if (entry.name.endsWith('.js')) {
      result.push(full);
    }
  }
  return result;
}

// --- reportes-pwa-shell: "No Service Worker Is Registered in v1" ---

test('no sw.js file is shipped', () => {
  assert.equal(existsInRoot('sw.js'), false, 'foodc-reportes must not ship an sw.js file (design Decision 6)');
});

test('no "serviceWorker" reference exists anywhere under js/ (no registration call anywhere in the client code)', () => {
  const jsFiles = listJsFilesRecursive(path.join(ROOT, 'js'));
  assert.ok(jsFiles.length > 0, 'expected at least one js module under js/');
  for (const file of jsFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /serviceWorker/i,
      `${path.relative(ROOT, file)} must not reference serviceWorker`,
    );
  }
});

test('index.html has no navigator.serviceWorker.register call', () => {
  const html = readRoot('index.html');
  assert.doesNotMatch(html, /serviceWorker/i, 'index.html must not register a service worker');
});

// --- "Web App Manifest for Home-Screen Installability" ---

test('manifest.webmanifest declares the required installability fields', () => {
  const manifest = JSON.parse(readRoot('manifest.webmanifest'));

  assert.ok(manifest.name && manifest.name.length > 0, 'manifest.name must be non-empty');
  assert.equal(manifest.name, 'FoodC Reportes');
  assert.ok(manifest.short_name && manifest.short_name.length > 0, 'manifest.short_name must be non-empty');
  assert.ok(manifest.start_url && manifest.start_url.length > 0, 'manifest.start_url must be non-empty');
  assert.ok(manifest.scope && manifest.scope.length > 0, 'manifest.scope must be non-empty');
  assert.equal(manifest.display, 'standalone', 'reportes-pwa-shell requires display: "standalone"');
  assert.ok(manifest.theme_color, 'manifest.theme_color must be set');
  assert.ok(manifest.background_color, 'manifest.background_color must be set');

  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192'), 'manifest must declare a 192x192 icon');
  assert.ok(sizes.includes('512x512'), 'manifest must declare a 512x512 icon');

  const hasMaskable = manifest.icons.some((icon) => icon.purpose === 'maskable');
  assert.ok(hasMaskable, 'manifest must declare at least one icon with purpose "maskable"');

  for (const icon of manifest.icons) {
    assert.ok(existsInRoot(icon.src), `manifest icon "${icon.src}" must exist on disk`);
  }
});

test('manifest start_url/scope resolve under the Pages sub-path (relative paths, not domain-root absolute)', () => {
  const manifest = JSON.parse(readRoot('manifest.webmanifest'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.lang, 'es');
});

test('manifest paths are all relative (no absolute path resolving against the Pages domain root)', () => {
  const manifest = readRoot('manifest.webmanifest');
  assert.doesNotMatch(
    manifest,
    /"(start_url|scope|src|id)"\s*:\s*"\/(?!\/)/,
    'manifest.webmanifest must not use an absolute start_url/scope/id/icon src',
  );
});

test('no absolute paths (href="/", src="/") in index.html', () => {
  const html = readRoot('index.html');
  assert.doesNotMatch(html, /(href|src)\s*=\s*"\/(?!\/)/, 'index.html must not reference an absolute path');
});

// --- "Shell updates rely on... a version query string...bumped in the same
// commit as any shell change, rather than a service-worker cache-version
// bump" ---

test('index.html references css/app.css and js/main.js with a version query string', () => {
  const html = readRoot('index.html');
  assert.match(html, /css\/app\.css\?v=\d+/, 'css/app.css reference must carry a version query string');
  assert.match(html, /js\/main\.js\?v=\d+/, 'js/main.js reference must carry a version query string');
});

test('css/app.css exists and is non-empty', () => {
  const stat = fs.statSync(path.join(ROOT, 'css', 'app.css'));
  assert.ok(stat.size > 0, 'css/app.css must be non-empty');
});

// --- "Layout and Touch Targets": every interactive control >= 44x44 CSS px
//
// No DOM library (e.g. jsdom) is a dependency of this zero-runtime- and
// zero-dev-dependency project, so a rendered hit area cannot be measured by
// actually laying out the page in this test run. Instead, this is a
// structural assertion against the CSS rules that control each control's
// declared size: every selector below must declare both min-height and
// min-width of at least 44px (2.75rem at the browser default 16px root
// font size, which this app's CSS never overrides — see css/app.css, no
// `font-size` is set on `html`). This proves the *declared* minimum size;
// the actually rendered size on a real device is the manual-measurement
// item in docs/reportes.md section 3.4 (task 13.6).

const TOUCH_TARGET_SELECTORS = [
  '.pin-view__input',
  '.pin-view__submit',
  '.report-view__date-input',
  '.report-view__view-button',
];

function extractRuleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : null;
}

function declaredPxSize(rawValue) {
  const remMatch = /^([\d.]+)rem$/.exec(rawValue.trim());
  if (remMatch) return parseFloat(remMatch[1]) * 16;
  const pxMatch = /^([\d.]+)px$/.exec(rawValue.trim());
  if (pxMatch) return parseFloat(pxMatch[1]);
  return null;
}

test('every interactive control declares a minimum 44x44 CSS pixel hit area in css/app.css', () => {
  const css = readRoot('css/app.css');
  for (const selector of TOUCH_TARGET_SELECTORS) {
    const body = extractRuleBody(css, selector);
    assert.ok(body, `css/app.css must declare a rule for ${selector}`);

    const minHeightMatch = /min-height:\s*([^;]+);/.exec(body);
    const minWidthMatch = /min-width:\s*([^;]+);/.exec(body);
    assert.ok(minHeightMatch, `${selector} must declare min-height`);
    assert.ok(minWidthMatch, `${selector} must declare min-width`);

    const heightPx = declaredPxSize(minHeightMatch[1]);
    const widthPx = declaredPxSize(minWidthMatch[1]);
    assert.ok(heightPx !== null, `${selector} min-height must be a rem or px value (got "${minHeightMatch[1]}")`);
    assert.ok(widthPx !== null, `${selector} min-width must be a rem or px value (got "${minWidthMatch[1]}")`);
    assert.ok(heightPx >= 44, `${selector} min-height must be >= 44px (got ${minHeightMatch[1]} = ${heightPx}px)`);
    assert.ok(widthPx >= 44, `${selector} min-width must be >= 44px (got ${minWidthMatch[1]} = ${widthPx}px)`);
  }
});

// --- package.json: zero runtime dependencies (C1), unchanged by this unit ---

test('package.json declares zero runtime dependencies', () => {
  const pkg = JSON.parse(readRoot('package.json'));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'package.json must have no runtime dependencies');
});

// --- docs/reportes.md exists in this repository (task 13.6) ---

test('docs/reportes.md exists in this repository', () => {
  assert.ok(existsInRoot('docs/reportes.md'), 'docs/reportes.md must exist in foodc-reportes');
});
