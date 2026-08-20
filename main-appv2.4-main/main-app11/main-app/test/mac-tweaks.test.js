// P2.2 — macOS Tweaks settings.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../main/macTweaks.settings');

test('TWEAKS is a sane, unique schema with valid apply targets', () => {
  assert.ok(t.TWEAKS.length >= 15);
  const ids = t.TWEAKS.map(x => x.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  for (const x of t.TWEAKS) {
    assert.ok(x.id && x.label && x.group && x.domain && x.key && x.type, `well-formed: ${x.id}`);
    assert.ok(['bool', 'int', 'float', 'string'].includes(x.type));
    assert.ok(x.apply === null || t.APPLY_SERVICES.includes(x.apply), `valid apply for ${x.id}`);
    assert.ok('on' in x && 'off' in x, `on/off present for ${x.id}`);
  }
});

test('tweakSetArgs: enabling writes the ON value', () => {
  const p = t.tweakSetArgs('finderHidden', true);
  assert.equal(p.del, false);
  assert.deepEqual(p.args, ['write', 'com.apple.finder', 'AppleShowAllFiles', '-bool', 'true']);
});

test('tweakSetArgs: disabling a bool writes the OFF value', () => {
  const p = t.tweakSetArgs('finderHidden', false);
  assert.deepEqual(p.args, ['write', 'com.apple.finder', 'AppleShowAllFiles', '-bool', 'false']);
});

test('tweakSetArgs: disabling a "delete-to-default" tweak deletes the key', () => {
  const p = t.tweakSetArgs('fastKeyRepeat', false);
  assert.equal(p.del, true);
  assert.deepEqual(p.args, ['delete', 'NSGlobalDomain', 'KeyRepeat']);
});

test('tweakSetArgs: string tweak on = write, off = delete', () => {
  assert.deepEqual(t.tweakSetArgs('listView', true).args, ['write', 'com.apple.finder', 'FXPreferredViewStyle', '-string', 'Nlsv']);
  assert.deepEqual(t.tweakSetArgs('listView', false), { del: true, args: ['delete', 'com.apple.finder', 'FXPreferredViewStyle'] });
});

test('tweakSetArgs: "on = false" tweaks (press-and-hold) enable by writing false', () => {
  const p = t.tweakSetArgs('pressAndHold', true);
  assert.deepEqual(p.args, ['write', 'NSGlobalDomain', 'ApplePressAndHoldEnabled', '-bool', 'false']);
  // disabling restores the default (delete)
  assert.equal(t.tweakSetArgs('pressAndHold', false).del, true);
});

test('tweakSetArgs: unknown tweak → null', () => {
  assert.equal(t.tweakSetArgs('rm -rf', true), null);
});

test('tweakIsOn: matches the ON value, unset reads as off', () => {
  assert.equal(t.tweakIsOn('finderHidden', '1', true), true);
  assert.equal(t.tweakIsOn('finderHidden', '0', true), false);
  assert.equal(t.tweakIsOn('finderHidden', '', false), false); // key unset
  assert.equal(t.tweakIsOn('listView', 'Nlsv', true), true);
  assert.equal(t.tweakIsOn('listView', 'icnv', true), false);
  assert.equal(t.tweakIsOn('pressAndHold', '0', true), true); // on == false
});

test('tweakReadArgs / tweakApplyService', () => {
  assert.deepEqual(t.tweakReadArgs('pathBar'), ['read', 'com.apple.finder', 'ShowPathbar']);
  assert.equal(t.tweakReadArgs('nope'), null);
  assert.equal(t.tweakApplyService('finderHidden'), 'Finder');
  assert.equal(t.tweakApplyService('screenshotPng'), 'SystemUIServer');
  assert.equal(t.tweakApplyService('fastKeyRepeat'), null);
});
