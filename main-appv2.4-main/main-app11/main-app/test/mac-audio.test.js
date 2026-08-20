// Stage 4 — macOS audio (mic mute + system volume) pure logic + osascript builders.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const audio = require('../main/audioMac');
const osa = require('../main/osascript');

// ── clampVolume ────────────────────────────────────────────────────────
test('clampVolume pins to 0-100 integers', () => {
  assert.equal(audio.clampVolume(50), 50);
  assert.equal(audio.clampVolume(-10), 0);
  assert.equal(audio.clampVolume(150), 100);
  assert.equal(audio.clampVolume(42.6), 43);
  assert.equal(audio.clampVolume('30'), 30);
  assert.equal(audio.clampVolume('nonsense'), 0);
});

// ── inputMuteDecision (mic mute) ───────────────────────────────────────
test('status: reports muted iff input volume is 0, never changes it', () => {
  assert.deepEqual(audio.inputMuteDecision('status', 60, 50), { muted: false, setVolume: null });
  assert.deepEqual(audio.inputMuteDecision('status', 0, 50), { muted: true, setVolume: null });
});

test('toggle from audible → mutes to 0 and remembers the level', () => {
  const d = audio.inputMuteDecision('toggle', 73, 50);
  assert.equal(d.muted, true);
  assert.equal(d.setVolume, 0);
  assert.equal(d.remember, 73); // restore target saved by the caller
});

test('toggle from muted → restores the saved level', () => {
  assert.deepEqual(audio.inputMuteDecision('toggle', 0, 65), { muted: false, setVolume: 65 });
});

test('toggle from muted with no/invalid saved → restores to 100', () => {
  assert.deepEqual(audio.inputMuteDecision('toggle', 0, 0), { muted: false, setVolume: 100 });
  assert.deepEqual(audio.inputMuteDecision('toggle', 0, null), { muted: false, setVolume: 100 });
});

test('unknown current volume → muted:null (caller aborts)', () => {
  assert.deepEqual(audio.inputMuteDecision('toggle', null, 50), { muted: null, setVolume: null });
  assert.deepEqual(audio.inputMuteDecision('status', NaN, 50), { muted: null, setVolume: null });
});

// ── parseVolumeSettings ────────────────────────────────────────────────
test('parseVolumeSettings reads output/input volume + output muted', () => {
  const r = audio.parseVolumeSettings('output volume:50, input volume:75, alert volume:100, output muted:false');
  assert.deepEqual(r, { outputVolume: 50, inputVolume: 75, outputMuted: false });
});

test('parseVolumeSettings detects muted true and tolerates junk', () => {
  assert.equal(audio.parseVolumeSettings('output volume:0, output muted:true').outputMuted, true);
  const empty = audio.parseVolumeSettings('');
  assert.deepEqual(empty, { outputVolume: null, inputVolume: null, outputMuted: false });
});

// ── macEngineCommand (Windows engine protocol → macOS action) ──────────
test('macEngineCommand maps MASTER/MASTERMUTE, noops per-app SET/MUTE', () => {
  assert.deepEqual(audio.macEngineCommand('MASTER 40'), { kind: 'setOutputVolume', value: 40 });
  assert.deepEqual(audio.macEngineCommand('MASTER 999'), { kind: 'setOutputVolume', value: 100 });
  assert.deepEqual(audio.macEngineCommand('MASTERMUTE 1'), { kind: 'setOutputMuted', value: true });
  assert.deepEqual(audio.macEngineCommand('MASTERMUTE 0'), { kind: 'setOutputMuted', value: false });
  assert.deepEqual(audio.macEngineCommand('SET 1234 50'), { kind: 'noop' });
  assert.deepEqual(audio.macEngineCommand('MUTE 1234 1'), { kind: 'noop' });
});

// ── osascript audio command strings ────────────────────────────────────
test('osascript audio builders produce valid AppleScript', () => {
  assert.equal(osa.scripts.getInputVolume, 'input volume of (get volume settings)');
  assert.equal(osa.scripts.setInputVolume(0), 'set volume input volume 0');
  assert.equal(osa.scripts.setInputVolume(65), 'set volume input volume 65');
  assert.equal(osa.scripts.getVolumeSettings, 'get volume settings');
  assert.equal(osa.scripts.setOutputVolume(40), 'set volume output volume 40');
  assert.equal(osa.scripts.setOutputMuted(true), 'set volume output muted true');
  assert.equal(osa.scripts.setOutputMuted(false), 'set volume output muted false');
});

// End-to-end: a mute→unmute cycle round-trips the volume through the decisions.
test('mute then unmute restores the original input volume', () => {
  let saved = 50;
  const mute = audio.inputMuteDecision('toggle', 80, saved);
  assert.equal(mute.setVolume, 0);
  saved = mute.remember;                       // caller remembers 80
  const unmute = audio.inputMuteDecision('toggle', 0, saved);
  assert.equal(unmute.setVolume, 80);          // restored to the remembered level
  assert.equal(unmute.muted, false);
});
