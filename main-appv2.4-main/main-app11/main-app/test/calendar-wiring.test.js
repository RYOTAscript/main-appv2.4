'use strict';

// The Calendar widget's seams. Every one of these is a thing that fails
// SILENTLY in a running app: an IPC channel with no preload method, a registry
// entry pointing at a renderer that doesn't exist, a script tag in the wrong
// order, a handler that never gets torn down. None of them throws at build
// time, and the app just quietly does nothing.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const mainSrc = read('main.js');
const calMainSrc = read('main', 'calendar.js');
const preloadSrc = read('preload.js');
const rendererSrc = read('renderer', 'calendar.js');
const coreSrc = read('renderer', 'core.js');
const htmlSrc = read('main.html');
const cssSrc = read('styles', 'calendar.css');
const widgetsSettingsSrc = read('renderer', 'widgets-settings.js');

function registryEntry() {
  const m = coreSrc.match(/const\s+MINI_WIDGETS_ALL\s*=\s*(\[[\s\S]*?\n\s*\]);/);
  assert.ok(m, 'MINI_WIDGETS_ALL located');
  // eslint-disable-next-line no-eval
  const reg = eval('(' + m[1] + ')');
  return reg.find(w => w.id === 'calendar');
}

test('the registry entry is complete and cross-platform', () => {
  const w = registryEntry();
  assert.ok(w, 'calendar is in MINI_WIDGETS_ALL');
  assert.equal(w.platforms, undefined, 'the calendar runs on every OS');
  assert.equal(w.panelId, 'calendar-panel');
  assert.equal(w.panelRenderer, 'renderCalendarPanel');
  assert.equal(w.category, 'Productivity');
  for (const field of ['label', 'icon', 'description', 'longDescription', 'version', 'author']) {
    assert.ok(w[field], `entry has ${field}`);
  }
  assert.ok(w.features.length >= 5, 'the detail view has something to list');
  assert.ok(w.keywords.includes('calendar') && w.keywords.includes('reminder'));
});

test('the panel renderer the registry names actually exists, and no-ops without its div', () => {
  assert.match(rendererSrc, /async function renderCalendarPanel\(\)/);
  const fn = rendererSrc.slice(rendererSrc.indexOf('async function renderCalendarPanel()'));
  const head = fn.slice(0, 400);
  assert.match(head, /getElementById\('calendar-panel'\)/);
  assert.match(head, /if \(!panel\)[^\n]*return/, 'must bail out when the panel div is absent');
});

test('every calendar IPC channel main handles has a preload method, and vice versa', () => {
  const handled = new Set([...calMainSrc.matchAll(/handle\('(calendar:[^']+)'/g)].map(m => m[1]));
  const bridged = new Set([...preloadSrc.matchAll(/invoke\('(calendar:[^']+)'/g)].map(m => m[1]));
  assert.ok(handled.size >= 15, 'the module registers a real surface');
  const missingBridge = [...handled].filter(c => !bridged.has(c));
  const missingHandler = [...bridged].filter(c => !handled.has(c));
  assert.deepEqual(missingBridge, [], 'channels with no preload method are unreachable');
  assert.deepEqual(missingHandler, [], 'preload methods with no handler reject at runtime');
});

test('every electronAPI.calendar* the renderer calls is exposed by the preload', () => {
  const used = new Set([...rendererSrc.matchAll(/electronAPI[?.]*\.(calendar[A-Za-z]+|onCalendar[A-Za-z]+)/g)].map(m => m[1]));
  const exposed = new Set([...preloadSrc.matchAll(/^\s{2}(calendar[A-Za-z]+|onCalendar[A-Za-z]+):/gm)].map(m => m[1]));
  assert.ok(used.size >= 12, 'the renderer really uses the bridge');
  assert.deepEqual([...used].filter(m => !exposed.has(m)), [], 'renderer calls a method the preload never exposed');
});

test('main.js boots the module on every OS and tears it down on quit', () => {
  assert.match(mainSrc, /const calendar = require\('\.\/main\/calendar'\)/);
  const start = mainSrc.indexOf('function startApp()');
  const winBlock = mainSrc.indexOf('if (isWindows) {', start);
  const initAt = mainSrc.indexOf('calendarModule = calendar.init(ctx)', start);
  assert.ok(initAt !== -1, 'calendar.init is called');
  assert.ok(initAt < winBlock, 'and outside the Windows-only block, since the widget is cross-platform');
  assert.match(mainSrc, /if \(calendarModule\) calendarModule\.teardown\(\);/, 'torn down on will-quit');
});

test('the scheduler is one timer, not a poll, and survives sleep', () => {
  assert.match(calMainSrc, /setTimeout\(\(\) => tick\(true\), delay\)/, 'wakes for the next reminder');
  assert.ok(!/setInterval\(\s*tick/.test(calMainSrc), 'never polls for due reminders');
  assert.match(calMainSrc, /powerMonitor\.on\('resume'/, 'catches up after sleep');
  assert.match(calMainSrc, /powerMonitor\.on\('unlock-screen'/);
  assert.match(calMainSrc, /Math\.min\(E\.WAKE_CAP, next - Date\.now\(\)\)/, 'and never sleeps past the cap');
});

test('the store is written atomically and a damaged file is kept, not clobbered', () => {
  assert.match(calMainSrc, /fs\.renameSync\(tmp, file\)/, 'temp file + rename');
  assert.match(calMainSrc, /corrupt-/, 'an unreadable file is preserved for recovery');
});

test('subscribed calendar feeds go through the proxy-safe transport, and only to real hosts', () => {
  assert.match(calMainSrc, /require\('\.\/netClient'\)/, 'netClient honours the OS cert store (TLS-inspecting AV)');
  assert.ok(!/require\('\.\/httpClient'\)/.test(calMainSrc), 'not raw Node https');
  assert.ok(calMainSrc.includes('localhost|127'), 'loopback addresses are refused');
  assert.ok(calMainSrc.includes('webcals?:'), 'webcal:// links are accepted and upgraded');
});

test('main.html wires the panel: engine before UI, styles, and the two host elements', () => {
  // Match the script TAGS, not any mention — a comment elsewhere in the file
  // names the same path and would make this pass (or fail) for the wrong reason.
  const engine = htmlSrc.indexOf('src="renderer/calendar-engine.js"');
  const ui = htmlSrc.indexOf('src="renderer/calendar.js"');
  const utils = htmlSrc.indexOf('src="renderer/ui-utils.js"');
  assert.ok(engine !== -1 && ui !== -1, 'both scripts load');
  assert.ok(engine < ui, 'the engine must be defined before the UI uses it');
  assert.ok(utils < ui, 'esc()/jsAttr() must exist before the UI runs');
  assert.match(htmlSrc, /<link rel="stylesheet" href="styles\/calendar\.css">/);
  assert.match(htmlSrc, /id="calendar-indicator"/, 'header chip host');
  assert.match(htmlSrc, /id="cal-alerts"/, 'in-app reminder card host');
  // The card host has to sit above every modal or a reminder can be hidden.
  assert.match(cssSrc, /\.cal-alerts\s*\{[^}]*z-index:\s*75/);
});

test('the enable toggle reaches the module (or reminders would never start)', () => {
  assert.match(widgetsSettingsSrc, /applyCalendarEnabled\(!!prefs\.calendar\)/);
  assert.match(rendererSrc, /async function applyCalendarEnabled\(enabled\)/);
  assert.match(rendererSrc, /calendarSetEnabled\(enabled, \{ clock24: calClock24\(\) \}\)/);
  assert.match(calMainSrc, /runtime\.watermark = Date\.now\(\)/, 'turning it on does not replay old reminders');
});

test('the renderer and main share ONE engine — no second copy of the date logic', () => {
  assert.match(calMainSrc, /require\('\.\.\/renderer\/calendar-engine'\)/);
  assert.match(rendererSrc, /const CalE = window\.CalendarEngine/);
  // The UI must not re-implement recurrence/notification rules locally.
  assert.ok(!/function\s+calExpand\w*\(/.test(rendererSrc), 'no local expansion');
  assert.ok(!/occurrenceKeys\s*=\s*function/.test(rendererSrc));
});

test('the header chip and the now-line schedule themselves instead of polling', () => {
  assert.match(rendererSrc, /calIndicatorTimer = setTimeout\(calScheduleIndicator/);
  // One minute-aligned tick while something is showing; a long wait otherwise.
  assert.match(rendererSrc, /60000 - \(now % 60000\)/);
  assert.match(rendererSrc, /function calStopNowLine/);
  assert.match(rendererSrc, /if \(!document\.getElementById\('cal-now'\)\) \{ calStopNowLine\(\); return; \}/,
    'the week-view clock stops when the view is gone');
});

test('the widget is off by default and nothing runs until it is switched on', () => {
  assert.match(calMainSrc, /enabled: !!\(raw && raw\.enabled\)/);
  assert.match(calMainSrc, /if \(!store\.enabled \|\| tornDown\) return;/);
  const firstRun = coreSrc.match(/const FIRST_RUN_MINI_WIDGETS = \[([\s\S]*?)\];/);
  assert.ok(firstRun && !/'calendar'/.test(firstRun[1]), 'not force-enabled on a fresh profile');
});
