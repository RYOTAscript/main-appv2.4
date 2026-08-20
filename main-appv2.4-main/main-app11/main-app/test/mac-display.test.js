// P2.4 — displayplacer parsing + set-spec building.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dp = require('../main/displayplacer');

const SAMPLE = `Persistent screen id: 37D8832A-2D66-02CA-B9F7-8F30A301B230
Contextual screen id: 0
Type: 27 inch external screen
Resolution: 2560x1440
Hertz: 60
Color Depth: 8
Scaling: on
Origin: (0,0) - main display
Rotation: 0
Enabled: true

Resolutions for rotation 0:
  mode 0: res:1280x720 hz:60 color_depth:8
  mode 1: res:1920x1080 hz:60 color_depth:8
  mode 2: res:2560x1440 hz:60 color_depth:8 <-- current mode
  mode 3: res:2560x1440 hz:60 color_depth:4

Persistent screen id: 11111111-2222-3333-4444-555555555555
Contextual screen id: 1
Type: MacBook built in screen
Resolution: 1728x1117
Hertz: 120
Color Depth: 8
Scaling: on
Origin: (2560,0)
Rotation: 0
Enabled: true

Resolutions for rotation 0:
  mode 0: res:1512x982 hz:120 color_depth:8
  mode 1: res:1728x1117 hz:120 color_depth:8 <-- current mode
`;

test('parseDisplayplacerList extracts both displays', () => {
  const mons = dp.parseDisplayplacerList(SAMPLE);
  assert.equal(mons.length, 2);
});

test('parses id, name, primary and current mode', () => {
  const [ext, builtin] = dp.parseDisplayplacerList(SAMPLE);
  assert.equal(ext.id, '37D8832A-2D66-02CA-B9F7-8F30A301B230');
  assert.equal(ext.name, '27 inch external screen');
  assert.equal(ext.primary, true, 'external is the main display');
  assert.deepEqual(ext.current, { width: 2560, height: 1440, refresh: 60 });

  assert.equal(builtin.primary, false);
  assert.deepEqual(builtin.current, { width: 1728, height: 1117, refresh: 120 });
});

test('parses + dedupes the mode list', () => {
  const [ext] = dp.parseDisplayplacerList(SAMPLE);
  // mode 2 and mode 3 are both 2560x1440@60 — deduped to one.
  const at1440 = ext.modes.filter(m => m.width === 2560 && m.height === 1440 && m.refresh === 60);
  assert.equal(at1440.length, 1);
  assert.ok(ext.modes.some(m => m.width === 1920 && m.height === 1080 && m.refresh === 60));
  assert.ok(ext.modes.some(m => m.width === 1280 && m.height === 720));
});

test('skips disabled displays', () => {
  const off = SAMPLE.replace('Enabled: true\n\nResolutions for rotation 0:\n  mode 0: res:1512x982', 'Enabled: false\n\nResolutions for rotation 0:\n  mode 0: res:1512x982');
  const mons = dp.parseDisplayplacerList(off);
  assert.equal(mons.length, 1, 'the disabled built-in display is dropped');
});

test('setModeArg builds a single displayplacer argument', () => {
  assert.equal(dp.setModeArg('ABC', 1920, 1080, 60), 'id:ABC res:1920x1080 hz:60 color_depth:8');
  assert.equal(dp.setModeArg('ABC', 1920, 1080, 60, 4), 'id:ABC res:1920x1080 hz:60 color_depth:4');
});

test('colorDepthFor finds a mode’s depth, else 8', () => {
  const [ext] = dp.parseDisplayplacerList(SAMPLE);
  assert.equal(dp.colorDepthFor(ext, 2560, 1440, 60), 8);
  assert.equal(dp.colorDepthFor(ext, 9999, 9999, 60), 8); // unknown → default
  assert.equal(dp.colorDepthFor(null, 1, 1, 1), 8);
});

test('empty / junk input → no monitors', () => {
  assert.deepEqual(dp.parseDisplayplacerList(''), []);
  assert.deepEqual(dp.parseDisplayplacerList('garbage'), []);
});
