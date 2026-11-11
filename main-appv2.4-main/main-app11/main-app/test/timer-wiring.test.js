'use strict';

// The Timers widget's seams — the parts that fail SILENTLY in a running app: a
// channel with no preload method, a floating window loading the wide app
// bridge, a transparent window whose page is missing from the build (it opens
// as an invisible rectangle), a HUD window that freezes when throttled.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const mainSrc = read('main.js');
const timersSrc = read('main', 'timers.js');
const preloadSrc = read('preload.js');
const floatPreloadSrc = read('timer-float-preload.js');
const floatHtml = read('timer-float.html');
const floatJs = read('renderer', 'timer-float.js');
const rendererSrc = read('renderer', 'timer.js');
const htmlSrc = read('main.html');
const coreSrc = read('renderer', 'core.js');
const widgetsSettingsSrc = read('renderer', 'widgets-settings.js');
const pkg = require(path.join(ROOT, 'package.json'));

test('every timer:* channel main handles has a preload method, and vice versa', () => {
  const handled = new Set([...timersSrc.matchAll(/handle\('(timer:[^']+)'/g)].map(m => m[1]));
  const bridged = new Set([...preloadSrc.matchAll(/invoke\('(timer:[^']+)'/g)].map(m => m[1]));
  assert.ok(handled.size >= 15);
  assert.deepEqual([...handled].filter(c => !bridged.has(c)), [], 'handled but unreachable');
  assert.deepEqual([...bridged].filter(c => !handled.has(c)), [], 'bridged but unhandled');
});

test('every electronAPI.timer* the renderer calls is exposed', () => {
  const used = new Set([...rendererSrc.matchAll(/tmCall\('(timer[A-Za-z]+)'/g)].map(m => m[1]));
  for (const m of rendererSrc.matchAll(/electronAPI\.(onTimer[A-Za-z]+)/g)) used.add(m[1]);
  const exposed = new Set([...preloadSrc.matchAll(/^\s{2}(timer[A-Za-z]+|onTimer[A-Za-z]+):/gm)].map(m => m[1]));
  assert.ok(used.size >= 12);
  assert.deepEqual([...used].filter(m => !exposed.has(m)), []);
});

test('the floating window has its own narrow bridge and never names a timer id', () => {
  assert.match(timersSrc, /preload: path\.join\(appRoot, 'timer-float-preload\.js'\)/);
  assert.ok(!/'preload\.js'/.test(stripComments(timersSrc)), 'never the app preload');
  const exposed = [...floatPreloadSrc.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map(m => m[1]).sort();
  assert.deepEqual(exposed, ['action', 'close', 'exitGhost', 'hoverHandle', 'laidOut', 'menu', 'onAlert', 'onState', 'openApp', 'ready']);
  // Main derives the timer from the SENDING window.
  assert.match(timersSrc, /BrowserWindow\.fromWebContents\(event\.sender\)/);
  assert.match(timersSrc, /FLOAT_ACTIONS\.has\(action\)/, 'and only whitelisted actions');
  assert.ok(!/remove|update|set-settings/.test(stripComments(floatPreloadSrc)), 'no delete, rename or settings from a float');
});

test('the floating window is a proper always-on-top HUD', () => {
  assert.match(timersSrc, /lockNavigation\(win, logger\)/, 'navigation locked like every window');
  assert.match(timersSrc, /backgroundThrottling: false/, 'a throttled HUD freezes its clock');
  assert.match(timersSrc, /setAlwaysOnTop\(true, 'screen-saver'\)/);
  assert.match(timersSrc, /did-fail-load/, 'a failed transparent page must not linger invisibly');
  assert.match(timersSrc, /screen\.on\('display-removed'/, 'unplugging a monitor pulls it back on screen');
  assert.match(timersSrc, /getDisplayMatching/);
});

test('the floating timer never polls', () => {
  const code = stripComments(floatJs);
  assert.ok(!/setInterval\(/.test(code));
  assert.ok(!/requestAnimationFrame\(\s*function|requestAnimationFrame\(paint|requestAnimationFrame\(tick/.test(code));
  assert.match(code, /if \(!state \|\| state\.timer\.status !== 'running'\) return;/, 'nothing scheduled unless running');
});

test('the floating ring and bar follow the real elapsed time, not a guessed transition', () => {
  // A 1s CSS transition re-aimed on ticks that don't land on whole seconds made
  // the line lurch and drift. The progress is a Web Animation pinned to the
  // timer: built once per run, then only its currentTime is corrected.
  const code = stripComments(floatJs);
  assert.match(code, /els\.arc\.animate\(/);
  assert.match(code, /els\.bar\.animate\(/);
  assert.match(code, /arcAnim\.currentTime = pos;/);
  assert.match(code, /easing: 'linear'/);
  assert.ok(!/E\.progress\(t, now \+ 1000\)/.test(code), 'no one-second look-ahead guess');
  const css = floatHtml.replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!/transition:[^;]*stroke-dashoffset/.test(css), 'no transition fighting the animation on the ring');
  assert.ok(!/\.bar i \{[^}]*transition:[^;]*width/.test(css), 'or on the bar');
});

test('changing a floating timer\'s look never shows the old layout in the new window', () => {
  // Resizing the window and restyling the page land at different moments; in
  // between, the ring was drawn inside a pill-shaped window. The window hides,
  // the page gets its new look first, and main only reveals it once the page
  // reports it has laid out at the new size (with a fallback so it can never
  // stay invisible).
  const code = stripComments(timersSrc);
  const fn = code.slice(code.indexOf('function setFloatPrefs'));
  const hide = fn.indexOf('hideForLayout(id, win)');
  const send = fn.indexOf("sendFloat(id, 'timer-float:state'");
  const resize = fn.indexOf('win.setBounds(clamped)');
  assert.ok(hide !== -1 && hide < send && send < resize, 'hide → restyle → resize, in that order');
  assert.match(code, /if \(!layoutSwitches\.has\(id\)\) win\.setOpacity/, 'opacity is not restored mid-switch');
  assert.match(code, /setTimeout\(\(\) => revealAfterLayout\(id\), \d+\)/, 'a fallback reveal');
  assert.match(code, /ipcMain\.on\('timer-float:laid-out'/);
  const page = stripComments(floatJs);
  assert.match(page, /api\.laidOut\(\)/);
  assert.match(page, /window\.addEventListener\('resize', checkLayout\)/, 'waits for the real resize');
  assert.match(floatHtml, /\.no-trans, \.no-trans \* \{ transition: none !important; \}/, 'no animating between looks');
});

test('checkpoints reach the floating window and the panel through the bridge', () => {
  assert.match(timersSrc, /handle\('timer:set-checkpoints'/);
  assert.match(preloadSrc, /timerSetCheckpoints:/);
  assert.match(floatJs, /E\.checkpointMarks\(t\)/);
  assert.match(rendererSrc, /TmE\.checkpointMarks\(t\)/);
  assert.match(floatHtml, /id="tf-cps"/);
  assert.match(floatHtml, /id="tf-bar-cps"/);
});

test('the scheduler is one timer aimed at the next due instant, and survives sleep', () => {
  assert.match(timersSrc, /E\.nextDue\(store, Date\.now\(\)\)/);
  assert.match(timersSrc, /Math\.min\(E\.WAKE_CAP, next - Date\.now\(\)\)/);
  assert.ok(!/setInterval\(/.test(stripComments(timersSrc)));
  assert.match(timersSrc, /powerMonitor\.on\('resume'/);
  assert.match(timersSrc, /fs\.renameSync\(tmp, file\)/, 'written atomically');
});

test('main.js boots the module on every OS, re-applies its hotkeys and tears it down', () => {
  const start = mainSrc.indexOf('function startApp()');
  const winBlock = mainSrc.indexOf('if (isWindows) {', start);
  const initAt = mainSrc.indexOf('timersModule = timers.init(ctx)', start);
  assert.ok(initAt !== -1 && initAt < winBlock, 'outside the Windows-only block');
  assert.match(mainSrc, /if \(timersModule\) timersModule\.teardown\(\);/);
  assert.match(mainSrc, /if \(timersModule\) timersModule\.reapplyHotkeys\(\);/, 'disable-all-hotkeys unregisters them');
});

test('the page, its preload and its engine ship in the build', () => {
  for (const f of ['timer-float.html', 'timer-float-preload.js']) assert.ok(pkg.build.files.includes(f), f);
  assert.ok(pkg.build.files.includes('renderer/**/*'));
  assert.match(floatHtml, /src="renderer\/timer-engine\.js"/);
  // Match the script TAGS — a comment in the page's CSS names these files too.
  const engineTag = floatHtml.indexOf('src="renderer/timer-engine.js"');
  const floatTag = floatHtml.indexOf('src="renderer/timer-float.js"');
  assert.ok(engineTag !== -1 && floatTag !== -1 && engineTag < floatTag, 'the engine loads before the page script');
});

test('main.html loads the engine before the UI, plus the stylesheet', () => {
  const engine = htmlSrc.indexOf('src="renderer/timer-engine.js"');
  const ui = htmlSrc.indexOf('src="renderer/timer.js"');
  assert.ok(engine !== -1 && engine < ui);
  assert.ok(htmlSrc.indexOf('src="renderer/ui-utils.js"') < ui);
  assert.match(htmlSrc, /href="styles\/timer\.css"/);
});

test('the registry entry keeps its id, and the toggle reaches main', () => {
  const m = coreSrc.match(/const\s+MINI_WIDGETS_ALL\s*=\s*(\[[\s\S]*?\n\s*\]);/);
  // eslint-disable-next-line no-eval
  const w = eval('(' + m[1] + ')').find(x => x.id === 'timer');
  assert.ok(w, 'id stays "timer" — miniWidgetPrefs are keyed on it');
  assert.equal(w.platforms, undefined);
  assert.equal(w.panelRenderer, 'renderTimerPanel');
  assert.match(widgetsSettingsSrc, /applyTimerEnabled\(!!prefs\.timer\)/);
  assert.match(rendererSrc, /function renderTimerPanel\(\) \{\s*const panel = document\.getElementById\('timer-panel'\);\s*if \(!panel\) return;/);
});

test('the old single countdown is migrated, not dropped', () => {
  assert.match(rendererSrc, /localStorage\.getItem\('timerState'\)/);
  assert.match(rendererSrc, /tmCall\('timerImportLegacy', legacy\)/);
  assert.match(timersSrc, /function importLegacy\(legacy\)/);
});

test('the voice assistant\'s timer globals still exist', () => {
  for (const fn of ['timerStart', 'timerPause', 'timerResume', 'timerReset', 'timerRestart', 'getTimerState', 'timerRemaining', 'formatTimerClock', 'timerFloatPrimary', 'timerStartStopwatch', 'timerStartFocus']) {
    assert.match(rendererSrc, new RegExp(`function ${fn}\\(`), fn);
  }
});
