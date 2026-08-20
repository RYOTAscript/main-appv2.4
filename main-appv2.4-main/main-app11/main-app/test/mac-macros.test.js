// P2.6 — mac Macros playback logic (step → osascript / cliclick).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../main/macMacros.logic');

// ── validation ─────────────────────────────────────────────────────────
test('isValidStep accepts good steps, rejects junk', () => {
  assert.ok(L.isValidStep({ t: 'text', s: 'hi' }));
  assert.ok(L.isValidStep({ t: 'delay', ms: 500 }));
  assert.ok(L.isValidStep({ t: 'key', key: 'return', mods: ['cmd'] }));
  assert.ok(L.isValidStep({ t: 'key', key: 'a' }));
  assert.ok(L.isValidStep({ t: 'click', x: 10, y: 20 }));
  assert.equal(L.isValidStep({ t: 'key', key: 'notakey' }), false); // >1 char, not named
  assert.equal(L.isValidStep({ t: 'click', x: 'a', y: 1 }), false);
  assert.equal(L.isValidStep({ t: 'bogus' }), false);
  assert.equal(L.isValidStep(null), false);
});

test('macroNeedsMouse detects click/move', () => {
  assert.equal(L.macroNeedsMouse([{ t: 'text', s: 'x' }]), false);
  assert.equal(L.macroNeedsMouse([{ t: 'text', s: 'x' }, { t: 'click', x: 1, y: 2 }]), true);
  assert.equal(L.macroNeedsMouse([{ t: 'move', x: 1, y: 2 }]), true);
});

// ── osascript path (keyboard-only) ─────────────────────────────────────
test('stepToOsascript: text / delay / key with + without mods / named key', () => {
  assert.deepEqual(L.stepToOsascript({ t: 'text', s: 'hi' }), ['keystroke "hi"']);
  assert.deepEqual(L.stepToOsascript({ t: 'delay', ms: 500 }), ['delay 0.5']);
  assert.deepEqual(L.stepToOsascript({ t: 'key', key: 'c', mods: ['cmd'] }), ['keystroke "c" using {command down}']);
  assert.deepEqual(L.stepToOsascript({ t: 'key', key: 'return' }), ['key code 36']);
  assert.deepEqual(L.stepToOsascript({ t: 'key', key: 'arrow-up', mods: ['shift', 'opt'] }), ['key code 126 using {shift down, option down}']);
  assert.equal(L.stepToOsascript({ t: 'click', x: 1, y: 2 }), null); // mouse → not osascript
});

test('buildOsascript returns null when a mouse step is present', () => {
  assert.deepEqual(L.buildOsascript([{ t: 'text', s: 'a' }, { t: 'delay', ms: 100 }]), ['keystroke "a"', 'delay 0.1']);
  assert.equal(L.buildOsascript([{ t: 'text', s: 'a' }, { t: 'click', x: 1, y: 2 }]), null);
});

test('osascript escapes quotes in typed text', () => {
  assert.deepEqual(L.stepToOsascript({ t: 'text', s: 'say "hi"' }), ['keystroke "say \\"hi\\""']);
});

// ── cliclick path (full) ───────────────────────────────────────────────
test('stepToCliclick: every step type → tokens', () => {
  assert.deepEqual(L.stepToCliclick({ t: 'text', s: 'hello' }), ['t:hello']);
  assert.deepEqual(L.stepToCliclick({ t: 'delay', ms: 250 }), ['w:250']);
  assert.deepEqual(L.stepToCliclick({ t: 'key', key: 'return' }), ['kp:return']);
  assert.deepEqual(L.stepToCliclick({ t: 'key', key: 'c', mods: ['cmd'] }), ['kd:cmd', 't:c', 'ku:cmd']);
  assert.deepEqual(L.stepToCliclick({ t: 'key', key: 'return', mods: ['cmd', 'shift'] }), ['kd:cmd,shift', 'kp:return', 'ku:cmd,shift']);
  assert.deepEqual(L.stepToCliclick({ t: 'click', x: 100, y: 200 }), ['c:100,200']);
  assert.deepEqual(L.stepToCliclick({ t: 'move', x: 5, y: 6 }), ['m:5,6']);
});

test('buildCliclick flattens a whole macro into one argv', () => {
  const tokens = L.buildCliclick([
    { t: 'text', s: 'hi' },
    { t: 'delay', ms: 100 },
    { t: 'key', key: 'return' },
    { t: 'click', x: 1, y: 2 },
  ]);
  assert.deepEqual(tokens, ['t:hi', 'w:100', 'kp:return', 'c:1,2']);
});

test('mods are normalised + de-duped (opt→alt, unknown dropped)', () => {
  assert.deepEqual(L.stepToCliclick({ t: 'key', key: 'a', mods: ['opt', 'opt', 'bogus'] }), ['kd:alt', 't:a', 'ku:alt']);
});

test('step count is capped', () => {
  const many = Array.from({ length: 500 }, () => ({ t: 'text', s: 'x' }));
  assert.equal(L.buildCliclick(many).length, L.MAX_STEPS);
});
