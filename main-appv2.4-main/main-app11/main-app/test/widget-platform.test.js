// Unit tests for renderer/widget-platform.js — the pure widget-gating helpers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WP = require('../renderer/widget-platform.js');

const winOnly = { id: 'taskbar', platforms: ['win32'] };
const macAndWin = { id: 'clip', platforms: ['win32', 'darwin'] };
const anywhere = { id: 'timer' };
const emptyList = { id: 'weird', platforms: [] };
const nullList = { id: 'weird2', platforms: null };
const badList = { id: 'weird3', platforms: 'win32' }; // not an array

test('widgetSupportsPlatform: no platforms field → available everywhere', () => {
  assert.equal(WP.widgetSupportsPlatform(anywhere, 'win32'), true);
  assert.equal(WP.widgetSupportsPlatform(anywhere, 'darwin'), true);
  assert.equal(WP.widgetSupportsPlatform(anywhere, 'linux'), true);
});

test('widgetSupportsPlatform: empty / null / malformed list fails open (all platforms)', () => {
  assert.equal(WP.widgetSupportsPlatform(emptyList, 'darwin'), true);
  assert.equal(WP.widgetSupportsPlatform(nullList, 'darwin'), true);
  assert.equal(WP.widgetSupportsPlatform(badList, 'darwin'), true);
});

test('widgetSupportsPlatform: win32-only hidden on darwin, shown on win32', () => {
  assert.equal(WP.widgetSupportsPlatform(winOnly, 'win32'), true);
  assert.equal(WP.widgetSupportsPlatform(winOnly, 'darwin'), false);
  assert.equal(WP.widgetSupportsPlatform(winOnly, 'linux'), false);
});

test('widgetSupportsPlatform: multi-platform respects the list', () => {
  assert.equal(WP.widgetSupportsPlatform(macAndWin, 'win32'), true);
  assert.equal(WP.widgetSupportsPlatform(macAndWin, 'darwin'), true);
  assert.equal(WP.widgetSupportsPlatform(macAndWin, 'linux'), false);
});

test('widgetSupportsPlatform: bad widget input is not supported', () => {
  assert.equal(WP.widgetSupportsPlatform(null, 'win32'), false);
  assert.equal(WP.widgetSupportsPlatform(undefined, 'win32'), false);
  assert.equal(WP.widgetSupportsPlatform('nope', 'win32'), false);
});

test('filterWidgetsForPlatform: keeps only OS-available widgets, in order', () => {
  const all = [winOnly, macAndWin, anywhere];
  assert.deepEqual(WP.filterWidgetsForPlatform(all, 'win32').map(w => w.id), ['taskbar', 'clip', 'timer']);
  assert.deepEqual(WP.filterWidgetsForPlatform(all, 'darwin').map(w => w.id), ['clip', 'timer']);
  assert.deepEqual(WP.filterWidgetsForPlatform(all, 'linux').map(w => w.id), ['timer']);
});

test('filterWidgetsForPlatform: win32 keeps everything (no behaviour change on Windows)', () => {
  const all = [winOnly, macAndWin, anywhere, emptyList, nullList, badList];
  assert.equal(WP.filterWidgetsForPlatform(all, 'win32').length, all.length);
});

test('filterWidgetsForPlatform: never mutates input; non-array → []', () => {
  const all = [winOnly, anywhere];
  const snapshot = JSON.stringify(all);
  WP.filterWidgetsForPlatform(all, 'darwin');
  assert.equal(JSON.stringify(all), snapshot, 'input array untouched');
  assert.deepEqual(WP.filterWidgetsForPlatform(null, 'darwin'), []);
  assert.deepEqual(WP.filterWidgetsForPlatform(undefined, 'darwin'), []);
  assert.deepEqual(WP.filterWidgetsForPlatform('nope', 'darwin'), []);
});

test('currentPlatform: defaults to win32 with no electronAPI (never hides the Win catalogue)', () => {
  assert.equal(WP.currentPlatform(), 'win32');
});

test('exposes VALID_PLATFORMS and a global for the renderer', () => {
  assert.deepEqual(WP.VALID_PLATFORMS, ['win32', 'darwin', 'linux']);
  assert.ok(globalThis.WidgetPlatform, 'WidgetPlatform attached to global object');
  assert.equal(typeof globalThis.WidgetPlatform.currentPlatform, 'function');
});
