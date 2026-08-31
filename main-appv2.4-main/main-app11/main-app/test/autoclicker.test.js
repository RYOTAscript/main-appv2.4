// Auto Clicker: config sanitizing, hotkey safety, engine-protocol integrity, and
// the renderer's pure helpers.
//
// The click engine itself (SendInput, GDI colour scanning) needs a real screen
// and a real PowerShell host, so it can't run here — it's covered by the
// on-device pass. What IS covered here is everything that can silently drift:
// the persisted config's shape and clamps, the trigger/button collision rule,
// the engine script still speaking the protocol main.js writes for it, and the
// renderer maths behind the rate readout and the Start button's gating.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const AC = require('../main/autoClicker.js');

// ── Config sanitizing ──────────────────────────────────────────────────
test('defaultConfig is a complete, safe starting point', () => {
  const d = AC.defaultConfig();
  assert.equal(d.enabled, false, 'never enabled until the user says so');
  assert.equal(d.mode, 'cursor');
  assert.equal(d.button, 0);
  assert.equal(d.repeatMode, 'infinite');
  assert.equal(d.area, null);
  assert.equal(d.point, null);
  assert.equal(d.trigger, 'toggle');
  assert.ok(d.interval >= 1);
});

test('sanitizeConfig falls back to defaults for junk input', () => {
  for (const junk of [null, undefined, 'nope', 42, []]) {
    const c = AC.sanitizeConfig(junk);
    assert.equal(c.mode, 'cursor');
    assert.equal(c.button, 0);
  }
});

test('sanitizeConfig rejects out-of-range enums', () => {
  const c = AC.sanitizeConfig({
    mode: 'lasers', pattern: 'spiral', clickType: 'quadruple',
    repeatMode: 'forever-ish', targetMode: 'psychic', trigger: 'wiggle'
  });
  assert.equal(c.mode, 'cursor');
  assert.equal(c.pattern, 'random');
  assert.equal(c.clickType, 'single');
  assert.equal(c.repeatMode, 'infinite');
  assert.equal(c.targetMode, 'first');
  assert.equal(c.trigger, 'toggle');
});

test('sanitizeConfig clamps numbers into their working range', () => {
  const low = AC.sanitizeConfig({ interval: -5000, button: -3, tolerance: -1, scanStep: 0, pressMs: 0 });
  assert.equal(low.interval, 1, 'interval never drops below 1ms');
  assert.equal(low.button, 0);
  assert.equal(low.tolerance, 0);
  assert.equal(low.scanStep, 1);
  assert.equal(low.pressMs, 1);

  const high = AC.sanitizeConfig({ button: 99, tolerance: 9999, scanStep: 999, spread: 100000 });
  assert.equal(high.button, 4, 'button stays a real mouse button');
  assert.equal(high.tolerance, 255);
  assert.equal(high.scanStep, 32);
  assert.ok(high.spread <= 400);
});

test('sanitizeConfig keeps a valid area and drops a malformed one', () => {
  const good = AC.sanitizeConfig({ area: { x: 10, y: 20, w: 300, h: 200 } });
  assert.deepEqual(good.area, { x: 10, y: 20, w: 300, h: 200 });

  for (const bad of [{ x: 1, y: 2, w: 0, h: 5 }, { x: 1, y: 2 }, { x: NaN, y: 2, w: 3, h: 4 }, null]) {
    assert.equal(AC.sanitizeConfig({ area: bad }).area, null, `rejects ${JSON.stringify(bad)}`);
  }
});

test('sanitizeConfig keeps a valid point and drops a malformed one', () => {
  assert.deepEqual(AC.sanitizeConfig({ point: { x: 5, y: 9 } }).point, { x: 5, y: 9 });
  assert.equal(AC.sanitizeConfig({ point: { x: 'a', y: 9 } }).point, null);
  assert.equal(AC.sanitizeConfig({ point: null }).point, null);
});

test('sanitizeConfig normalizes colours and rejects bad ones', () => {
  assert.equal(AC.sanitizeConfig({ color: '00FF7F' }).color, '#00ff7f', 'adds the # and lowercases');
  assert.equal(AC.sanitizeConfig({ color: '#00ff7f' }).color, '#00ff7f');
  for (const bad of ['#xyzxyz', '#fff', 'red', '', null]) {
    assert.equal(AC.sanitizeConfig({ color: bad }).color, '#ff0000', `falls back for ${bad}`);
  }
});

test('sanitizeConfig round-trips its own output unchanged (persistence is stable)', () => {
  const once = AC.sanitizeConfig({
    mode: 'color', area: { x: 1, y: 2, w: 30, h: 40 }, color: '#0aff10',
    tolerance: 33, targetMode: 'all', interval: 25, clickType: 'double', button: 3
  });
  assert.deepEqual(AC.sanitizeConfig(JSON.parse(JSON.stringify(once))), once);
});

test('sanitizeConfig keeps a valid skip zone and drops a malformed one', () => {
  const c = AC.sanitizeConfig({ exclude: { x: 40, y: 50, w: 100, h: 80 } });
  assert.deepEqual(c.exclude, { x: 40, y: 50, w: 100, h: 80 });
  assert.equal(AC.sanitizeConfig({}).exclude, null, 'no zone by default');
  for (const bad of [{ x: 1, y: 1, w: 0, h: 9 }, { x: 1 }, null]) {
    assert.equal(AC.sanitizeConfig({ exclude: bad }).exclude, null);
  }
});

test('the second colour is optional — bad input means "off", not a default', () => {
  // Unlike `color`, an unparseable second colour must NOT fall back to red;
  // that would silently start hunting a colour the user never chose.
  assert.equal(AC.sanitizeConfig({}).color2, null);
  assert.equal(AC.sanitizeConfig({ color2: '#00ff00' }).color2, '#00ff00');
  assert.equal(AC.sanitizeConfig({ color2: '0AFF10' }).color2, '#0aff10');
  for (const bad of ['nope', '#fff', '', null, undefined]) {
    assert.equal(AC.sanitizeConfig({ color2: bad }).color2, null, `off for ${bad}`);
  }
  assert.notEqual(AC.sanitizeConfig({ color2: 'nope' }).color2, '#ff0000', 'never inherits the first colour default');
});

// ── Colour helper ──────────────────────────────────────────────────────
test('hexToRgb parses the channels the engine scans for', () => {
  assert.deepEqual(AC.hexToRgb('#ff0000'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(AC.hexToRgb('#12c8a4'), { r: 0x12, g: 0xc8, b: 0xa4 });
  assert.deepEqual(AC.hexToRgb('#FFFFFF'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(AC.hexToRgb('garbage'), { r: 255, g: 0, b: 0 }, 'safe fallback');
});

// ── The runaway-trigger guard ──────────────────────────────────────────
test('a mouse trigger equal to the clicked button is refused', () => {
  // Binding the trigger to the very button being clicked would make each
  // synthesized click re-fire the trigger forever.
  assert.equal(AC.hotkeyConflictsWithButton('MouseLeft', 0), true);
  assert.equal(AC.hotkeyConflictsWithButton('MouseRight', 1), true);
  assert.equal(AC.hotkeyConflictsWithButton('MouseMiddle', 2), true);
  assert.equal(AC.hotkeyConflictsWithButton('Mouse4', 3), true);
  assert.equal(AC.hotkeyConflictsWithButton('Mouse5', 4), true);
});

test('a different mouse button, or any key, is a fine trigger', () => {
  assert.equal(AC.hotkeyConflictsWithButton('MouseRight', 0), false, 'hold right, click left');
  assert.equal(AC.hotkeyConflictsWithButton('Mouse5', 0), false);
  assert.equal(AC.hotkeyConflictsWithButton('F6', 0), false);
  assert.equal(AC.hotkeyConflictsWithButton('Control+Shift+K', 2), false);
});

// ── Engine script integrity ────────────────────────────────────────────
test('the engine script still speaks the protocol main.js writes for it', () => {
  const s = AC.ENGINE_SCRIPT_CONTENT;
  for (const cmd of ['START ', 'SCAN ', 'STOP', 'WATCH', 'EXIT', 'PING']) {
    assert.ok(s.includes(`"${cmd}"`) || s.includes(`("${cmd}")`) || s.includes(cmd),
      `handles the ${cmd.trim()} command`);
  }
  for (const emit of ['READY', 'STARTED', 'PROGRESS ', 'HUNT ', 'SCANRES ', 'KEY-DOWN ', 'WATCH-OK ']) {
    assert.ok(s.includes(emit), `emits ${emit.trim()}`);
  }
  assert.ok(s.includes('DONE ') && s.includes('STOPPED '), 'emits a terminal DONE/STOPPED');
});

test('every config key main writes is parsed by the engine', () => {
  const s = AC.ENGINE_SCRIPT_CONTENT;
  const keys = ['mode', 'x', 'y', 'ax', 'ay', 'aw', 'ah', 'pattern', 'stepx', 'stepy', 'button',
    'perclick', 'pressms', 'gapms', 'interval', 'jitter', 'limit', 'duration', 'startdelay',
    'restore', 'spread', 'cr', 'cg', 'cb', 'tol', 'scanstep', 'target', 'rescan', 'mindist',
    'ex', 'ey', 'ew', 'eh', 'cr2', 'cg2', 'cb2', 'use2'];
  for (const k of keys) {
    assert.ok(s.includes(`case "${k}":`), `engine parses the "${k}" config key`);
  }
});

test('the engine enforces the skip zone on every area pattern', () => {
  const s = AC.ENGINE_SCRIPT_CONTENT;
  assert.ok(s.includes('static bool Excluded(Cfg c, int x, int y)'), 'has an exclusion test');
  // Sweep filters at build time; random re-rolls; centre bails; scatter is checked.
  assert.ok(/if \(Excluded\(c, x, y\)\) continue;/.test(s), 'sweep drops excluded cells');
  assert.ok(/if \(!Excluded\(c, tx, ty\)\) \{ hasTarget = true; break; \}/.test(s), 'random re-rolls past the zone');
  assert.ok(/if \(Excluded\(c, tx, ty\)\) break;/.test(s), 'centre pattern bails when excluded');
  assert.ok(/if \(!Excluded\(c, jx, jy\)\) \{ tx = jx; ty = jy; \}/.test(s), 'aim scatter cannot push a click inside');
});

test('the engine matches either colour when a second one is set', () => {
  const s = AC.ENGINE_SCRIPT_CONTENT;
  assert.ok(s.includes('static bool ColorMatches(Cfg c, int r, int g, int b)'), 'has a shared match test');
  assert.ok(/c\.use2 != 0/.test(s), 'the second colour is gated behind use2');
  assert.ok(s.includes('ColorMatches(c, r, gg, b)'), 'the scanner uses it');
});

test('the engine releases the button and cannot be left stuck down', () => {
  const s = AC.ENGINE_SCRIPT_CONTENT;
  // Run() must always end with a button-up, otherwise stopping mid-click would
  // leave the mouse held down system-wide.
  assert.ok(/SendBtn\(c\.button, false\);\s*\/\/ never leave a button stuck down/.test(s),
    'Run() force-releases the click button when it ends');
});

test('the engine script is a PowerShell here-string that closes properly', () => {
  const s = AC.ENGINE_SCRIPT_CONTENT;
  assert.ok(s.startsWith('Add-Type'), 'starts with Add-Type');
  assert.ok(s.includes("@'"), 'opens a literal here-string');
  assert.ok(s.includes("\n'@"), 'closes the here-string at column 0');
  assert.ok(s.trimEnd().endsWith('[AutoClickEngine]::RunHost()'), 'invokes the host last');
  assert.ok(!s.includes('${'), 'no unescaped JS interpolation leaked into the script');
});

// ── Renderer pure helpers ──────────────────────────────────────────────
// renderer/autoclicker.js is a browser classic script, so it's evaluated in a
// sandbox with the globals it touches at load time.
function loadRenderer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'autoclicker.js'), 'utf8');
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null },
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    localStorage: { getItem: () => null, setItem: noop },
    esc: (s) => String(s),
    showToast: noop,
    formatHotkeyDisplay: (a) => (a || '-'),
    getComputedStyle: () => ({ getPropertyValue: () => '255, 255, 255' })
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'autoclicker.js' });
  return sandbox;
}

test('renderer script evaluates in a browser-like context', () => {
  const r = loadRenderer();
  assert.equal(typeof r.renderAutoClickerPanel, 'function', 'the panel renderer the registry names exists');
  assert.equal(typeof r.acToggleRun, 'function');
  assert.equal(typeof r.acPick, 'function');
});

test('acMsParts / acFormatDuration split time the way the four inputs do', () => {
  const { acMsParts, acFormatDuration } = loadRenderer();
  // The sandbox is a separate realm, so its objects fail a prototype-strict
  // deepEqual — compare the plain values instead.
  const parts = (ms) => JSON.parse(JSON.stringify(acMsParts(ms)));
  assert.deepEqual(parts(0), { h: 0, m: 0, s: 0, ms: 0 });
  assert.deepEqual(parts(1500), { h: 0, m: 0, s: 1, ms: 500 });
  assert.deepEqual(parts(3661001), { h: 1, m: 1, s: 1, ms: 1 });
  assert.equal(acFormatDuration(250), '250ms');
  assert.equal(acFormatDuration(5000), '5s');
});

test('the rate readout accounts for press time, not just the interval', () => {
  const { acRate, acCycleMs } = loadRenderer();
  const base = { interval: 100, pressMs: 20, clickType: 'single', mode: 'cursor' };
  assert.equal(acCycleMs(base), 120, 'interval + press');
  assert.ok(Math.abs(acRate(base) - 1000 / 120) < 1e-9);

  // A double click costs two presses plus the gap between them.
  const dbl = { ...base, clickType: 'double' };
  assert.ok(acCycleMs(dbl) > acCycleMs(base), 'a double click is slower than a single');

  // Targeted modes pay for the pointer move.
  assert.ok(acCycleMs({ ...base, mode: 'area' }) > acCycleMs(base));
  assert.ok(acRate({ interval: 1, pressMs: 1, clickType: 'single', mode: 'cursor' }) > 100,
    'a 1ms interval yields a high rate, not Infinity or NaN');
});

test('acBlocker names exactly what stops Start from working', () => {
  const { acBlocker } = loadRenderer();
  const base = { mode: 'cursor', button: 0, hotkey: 'F6', area: null, point: null };
  assert.equal(acBlocker(base), null, 'cursor mode needs nothing set up');
  assert.match(acBlocker({ ...base, mode: 'point' }), /Pick the point/);
  assert.match(acBlocker({ ...base, mode: 'area' }), /Select the region/);
  assert.match(acBlocker({ ...base, mode: 'color' }), /Select the region/);
  assert.equal(acBlocker({ ...base, mode: 'area', area: { x: 0, y: 0, w: 10, h: 10 } }), null);
  // The runaway-trigger case is surfaced to the user, not just refused deep down.
  assert.match(acBlocker({ ...base, hotkey: 'MouseLeft', button: 0 }), /same button/);
});

test('the panel refuses a skip zone that swallows the whole region', () => {
  const { acBlocker, acExclusionCoversArea, acCentreExcluded } = loadRenderer();
  const area = { x: 100, y: 100, w: 200, h: 200 };
  const base = { mode: 'area', button: 0, hotkey: 'F6', point: null, pattern: 'random', area };

  assert.equal(acBlocker({ ...base, exclude: null }), null, 'no zone is fine');
  assert.equal(acBlocker({ ...base, exclude: { x: 120, y: 120, w: 50, h: 50 } }), null, 'a partial zone is fine');
  assert.match(acBlocker({ ...base, exclude: { x: 90, y: 90, w: 300, h: 300 } }), /covers the whole region/);

  assert.equal(acExclusionCoversArea({ area, exclude: { x: 100, y: 100, w: 200, h: 200 } }), true, 'exact cover counts');
  assert.equal(acExclusionCoversArea({ area, exclude: { x: 101, y: 100, w: 200, h: 200 } }), false, 'offset by 1 does not');
  assert.equal(acExclusionCoversArea({ area, exclude: null }), false);
});

test('the panel flags a Centre pattern whose one target is excluded', () => {
  const { acBlocker, acCentreExcluded } = loadRenderer();
  const area = { x: 0, y: 0, w: 200, h: 200 };
  const overCentre = { x: 80, y: 80, w: 40, h: 40 };   // contains (100,100)
  assert.equal(acCentreExcluded({ area, exclude: overCentre }), true);
  assert.equal(acCentreExcluded({ area, exclude: { x: 0, y: 0, w: 20, h: 20 } }), false);
  const c = { mode: 'area', button: 0, hotkey: 'F6', point: null, pattern: 'center', area, exclude: overCentre };
  assert.match(acBlocker(c), /Centre has nothing to click/);
  // The same zone is harmless for the other patterns.
  assert.equal(acBlocker({ ...c, pattern: 'random' }), null);
});

test('acHotkeyConflict in the renderer agrees with the main-process rule', () => {
  const { acHotkeyConflict } = loadRenderer();
  for (const [hotkey, button] of [['MouseLeft', 0], ['MouseRight', 1], ['Mouse4', 3]]) {
    assert.equal(acHotkeyConflict({ hotkey, button }), AC.hotkeyConflictsWithButton(hotkey, button),
      `${hotkey} vs button ${button} agrees across processes`);
  }
  assert.equal(acHotkeyConflict({ hotkey: 'F6', button: 0 }), false);
});

test('acFormatRate stays readable across the whole range', () => {
  const { acFormatRate } = loadRenderer();
  assert.equal(acFormatRate(100), '100.0');
  assert.equal(acFormatRate(2.5), '2.50');
  assert.equal(acFormatRate(0.5), '0.500');
});
