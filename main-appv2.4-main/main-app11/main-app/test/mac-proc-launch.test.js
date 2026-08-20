// Stage 5 — process listing (running-app indicator) + launcher ports.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const proc = require('../main/procList');

// ── listCommand ────────────────────────────────────────────────────────
test('listCommand: tasklist on Windows, ps elsewhere', () => {
  assert.equal(proc.listCommand('win32'), 'tasklist /fo csv /nh');
  assert.equal(proc.listCommand('darwin'), 'ps -axo comm=');
  assert.equal(proc.listCommand('linux'), 'ps -axo comm=');
});

// ── Windows tasklist parsing (unchanged behaviour) ─────────────────────
test('parseTasklistNames pulls lowercased image names from CSV', () => {
  const out = [
    '"chrome.exe","1234","Console","1","350,000 K"',
    '"Discord.exe","5678","Console","1","120,000 K"',
    '',
  ].join('\r\n');
  const names = proc.parseTasklistNames(out);
  assert.ok(names.has('chrome.exe'));
  assert.ok(names.has('discord.exe'));
  assert.equal(names.size, 2);
});

// ── macOS ps parsing ───────────────────────────────────────────────────
test('parsePsNames indexes both leaf and .app bundle names', () => {
  const out = [
    '/Applications/Discord.app/Contents/MacOS/Discord',
    '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
    '/usr/sbin/coreaudiod',
    '',
  ].join('\n');
  const names = proc.parsePsNames(out);
  assert.ok(names.has('discord'), 'leaf name');
  assert.ok(names.has('finder'), 'finder leaf');
  assert.ok(names.has('coreaudiod'), 'daemon with no .app');
  // Bundle names also indexed so a renderer can match "Discord.app" derived names.
  assert.ok([...names].some(n => n === 'discord'));
});

test('parseRunningNames dispatches by platform', () => {
  assert.ok(proc.parseRunningNames('win32', '"game.exe","1","Console","1","1 K"').has('game.exe'));
  assert.ok(proc.parseRunningNames('darwin', '/Applications/Spotify.app/Contents/MacOS/Spotify').has('spotify'));
});

// ── Windows-only module init is guarded in main.js ─────────────────────
const APP = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');

test('main.js skips Windows-only module init off Windows', () => {
  // The Windows-only inits must sit inside an `if (isWindows) { … }` block.
  const m = mainSrc.match(/if\s*\(isWindows\)\s*\{([\s\S]*?)\n\s{4}\}/);
  assert.ok(m, 'found the `if (isWindows)` init block in main.js');
  const block = m[1];
  for (const mod of ['fpsOptimizer.init', 'macros.init', 'controllerMacros.init',
    'screenResolution.init', 'bluetooth.init', 'taskbar.init', 'claudeLimit.init',
    'appInstaller.init', 'debloat.init', 'revoUninstaller.init', 'gameMode.init']) {
    assert.ok(block.includes(mod), `${mod} is inside the Windows-only block`);
  }
});

test('main.js keeps cross-platform modules unconditional', () => {
  // These must NOT be inside the Windows-only block (they run on mac too).
  const blockStart = mainSrc.indexOf('if (isWindows) {');
  const blockEnd = mainSrc.indexOf('createTray();', blockStart);
  const winBlock = mainSrc.slice(blockStart, blockEnd);
  for (const mod of ['micMute.init', 'volumeMixer.init', 'fileSearch.init', 'quickLaunch.init',
    'clipboardHistory.init', 'appLauncher.init', 'crosshair.init', 'discordRpc.init']) {
    assert.ok(!winBlock.includes(mod), `${mod} must stay cross-platform (outside the block)`);
  }
});

// ── appLauncher recognises Spotify.app on macOS ────────────────────────
test('appLauncher isSpotifyPath matches both .exe and .app', () => {
  const src = fs.readFileSync(path.join(APP, 'main', 'appLauncher.js'), 'utf8');
  assert.match(src, /spotify\\\.app/i, 'isSpotifyPath handles Spotify.app');
});
