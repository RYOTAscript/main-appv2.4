'use strict';

// The Corner Player's seams — the parts that fail SILENTLY in a running app: a
// channel with no preload method, the corner window loading the wide app
// bridge, a transparent window whose page is missing from the build (it opens
// as an invisible rectangle), a HUD window that freezes when throttled, track
// text from Spotify reaching innerHTML.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const mainSrc = read('main.js');
const moduleSrc = read('main', 'miniPlayer.js');
const spotifySrc = read('main', 'spotify.js');
const lyricsSrc = read('main', 'lyrics.js');
const preloadSrc = read('preload.js');
const cornerPreloadSrc = read('mini-player-preload.js');
const cornerHtml = read('mini-player.html');
const cornerJs = read('renderer', 'mini-player-window.js');
const panelSrc = read('renderer', 'mini-player.js');
const htmlSrc = read('main.html');
const coreSrc = read('renderer', 'core.js');
const widgetsSettingsSrc = read('renderer', 'widgets-settings.js');
const pkg = require(path.join(ROOT, 'package.json'));

test('every mini-player:* channel the panel uses is handled, and vice versa', () => {
  const handled = new Set([...moduleSrc.matchAll(/handle\('(mini-player:[^']+)'/g)].map(m => m[1]));
  const bridged = new Set([...preloadSrc.matchAll(/invoke\('(mini-player:[^']+)'/g)].map(m => m[1]));
  assert.deepEqual([...bridged].sort(), ['mini-player:get', 'mini-player:set-enabled', 'mini-player:set-prefs', 'mini-player:sync']);
  assert.deepEqual([...bridged].filter(c => !handled.has(c)), [], 'bridged but unhandled');
});

test('every electronAPI.miniPlayer* the panel calls is exposed', () => {
  const used = new Set([...panelSrc.matchAll(/electronAPI\??\.((?:miniPlayer|onMiniPlayer)[A-Za-z]+)/g)].map(m => m[1]));
  const exposed = new Set([...preloadSrc.matchAll(/^\s{2}((?:miniPlayer|onMiniPlayer)[A-Za-z]+):/gm)].map(m => m[1]));
  assert.ok(used.size >= 6);
  assert.deepEqual([...used].filter(m => !exposed.has(m)), []);
});

test('the corner window has its own narrow bridge, and main checks who is talking', () => {
  assert.match(moduleSrc, /preload: path\.join\(appRoot, 'mini-player-preload\.js'\)/);
  assert.ok(!/'preload\.js'/.test(stripComments(moduleSrc)), 'never the app preload');
  assert.ok(!/electronAPI/.test(stripComments(cornerPreloadSrc)), 'not the app bridge');
  const exposed = [...cornerPreloadSrc.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map(m => m[1]).sort();
  assert.deepEqual(exposed, ['action', 'dismiss', 'expand', 'laidOut', 'menu', 'onState', 'ready']);
  // Every message from the window is checked to come from the window itself…
  assert.match(moduleSrc, /BrowserWindow\.fromWebContents\(event\.sender\)/);
  for (const ch of ['ready', 'action', 'laid-out', 'menu', 'dismiss', 'expand']) {
    const re = new RegExp(`'mini-player:${ch}', \\(event[^)]*\\) => \\{[\\s\\S]{0,40}fromCorner\\(event\\)`);
    assert.match(moduleSrc, re, `mini-player:${ch} checks its sender`);
  }
  // …and it can only ask for a fixed set of playback actions.
  assert.match(moduleSrc, /MINI_ACTIONS\.has\(action\)/);
  const { MINI_ACTIONS } = require(path.join(ROOT, 'main', 'miniPlayer.js'));
  assert.deepEqual([...MINI_ACTIONS].sort(), ['next', 'previous', 'seek', 'toggle']);
  assert.ok(!/set-prefs|set-enabled|sync/.test(stripComments(cornerPreloadSrc)), 'no settings from the corner window');
});

test('the corner window is a proper always-on-top HUD', () => {
  assert.match(moduleSrc, /lockNavigation\(w, logger\)/, 'navigation locked like every window');
  assert.match(moduleSrc, /backgroundThrottling: false/, 'a throttled HUD freezes its progress bar');
  assert.match(moduleSrc, /setAlwaysOnTop\(true, 'screen-saver'\)/);
  assert.match(moduleSrc, /did-fail-load/, 'a failed transparent page must not linger invisibly');
  assert.match(moduleSrc, /showInactive\(\)/, 'appearing must never steal focus from a game');
  assert.match(moduleSrc, /skipTaskbar: true/);
});

test('the corner page and its bridge ship in the build', () => {
  for (const f of ['mini-player.html', 'mini-player-preload.js']) {
    assert.ok(pkg.build.files.includes(f), `${f} is in package.json build.files`);
  }
  assert.ok(pkg.build.files.includes('renderer/**/*'), 'its scripts ship with the renderer');
  assert.match(cornerHtml, /<script src="renderer\/mini-player-engine\.js"><\/script>/);
  assert.match(cornerHtml, /<script src="renderer\/mini-player-window\.js"><\/script>/);
  assert.match(cornerHtml, /src="icons\/player\.png"/, 'the same vinyl as the launcher card');
});

test('Spotify text only ever reaches the page as text', () => {
  const code = stripComments(cornerJs);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code), 'no HTML sinks in the corner window');
  assert.match(code, /els\.title\.textContent = /);
  assert.match(code, /el\.textContent = text;/, 'lyric rows');
  assert.match(code, /el\.dataset\.t = text;/, 'the glow reads the attribute through CSS attr(), which is text');
  // Main only lets an https image URL through.
  assert.match(moduleSrc, /HTTPS_IMAGE\.test\(t\.image\)/);
});

test('main polls through the Spotify and lyrics modules, not a second copy', () => {
  assert.match(spotifySrc, /ipcMain\.handle\('spotify-get-current-track', \(\) => getCurrentTrack\(\)\)/);
  assert.match(spotifySrc, /getCurrentTrack,\s*\n\s*control: playerControl,\s*\n\s*seek: seekTo/);
  assert.match(lyricsSrc, /return \{ getLyrics: getLyricsWithTimestamps \}/);
  assert.match(mainSrc, /miniPlayerModule = miniPlayer\.init\(ctx, \{ spotify: spotifyModule, lyrics: lyricsModule \}\)/);
  assert.match(mainSrc, /if \(miniPlayerModule\) miniPlayerModule\.teardown\(\)/, 'torn down on quit');
  assert.match(mainSrc, /miniPlayerModule\.setImmersive\(!!on\)/, 'hidden while the full-screen stage is open');
});

test('the widget is registered, has its panel, and is wired to main', () => {
  assert.match(coreSrc, /id: 'miniPlayer',[\s\S]*?panelId: 'mini-player-panel',\s*\n\s*panelRenderer: 'renderMiniPlayerPanel'/);
  assert.match(panelSrc, /function renderMiniPlayerPanel\(\)/);
  assert.match(panelSrc, /if \(!panel\) return;/, 'panels no-op when their div is absent');
  assert.match(htmlSrc, /<script src="renderer\/mini-player\.js"><\/script>/);
  assert.match(widgetsSettingsSrc, /applyMiniPlayerEnabled\(!!prefs\.miniPlayer\)/);
  // No platforms field: it runs on Windows and macOS alike.
  const entry = coreSrc.slice(coreSrc.indexOf("id: 'miniPlayer'"), coreSrc.indexOf("panelRenderer: 'renderMiniPlayerPanel'"));
  assert.ok(!/platforms:/.test(entry));
});
