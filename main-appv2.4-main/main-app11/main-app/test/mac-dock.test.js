// P2.1 — shared macOS `defaults` builders + Dock Styler settings.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const md = require('../main/macDefaults');
const dock = require('../main/dockStyler.settings');

// ── macDefaults (shared) ───────────────────────────────────────────────
test('formatValue renders each type for the CLI', () => {
  assert.equal(md.formatValue('bool', true), 'true');
  assert.equal(md.formatValue('bool', false), 'false');
  assert.equal(md.formatValue('int', 47.6), '48');
  assert.equal(md.formatValue('float', 0.5), '0.5');
  assert.equal(md.formatValue('string', 'left'), 'left');
});

test('coerceValue parses a defaults read value back to a JS type', () => {
  assert.equal(md.coerceValue('bool', '1'), true);
  assert.equal(md.coerceValue('bool', '0'), false);
  assert.equal(md.coerceValue('bool', 'true'), true);
  assert.equal(md.coerceValue('int', '48\n'), 48);
  assert.equal(md.coerceValue('float', '0.5'), 0.5);
  assert.equal(md.coerceValue('string', ' left \n'), 'left');
  assert.equal(md.coerceValue('int', 'nope'), null);
});

test('writeArgs/readArgs/deleteArgs build injection-safe argv arrays', () => {
  assert.deepEqual(md.writeArgs('com.apple.dock', 'tilesize', 'int', 48), ['write', 'com.apple.dock', 'tilesize', '-int', '48']);
  assert.deepEqual(md.readArgs('com.apple.dock', 'autohide'), ['read', 'com.apple.dock', 'autohide']);
  assert.deepEqual(md.deleteArgs('com.apple.dock', 'autohide'), ['delete', 'com.apple.dock', 'autohide']);
  assert.throws(() => md.writeArgs('d', 'k', 'bogus', 1));
});

// ── Dock Styler settings ───────────────────────────────────────────────
test('DOCK_SETTINGS is a sane schema', () => {
  assert.ok(dock.DOCK_SETTINGS.length >= 8);
  for (const s of dock.DOCK_SETTINGS) {
    assert.ok(s.key && s.label && s.type, `well-formed: ${JSON.stringify(s)}`);
    assert.ok(['bool', 'int', 'float', 'enum'].includes(s.type));
    if (s.type === 'enum') assert.ok(Array.isArray(s.options) && s.options.length);
  }
  // keys are unique
  const keys = dock.DOCK_SETTINGS.map(s => s.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('dockWriteArgs writes bools, clamps numbers, validates enums', () => {
  assert.deepEqual(dock.dockWriteArgs('autohide', true), ['write', 'com.apple.dock', 'autohide', '-bool', 'true']);
  // clamp above max (128)
  assert.deepEqual(dock.dockWriteArgs('tilesize', 999), ['write', 'com.apple.dock', 'tilesize', '-int', '128']);
  // clamp below min (16)
  assert.deepEqual(dock.dockWriteArgs('tilesize', 1), ['write', 'com.apple.dock', 'tilesize', '-int', '16']);
  // enum stored as -string
  assert.deepEqual(dock.dockWriteArgs('orientation', 'left'), ['write', 'com.apple.dock', 'orientation', '-string', 'left']);
  // invalid enum → null
  assert.equal(dock.dockWriteArgs('orientation', 'diagonal'), null);
  // unknown key → null
  assert.equal(dock.dockWriteArgs('rm -rf /', 'x'), null);
  // non-numeric for a number field → null
  assert.equal(dock.dockWriteArgs('tilesize', 'big'), null);
});

test('dockReadArgs / reset / coerce', () => {
  assert.deepEqual(dock.dockReadArgs('autohide'), ['read', 'com.apple.dock', 'autohide']);
  assert.equal(dock.dockReadArgs('nope'), null);
  const resets = dock.dockResetArgsList();
  assert.equal(resets.length, dock.DOCK_SETTINGS.length);
  assert.deepEqual(resets[0][0], 'delete');
  assert.equal(dock.dockCoerce('autohide', '1'), true);
  assert.equal(dock.dockCoerce('orientation', 'right'), 'right');
});
