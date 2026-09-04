'use strict';
// The wake word going deaf after the overlay was dismissed.
//
// The wake gate discards a wake phrase with no speech-level audio behind it,
// which is what stops the assistant waking itself on room noise. It used to
// read `peakLevel` — a maximum reset when a COMMAND session starts and raised
// only by LEVEL messages. The host sent no LEVEL messages in wake mode, so that
// number could not change while waking: dismissing the overlay without speaking
// (Esc) left it at the near-silence floor, and every wake from then on was
// dropped. The mic was open, the phrase was recognised, and nothing happened.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const assistant = fs.readFileSync(path.join(APP, 'main', 'voiceAssistant.js'), 'utf8');
const host = fs.readFileSync(path.join(APP, 'main', 'voiceHostScript.js'), 'utf8');

test('the host measures audio levels in wake mode as well as command mode', () => {
  const fn = host.match(/static void OnLevel\([^)]*\)\s*\{[\s\S]*?\n    \}/);
  assert.ok(fn, 'OnLevel not found');
  assert.ok(!/mode == "wake"/.test(fn[0]),
    'OnLevel must not skip wake mode — the wake gate has no other source of evidence');
});

test('the wake gate reads the rolling window, never the session peak', () => {
  const at = assistant.indexOf('const recent = recentPeak();');
  assert.ok(at !== -1, 'wake gate not found');
  const gate = assistant.slice(at, assistant.indexOf('return;', at));
  assert.ok(/levelWindow\.length >= MIN_LEVEL_SAMPLES/.test(gate),
    'sample count must come from the window too, or a stale count re-arms the gate');
  assert.ok(!/peakLevel/.test(gate), 'the wake gate must not consult the session peak');
  assert.ok(/recent < wakeFloor/.test(gate), 'and it compares against the learned floor');
});

test('the window is emptied wherever the session peak is', () => {
  // Both counts include the declaration, so they must simply agree.
  const resets = assistant.match(/peakLevel = 0;/g) || [];
  const windows = assistant.match(/levelWindow = \[\];/g) || [];
  assert.strictEqual(windows.length, resets.length,
    'every peakLevel reset must clear levelWindow, or the window outlives its session');
});

test('idle wake levels are not pushed at the hidden overlay', () => {
  assert.ok(/if \(V\.isMicOpenState\(state\)\) sendOverlay\('voice:overlay-level'/.test(assistant),
    'the meter must only be sent while the overlay is actually open');
});

test('the host script version was bumped, so the cached .ps1 is regenerated', () => {
  const v = host.match(/const VOICE_HOST_SCRIPT_VERSION = (\d+);/);
  assert.ok(v && Number(v[1]) >= 8, 'a host body change that is not versioned ships nothing');
});
