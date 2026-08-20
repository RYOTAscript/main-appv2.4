// Integration test: verifies the REAL Mini-Widget registry in renderer/core.js
// gates exactly the Windows-only widgets and is wired to the platform filter.
//
// core.js is a browser classic-script (uses window/localStorage) so it can't be
// required. But the MINI_WIDGETS_ALL array is pure data, so we extract that one
// literal and eval it in isolation — testing the true catalogue, not a fixture.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WP = require('../renderer/widget-platform.js');

const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'core.js'), 'utf8');

// The widgets that rely on Windows-only tech and must be hidden on macOS.
const WIN_ONLY = [
  'controllerMacros', 'taskbar', 'appInstaller', 'debloat', 'revoUninstaller',
  'macros', 'fpsOptimizer',
];

function loadRegistry() {
  // Grab `const MINI_WIDGETS_ALL = [ ... ];` — non-greedy up to the first line
  // that is just `];` (the inner keyword/feature arrays all close inline, so
  // they don't match the `\n\s*];` anchor).
  const m = coreSrc.match(/const\s+MINI_WIDGETS_ALL\s*=\s*(\[[\s\S]*?\n\s*\]);/);
  assert.ok(m, 'MINI_WIDGETS_ALL array literal located in core.js');
  // eslint-disable-next-line no-eval
  const reg = eval('(' + m[1] + ')');
  assert.ok(Array.isArray(reg) && reg.length > 20, 'registry parsed to a non-trivial array');
  return reg;
}

test('core.js is wired to the platform filter', () => {
  assert.match(coreSrc, /const\s+MINI_WIDGETS_ALL\s*=\s*\[/, 'full catalogue renamed to MINI_WIDGETS_ALL');
  assert.match(coreSrc, /window\.WidgetPlatform\.filterWidgetsForPlatform/, 'core.js filters via WidgetPlatform');
  assert.match(coreSrc, /const\s+MINI_WIDGETS\s*=/, 'derived MINI_WIDGETS still defined for consumers');
});

test('main.html loads widget-platform.js before core.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'main.html'), 'utf8');
  const wp = html.indexOf('renderer/widget-platform.js');
  const core = html.indexOf('renderer/core.js');
  assert.ok(wp !== -1, 'widget-platform.js script tag present');
  assert.ok(core !== -1, 'core.js script tag present');
  assert.ok(wp < core, 'widget-platform.js must load before core.js');
});

test('preload exposes process.platform to the renderer', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /platform:\s*process\.platform/, 'preload exposes platform');
});

test('every Windows-only widget is gated to win32', () => {
  const reg = loadRegistry();
  for (const id of WIN_ONLY) {
    const w = reg.find(x => x.id === id);
    assert.ok(w, `widget "${id}" present in registry`);
    assert.deepEqual(w.platforms, ['win32'], `"${id}" must carry platforms: ['win32']`);
  }
});

test('a representative cross-platform widget has NO platforms field', () => {
  const reg = loadRegistry();
  for (const id of ['timer', 'spotifyEnhanced', 'valclips', 'crosshair', 'weatherEnhanced']) {
    const w = reg.find(x => x.id === id);
    assert.ok(w, `widget "${id}" present`);
    assert.equal(w.platforms, undefined, `"${id}" should be available on every OS`);
  }
});

const onlyPlatform = (w, p) => Array.isArray(w.platforms) && w.platforms.length === 1 && w.platforms[0] === p;

test('filtering the real registry matches the platforms fields both ways', () => {
  const reg = loadRegistry();
  const macOnly = reg.filter(w => onlyPlatform(w, 'darwin'));
  const winOnly = reg.filter(w => onlyPlatform(w, 'win32'));

  const winIds = WP.filterWidgetsForPlatform(reg, 'win32').map(w => w.id);
  const macIds = WP.filterWidgetsForPlatform(reg, 'darwin').map(w => w.id);

  // win32 shows everything except mac-only; darwin shows everything except win-only.
  assert.equal(winIds.length, reg.length - macOnly.length, 'win32 = all minus mac-only');
  assert.equal(macIds.length, reg.length - winOnly.length, 'darwin = all minus win-only');

  // The declared Windows-only set matches the registry's win-only widgets.
  assert.equal(winOnly.length, WIN_ONLY.length, 'no unexpected win-only widgets');
  for (const id of WIN_ONLY) assert.ok(!macIds.includes(id), `"${id}" is hidden on darwin`);

  // Each mac-only widget shows on darwin and is hidden on win32.
  for (const w of macOnly) {
    assert.ok(macIds.includes(w.id), `${w.id} shows on darwin`);
    assert.ok(!winIds.includes(w.id), `${w.id} hidden on win32`);
  }

  // Sanity: known-good widgets survive the mac filter (the Media+Productivity set).
  for (const id of ['valclips', 'micMute', 'volumeMixer', 'launchEnhanced', 'fileSearch', 'clipboard']) {
    assert.ok(macIds.includes(id), `${id} survives on darwin`);
  }
});

test('every widget id is unique (no gating collisions)', () => {
  const reg = loadRegistry();
  const ids = reg.map(w => w.id);
  assert.equal(new Set(ids).size, ids.length, 'widget ids are unique');
});
