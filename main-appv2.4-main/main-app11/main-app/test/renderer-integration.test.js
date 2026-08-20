// End-to-end simulation of the renderer's widget gating, from Windows.
//
// We can't launch the app on a Mac, so we reproduce the browser load order in a
// Node `vm` sandbox with a fake `window`:
//   1. run the REAL renderer/widget-platform.js  → attaches window.WidgetPlatform
//   2. run the REAL registry literal + derivation glue extracted from core.js
//   3. read back the resulting MINI_WIDGETS for a given electronAPI.platform
//
// This proves the actual core.js wiring (not a fixture) produces the correct
// OS-filtered widget set — the closest thing to a real macOS boot we can test
// without a Mac.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const RENDERER = path.join(__dirname, '..', 'renderer');
const wpSrc = fs.readFileSync(path.join(RENDERER, 'widget-platform.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(RENDERER, 'core.js'), 'utf8');

// Pull the real registry literal and the real derivation statement out of core.js.
const registryLiteral = coreSrc.match(/const\s+MINI_WIDGETS_ALL\s*=\s*\[[\s\S]*?\n\s*\];/);
const derivation = coreSrc.match(/const\s+MINI_WIDGETS\s*=\s*\(typeof window[\s\S]*?;/);
assert.ok(registryLiteral, 'found MINI_WIDGETS_ALL literal in core.js');
assert.ok(derivation, 'found MINI_WIDGETS derivation glue in core.js');

function bootRenderer(platform) {
  const sandbox = { console: { warn() {}, log() {}, error() {} } };
  // A classic script's global object IS window; make bare `window` self-refer.
  sandbox.window = sandbox;
  sandbox.electronAPI = { platform };
  vm.createContext(sandbox);

  // 1. widget-platform.js — its IIFE sees `window` and sets window.WidgetPlatform.
  vm.runInContext(wpSrc, sandbox, { filename: 'widget-platform.js' });

  // 2. the real registry + real derivation, then surface the result.
  vm.runInContext(
    `${registryLiteral[0]}\n${derivation[0]}\nwindow.__RESULT = MINI_WIDGETS;`,
    sandbox,
    { filename: 'core.js#registry' }
  );
  return sandbox.window.__RESULT;
}

const WIN_ONLY = [
  'controllerMacros', 'taskbar', 'appInstaller', 'debloat', 'revoUninstaller',
  'macros', 'fpsOptimizer',
];

test('widget-platform.js attaches WidgetPlatform to window in a browser-like context', () => {
  const sandbox = { window: null };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(wpSrc, sandbox, { filename: 'widget-platform.js' });
  assert.equal(typeof sandbox.WidgetPlatform, 'object');
  assert.equal(typeof sandbox.WidgetPlatform.filterWidgetsForPlatform, 'function');
});

test('simulated Windows boot keeps the full catalogue', () => {
  const widgets = bootRenderer('win32');
  const ids = widgets.map(w => w.id);
  for (const id of WIN_ONLY) assert.ok(ids.includes(id), `${id} present on Windows`);
  assert.ok(ids.includes('valclips'));
  assert.ok(ids.includes('spotifyEnhanced'));
});

test('simulated macOS boot hides every Windows-only widget', () => {
  const mac = bootRenderer('darwin');
  const macIds = mac.map(w => w.id);

  for (const id of WIN_ONLY) assert.ok(!macIds.includes(id), `${id} hidden on macOS`);
  // The Mac-friendly widgets are all still there.
  for (const id of ['valclips', 'videoEditor', 'spotifyEnhanced', 'fullscreenLyrics', 'timer', 'weatherEnhanced', 'crosshair', 'micMute']) {
    assert.ok(macIds.includes(id), `${id} available on macOS`);
  }
});

test('simulated Linux boot also hides the Windows-only widgets', () => {
  const linux = bootRenderer('linux').map(w => w.id);
  for (const id of WIN_ONLY) assert.ok(!linux.includes(id), `${id} hidden on Linux`);
});

test('missing electronAPI.platform falls back to the full Windows catalogue', () => {
  // Simulate a boot where the preload bridge didn't expose a platform.
  const sandbox = { console: { warn() {}, log() {}, error() {} } };
  sandbox.window = sandbox;
  sandbox.electronAPI = {}; // no platform field
  vm.createContext(sandbox);
  vm.runInContext(wpSrc, sandbox, { filename: 'widget-platform.js' });
  vm.runInContext(
    `${registryLiteral[0]}\n${derivation[0]}\nwindow.__RESULT = MINI_WIDGETS;`,
    sandbox,
    { filename: 'core.js#registry' }
  );
  const ids = sandbox.window.__RESULT.map(w => w.id);
  for (const id of WIN_ONLY) assert.ok(ids.includes(id), `${id} kept when platform unknown (fail-safe)`);
});
