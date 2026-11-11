'use strict';

// What an idle frame is allowed to cost.
//
// This app is an always-on overlay, so its animation loops spend most of their
// life with nothing to animate — paused music, no beat, a vinyl that is not
// turning. Two rAF loops in renderer/beat-glow.js run for the whole session and
// are never cancelled, and both were doing full work on every one of those idle
// frames:
//
//   • tickBeatEngine() called resetBeatGlowVisuals() every frame once the glow
//     had faded — two getElementById lookups and three style writes per frame,
//     forever, to set values that were already set.
//   • animateSpotifyDisk() looked the disk up by id and wrote a transform every
//     frame regardless of whether it had moved. The easing never reaches zero,
//     so "stopped" was still writing a new angle 60 times a second.
//   • Both read their settings from localStorage on EVERY frame — a synchronous
//     storage read plus a parseFloat, ~120 times a second.
//
// None of that is visible in a profile of the interesting case, which is why it
// survived: it only costs anything when nothing is happening. These tests run
// the REAL renderer file in a vm with a counting DOM, so a regression shows up
// as a number rather than as a slightly warmer laptop.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const beatGlowSrc = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'beat-glow.js'), 'utf8');

/**
 * Boot the real beat-glow.js in a sandbox with a DOM that counts what it is
 * asked to do. Mirrors the browser load order: settings.js defines the two
 * setting helpers, then beat-glow.js is loaded as a classic script.
 */
function bootBeatGlow({ storedAngle = '0' } = {}) {
  const counts = { lookups: 0, styleWrites: 0, settingReads: 0, storageWrites: 0, raf: 0 };

  const makeEl = () => {
    const style = {};
    // Count every property assignment on .style without hiding the value.
    return { isConnected: true, style: new Proxy(style, {
      set(target, prop, value) { counts.styleWrites++; target[prop] = value; return true; },
    }) };
  };
  const elements = {
    'spotify-disk': makeEl(),
    'spotify-beat-glow': makeEl(),
  };

  const store = new Map([['spotifyDiskAngle', storedAngle]]);

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    Date,
    Math,
    Number,
    parseFloat,
    isNaN,
    document: {
      getElementById(id) { counts.lookups++; return elements[id] || null; },
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { counts.storageWrites++; store.set(k, String(v)); },
    },
    requestAnimationFrame: () => { counts.raf++; return 0; },
    setInterval: () => 0,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  // The two helpers beat-glow.js calls that actually live in settings.js. Real
  // implementations, so the storage reads they do are the ones being counted.
  vm.runInContext(`
    function isBeatGlowEnabled() {
      __countSettingRead();
      return localStorage.getItem('spotifyBeatGlow') !== 'false';
    }
    function getBeatGlowIntensity() {
      __countSettingRead();
      const stored = parseFloat(localStorage.getItem('spotifyBeatGlowIntensity'));
      if (isNaN(stored)) return 1;
      return Math.min(3, Math.max(0.5, stored));
    }
  `, sandbox, { filename: 'settings.js#stub' });
  sandbox.__countSettingRead = () => { counts.settingReads++; };

  vm.runInContext(beatGlowSrc, sandbox, { filename: 'beat-glow.js' });

  return {
    counts,
    elements,
    store,
    // Top-level `let` lives in the global lexical scope, not on the sandbox
    // object, so it is reached by evaluating an expression in the same context.
    get: (expr) => vm.runInContext(expr, sandbox),
    run: (code) => vm.runInContext(code, sandbox),
    reset: () => {
      counts.lookups = 0; counts.styleWrites = 0;
      counts.settingReads = 0; counts.storageWrites = 0; counts.raf = 0;
    },
  };
}

test('a parked vinyl costs nothing per frame', () => {
  const app = bootBeatGlow({ storedAngle: '0' });
  app.run('spotifyTargetVelocity = 0;');

  // The first idle frame still paints once — that is the write that restores the
  // saved angle on a cold start.
  app.run('animateSpotifyDisk();');
  app.reset();

  app.run('for (let i = 0; i < 300; i++) animateSpotifyDisk();');
  assert.equal(app.counts.styleWrites, 0,
    'a stationary disk must not write a transform on every frame');
  assert.equal(app.counts.lookups, 0,
    'a stationary disk must not resolve the element on every frame');
});

test('the saved angle is restored, once, rather than reset to zero', () => {
  const app = bootBeatGlow({ storedAngle: '123.5' });
  assert.equal(app.get('spotifyDiskAngle'), 123.5, 'the stored angle is read back');

  app.run('spotifyTargetVelocity = 0;');
  app.run('for (let i = 0; i < 200; i++) animateSpotifyDisk();');
  assert.equal(app.counts.styleWrites, 1,
    'exactly one paint: the resting angle, then silence');
  assert.equal(app.elements['spotify-disk'].style.transform, 'rotate(123.5deg)',
    'and it paints the angle the vinyl was left at, not 0');
});

test('a corrupt stored angle falls back to 0 instead of poisoning every transform', () => {
  // NaN makes `rotate(NaNdeg)` invalid, so the vinyl silently never turns again.
  const app = bootBeatGlow({ storedAngle: 'not-a-number' });
  assert.equal(app.get('spotifyDiskAngle'), 0);
});

test('a turning vinyl still animates on every frame', () => {
  // The optimisation must not cost the actual animation any frames.
  const app = bootBeatGlow();
  app.run('spotifyTargetVelocity = 1.8;');
  app.reset();
  app.run('for (let i = 0; i < 60; i++) animateSpotifyDisk();');
  assert.equal(app.counts.styleWrites, 60, 'one transform per frame while spinning');
  assert.ok(app.get('spotifyDiskAngle') !== 0, 'and the angle actually advances');
});

test('the vinyl coasts to a stop and then stays quiet', () => {
  const app = bootBeatGlow();
  app.run('spotifyTargetVelocity = 1.8;');
  app.run('for (let i = 0; i < 120; i++) animateSpotifyDisk();');
  // Pause: it should ease down and then park.
  app.run('spotifyTargetVelocity = 0;');
  app.run('for (let i = 0; i < 3000; i++) animateSpotifyDisk();');
  const resting = app.get('spotifyDiskAngle');
  app.reset();
  app.run('for (let i = 0; i < 300; i++) animateSpotifyDisk();');
  assert.equal(app.counts.styleWrites, 0, 'a parked vinyl writes nothing');
  assert.equal(app.get('spotifyDiskAngle'), resting, 'and its angle stops drifting');
});

test('starting the disk loop twice does not race two loops over one angle', () => {
  // Two rAF loops stepping the same angle would double the spin speed and
  // could never be untangled, because neither is cancellable.
  const app = bootBeatGlow();
  app.reset();
  app.run('startSpotifyDisk(); startSpotifyDisk(); startSpotifyDisk();');
  assert.equal(app.counts.raf, 1, 'only the first call may start a loop');
});

test('the angle is only persisted when it has actually changed', () => {
  const app = bootBeatGlow();
  // The 2s persist tick, called by hand. Nothing has moved.
  const persist = `
    if (spotifyDiskAngle !== diskAngleSaved) {
      diskAngleSaved = spotifyDiskAngle;
      localStorage.setItem('spotifyDiskAngle', spotifyDiskAngle.toString());
    }`;
  app.reset();
  app.run(persist);
  app.run(persist);
  assert.equal(app.counts.storageWrites, 0,
    'a paused launcher must not rewrite the same angle every two seconds');

  app.run('spotifyTargetVelocity = 1.8;');
  app.run('for (let i = 0; i < 30; i++) animateSpotifyDisk();');
  app.run(persist);
  assert.equal(app.counts.storageWrites, 1, 'but a moved vinyl is saved');
});

test('the glow settings are read a few times a second, not a few times a frame', () => {
  const app = bootBeatGlow();
  const now = Date.now();
  app.reset();
  // A full second of frames, all inside one refresh window boundary.
  app.run(`for (let i = 0; i < 120; i++) refreshGlowSettings(${now});`);
  assert.equal(app.counts.settingReads, 2,
    '120 frames must cost one refresh (enabled + intensity), not 240 storage reads');

  app.reset();
  app.run(`refreshGlowSettings(${now + 251});`);
  assert.equal(app.counts.settingReads, 2,
    'and the cache still expires, so a changed setting is picked up');
});

test('an idle beat glow clears once, not on every frame', () => {
  const app = bootBeatGlow();
  app.run(`
    beatEngineState.isPlaying = false;
    beatGlowLevel = 0;
    beatGlowIdle = false;
  `);
  // First idle tick clears the visuals.
  app.run('tickBeatEngine();');
  assert.ok(app.counts.styleWrites > 0, 'the first idle frame does clear the glow');

  app.reset();
  app.run('for (let i = 0; i < 300; i++) tickBeatEngine();');
  assert.equal(app.counts.styleWrites, 0,
    'every idle frame after that must do no DOM work at all');
  assert.equal(app.counts.lookups, 0,
    'and must not keep resolving the halo and disk by id');
});
