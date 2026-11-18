'use strict';

// The Study widget's seams — the parts that fail SILENTLY in a running app: a
// channel with no preload method, an overlay loading the wide app bridge, a
// transparent window whose page or KaTeX files are missing from the build (it
// opens as an invisible rectangle, or shows formulas as raw text), user text
// reaching innerHTML.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const stripHtmlComments = (src) => src.replace(/<!--[\s\S]*?-->/g, ' ');

const mainSrc = read('main.js');
const studySrc = read('main', 'study.js');
const preloadSrc = read('preload.js');
const floatPreloadSrc = read('study-float-preload.js');
const floatHtml = read('study-float.html');
const floatJs = read('renderer', 'study-float.js');
const rendererSrc = read('renderer', 'study.js');
const htmlSrc = read('main.html');
const coreSrc = read('renderer', 'core.js');
const widgetsSettingsSrc = read('renderer', 'widgets-settings.js');
const notices = read('THIRD-PARTY-NOTICES.txt');
const pkg = require(path.join(ROOT, 'package.json'));

test('every study:* channel main handles has a preload method, and vice versa', () => {
  const handled = new Set([...studySrc.matchAll(/handle\('(study:[^']+)'/g)].map(m => m[1]));
  const bridged = new Set([...preloadSrc.matchAll(/invoke\('(study:[^']+)'/g)].map(m => m[1]));
  assert.ok(handled.size >= 15);
  assert.deepEqual([...handled].filter(c => !bridged.has(c)), [], 'handled but unreachable');
  assert.deepEqual([...bridged].filter(c => !handled.has(c)), [], 'bridged but unhandled');
  // Events main pushes reach the panel.
  for (const ch of ['study:changed', 'study:open']) {
    assert.match(studySrc, new RegExp(`sendMain\\('${ch}'`));
    assert.match(preloadSrc, new RegExp(`ipcRenderer\\.on\\('${ch}'`));
  }
});

test('every electronAPI.study* the panel calls is exposed', () => {
  const used = new Set([...rendererSrc.matchAll(/sdCall\('(study[A-Za-z]+)'/g)].map(m => m[1]));
  for (const m of rendererSrc.matchAll(/electronAPI\.(onStudy[A-Za-z]+)/g)) used.add(m[1]);
  const exposed = new Set([...preloadSrc.matchAll(/^\s{2}(study[A-Za-z]+|onStudy[A-Za-z]+):/gm)].map(m => m[1]));
  assert.ok(used.size >= 15);
  assert.deepEqual([...used].filter(m => !exposed.has(m)), []);
});

test('the overlay has its own narrow bridge and never names a sheet id', () => {
  assert.match(studySrc, /preload: path\.join\(appRoot, 'study-float-preload\.js'\)/);
  assert.ok(!/'preload\.js'/.test(stripComments(studySrc)), 'never the app preload');
  const exposed = [...floatPreloadSrc.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map(m => m[1]).sort();
  assert.deepEqual(exposed, ['close', 'exitGhost', 'ghost', 'hoverHandle', 'menu', 'onState', 'openApp', 'ready', 'resizeEnd', 'resizeTo', 'zoom']);
  // Main derives the sheet from the SENDING window.
  assert.match(studySrc, /BrowserWindow\.fromWebContents\(event\.sender\)/);
  const code = stripComments(floatPreloadSrc);
  assert.ok(!/study:/.test(code), 'no panel channel is reachable from an overlay');
  assert.ok(!/remove|update|create|settings|import|export/i.test(code), 'no editing, deleting or settings from an overlay');
  // Every overlay channel main listens on is one the preload sends, and the
  // look an overlay may change is a fixed list.
  const listened = new Set([...studySrc.matchAll(/ipcMain\.(?:on|handle)\('(study-float:[^']+)'/g)].map(m => m[1]));
  const sent = new Set([...floatPreloadSrc.matchAll(/ipcRenderer\.(?:send|invoke)\('(study-float:[^']+)'/g)].map(m => m[1]));
  assert.deepEqual([...sent].sort(), [...listened].sort());
  assert.match(studySrc, /const FLOAT_PREF_KEYS = \['style', 'scale', 'opacity', 'ghost', 'labels', 'notes'\];/);
});

test('the overlay is a proper always-on-top HUD', () => {
  assert.match(studySrc, /lockNavigation\(win, logger\)/, 'navigation locked like every window');
  assert.match(studySrc, /backgroundThrottling: false/);
  assert.match(studySrc, /setAlwaysOnTop\(true, 'screen-saver'\)/);
  assert.match(studySrc, /did-fail-load/, 'a failed transparent page must not linger invisibly');
  assert.match(studySrc, /screen\.on\('display-removed'/, 'unplugging a monitor pulls it back on screen');
  assert.match(studySrc, /getDisplayMatching/);
  assert.match(studySrc, /fs\.renameSync\(tmp, file\)/, 'written atomically');
  assert.match(studySrc, /E\.sanitizeStore\(readJson\(STORE_PATH\)/, 'sanitised on the way in');
});

test('the overlay page never polls and touches user text only through textContent', () => {
  const code = stripComments(floatJs);
  assert.ok(!/setInterval\(/.test(code));
  assert.ok(!/setTimeout\(/.test(code));
  // The only animation frames are the resize grip's, one per pointer move.
  assert.equal((code.match(/requestAnimationFrame\(/g) || []).length, 1);
  const sinks = [...code.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map(m => m[1].trim());
  assert.deepEqual(sinks, ['out.html'], 'KaTeX output is the only HTML');
  assert.ok(!/insertAdjacentHTML|outerHTML\s*=|document\.write/.test(code));
  assert.match(code, /E\.renderFormula\(window\.katex, src\)/);
});

test('the panel builds its DOM safely: no inline handlers, KaTeX the only HTML', () => {
  const code = stripComments(rendererSrc);
  const sinks = [...code.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map(m => m[1].trim());
  assert.deepEqual(sinks, ['out.html', 'out.html'], 'sdMath and the live preview');
  assert.ok(!/insertAdjacentHTML|outerHTML\s*=|document\.write/.test(code));
  assert.ok(!/\bon[a-z]+\s*=\s*["'`]/.test(code), 'no inline on* handlers');
  assert.ok(!/setAttribute\(\s*['"]on/.test(code));
  assert.match(code, /StE\.renderFormula\(window\.katex, src\)/);
});

test('KaTeX ships with the app, is loaded locally, and passes the overlay CSP', () => {
  for (const f of ['katex.min.js', 'katex.min.css', 'contrib/mhchem.min.js', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'styles', 'vendor', 'katex', f)), f);
  }
  assert.ok(pkg.build.files.includes('styles/**/*'), 'styles/vendor/katex is inside a shipped glob');
  // Every font the stylesheet names first (woff2 — the one Chromium loads) exists.
  const css = read('styles', 'vendor', 'katex', 'katex.min.css');
  const woff2 = [...new Set([...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map(m => m[1]))];
  assert.ok(woff2.length >= 15);
  for (const f of woff2) assert.ok(fs.existsSync(path.join(ROOT, 'styles', 'vendor', 'katex', f)), f);
  // No CDN anywhere.
  for (const src of [floatHtml, htmlSrc, rendererSrc]) assert.ok(!/cdn\.jsdelivr|unpkg\.com|cdnjs/.test(src));
  // KaTeX must not need eval (script-src has no 'unsafe-eval').
  for (const f of ['katex.min.js', 'contrib/mhchem.min.js']) {
    assert.ok(!/\beval\(|new Function\(/.test(read('styles', 'vendor', 'katex', f)), f);
  }
  // The licence travels with the build.
  assert.match(notices, /KaTeX/);
  assert.match(notices, /mhchem/);
});

test('the overlay page, its preload and its scripts ship, in the right order', () => {
  for (const f of ['study-float.html', 'study-float-preload.js']) assert.ok(pkg.build.files.includes(f), f);
  assert.ok(pkg.build.files.includes('renderer/**/*'));
  const html = stripHtmlComments(floatHtml);
  const order = ['styles/vendor/katex/katex.min.js', 'styles/vendor/katex/contrib/mhchem.min.js', 'renderer/study-engine.js', 'renderer/study-float.js']
    .map(s => html.indexOf(`src="${s}"`));
  assert.ok(order.every(i => i !== -1), 'all four scripts');
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'KaTeX → mhchem → engine → page');
  assert.match(html, /href="styles\/vendor\/katex\/katex\.min\.css"/);
  assert.match(studySrc, /loadFile\(path\.join\(appRoot, 'study-float\.html'\)\)/);
});

test('main.html loads the engine before the UI, and leaves KaTeX to load on demand', () => {
  const html = stripHtmlComments(htmlSrc);
  const engine = html.indexOf('src="renderer/study-engine.js"');
  const ui = html.indexOf('src="renderer/study.js"');
  assert.ok(engine !== -1 && engine < ui);
  assert.ok(html.indexOf('src="renderer/ui-utils.js"') < ui);
  assert.ok(html.indexOf('src="renderer/hotkeys.js"') < ui);
  assert.match(html, /href="styles\/study\.css"/);
  assert.ok(!/katex\.min\.js/.test(html), 'not parsed at every app start');
  // The lazy loader points at files that exist.
  const m = rendererSrc.match(/const SD_KATEX = \{([\s\S]*?)\};/);
  const paths = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  assert.equal(paths.length, 3);
  for (const p of paths) assert.ok(fs.existsSync(path.join(ROOT, p)), p);
});

test('the registry entry, its panel and the toggle that reaches main', () => {
  const m = coreSrc.match(/const\s+MINI_WIDGETS_ALL\s*=\s*(\[[\s\S]*?\n\s*\]);/);
  // eslint-disable-next-line no-eval
  const reg = eval('(' + m[1] + ')');
  const w = reg.find(x => x.id === 'study');
  assert.ok(w, 'id "study" — miniWidgetPrefs are keyed on it');
  assert.equal(w.platforms, undefined, 'Windows and macOS');
  assert.equal(w.panelId, 'study-panel');
  assert.equal(w.panelRenderer, 'renderStudyPanel');
  assert.equal(w.category, 'Productivity');
  assert.match(widgetsSettingsSrc, /applyStudyEnabled\(!!prefs\.study\)/);
  assert.match(rendererSrc, /function renderStudyPanel\(\) \{\s*const panel = document\.getElementById\('study-panel'\);\s*if \(!panel\) return;/);
  assert.match(rendererSrc, /async function applyStudyEnabled\(enabled\)/);
});

test('main.js boots the module on every OS, re-applies its hotkeys and tears it down', () => {
  const start = mainSrc.indexOf('function startApp()');
  const winBlock = mainSrc.indexOf('if (isWindows) {', start);
  const initAt = mainSrc.indexOf('studyModule = study.init(ctx)', start);
  assert.ok(initAt !== -1 && initAt < winBlock, 'outside the Windows-only block');
  assert.match(mainSrc, /const study = require\('\.\/main\/study'\);/);
  assert.match(mainSrc, /if \(studyModule\) studyModule\.teardown\(\);/);
  assert.match(mainSrc, /if \(studyModule\) studyModule\.reapplyHotkeys\(\);/, 'disable-all-hotkeys unregisters them');
});

test('the panel boots in a renderer and no-ops without its div', () => {
  // The real renderer script in a vm with just enough of a page: it must not
  // throw at load, and renderStudyPanel must quietly do nothing while the
  // Widget Library's detail view (and so #study-panel) isn't open.
  const calls = [];
  const sandbox = {
    console,
    localStorage: { getItem: () => JSON.stringify({ study: true }), setItem() {} },
    safeParseJSON: (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } },
    document: {
      readyState: 'complete',
      getElementById: () => null,
      addEventListener() {},
      querySelector: () => null
    },
    requestAnimationFrame: () => 0,
    setTimeout, clearTimeout,
    showToast() {}
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.electronAPI = new Proxy({}, { get: (_t, k) => (...a) => { calls.push(k); return Promise.resolve({ sheets: [], openFloats: [], floats: {}, settings: {} }); } });
  vm.createContext(sandbox);
  vm.runInContext(read('renderer', 'study-engine.js'), sandbox);
  vm.runInContext(read('renderer', 'study.js'), sandbox);
  assert.equal(typeof sandbox.renderStudyPanel, 'function');
  sandbox.renderStudyPanel();
  assert.ok(calls.includes('studyGet'), 'loads its state at boot');
  assert.ok(calls.includes('onStudyChanged') && calls.includes('onStudyOpen'), 'subscribes');
});
