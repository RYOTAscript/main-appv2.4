// Unit tests for main/platform.js — the main-process OS-detection helper.
// Runs on plain Node (no Electron), so `make(platform)` lets us exercise every
// OS branch from one Windows process.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const platformModule = require('../main/platform');
const { make } = platformModule;

test('make(win32) sets only isWindows', () => {
  const p = make('win32');
  assert.equal(p.platform, 'win32');
  assert.equal(p.isWindows, true);
  assert.equal(p.isMac, false);
  assert.equal(p.isLinux, false);
});

test('make(darwin) sets only isMac', () => {
  const p = make('darwin');
  assert.equal(p.platform, 'darwin');
  assert.equal(p.isWindows, false);
  assert.equal(p.isMac, true);
  assert.equal(p.isLinux, false);
});

test('make(linux) sets only isLinux', () => {
  const p = make('linux');
  assert.equal(p.isWindows, false);
  assert.equal(p.isMac, false);
  assert.equal(p.isLinux, true);
});

test('pick() chooses the matching platform value', () => {
  const map = { win32: 'W', darwin: 'M', linux: 'L', default: 'D' };
  assert.equal(make('win32').pick(map), 'W');
  assert.equal(make('darwin').pick(map), 'M');
  assert.equal(make('linux').pick(map), 'L');
});

test('pick() falls back to default when the OS key is absent', () => {
  const map = { win32: 'W', default: 'D' };
  assert.equal(make('darwin').pick(map), 'D');
  assert.equal(make('linux').pick(map), 'D');
});

test('pick() returns undefined with no match and no default', () => {
  assert.equal(make('darwin').pick({ win32: 'W' }), undefined);
});

test('pick() tolerates bad input', () => {
  assert.equal(make('darwin').pick(null), undefined);
  assert.equal(make('darwin').pick(undefined), undefined);
  assert.equal(make('darwin').pick('nope'), undefined);
});

test('pick() can return falsy values that are explicitly provided', () => {
  // A caller may legitimately map an OS to '' / false / 0 — pick must return it,
  // not skip to default (uses `in`, not truthiness).
  assert.equal(make('darwin').pick({ darwin: '', default: 'X' }), '');
  assert.equal(make('darwin').pick({ darwin: false, default: true }), false);
  assert.equal(make('win32').pick({ win32: 0, default: 9 }), 0);
});

test('top-level exports bind to the real process.platform', () => {
  assert.equal(platformModule.platform, process.platform);
  assert.equal(typeof platformModule.isWindows, 'boolean');
  assert.equal(typeof platformModule.pick, 'function');
  // Exactly one of the three flags is true for the host we run on.
  const trues = [platformModule.isWindows, platformModule.isMac, platformModule.isLinux].filter(Boolean);
  assert.ok(trues.length <= 1, 'at most one platform flag is set');
});
