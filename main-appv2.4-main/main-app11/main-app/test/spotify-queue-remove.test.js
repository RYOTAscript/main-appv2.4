// Pins the "remove from queue" path: Spotify's Web API has no remove-from-queue
// call, so main drives the Spotify DESKTOP app through Windows UI Automation
// (main/spotifyQueueScript.js). These tests keep the two halves of that contract in
// step and make sure the old mute-and-skip workaround — which fought Spotify's state
// lag and never behaved reliably — doesn't creep back in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { SPOTIFY_QUEUE_SCRIPT, SPOTIFY_QUEUE_SCRIPT_VERSION } = require('../main/spotifyQueueScript');

// Negative assertions must ignore comments: the comments explaining what was removed
// name the very things being checked for.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

test('helper script: drives the app through the labels Spotify exposes', () => {
  for (const label of ["'Queue'", "'More options for '", "'Remove from queue'", "'Desktop_PanelContainer_Id'"]) {
    assert.ok(SPOTIFY_QUEUE_SCRIPT.includes(label), `script should look for ${label}`);
  }
  assert.match(SPOTIFY_QUEUE_SCRIPT, /ExpandCollapsePattern/, 'row menus are opened by expanding, not invoking');
  assert.match(SPOTIFY_QUEUE_SCRIPT, /TogglePattern/, 'the queue panel is a toggle');
});

test('helper script: takes a base64 payload and prints one JSON line', () => {
  assert.match(SPOTIFY_QUEUE_SCRIPT, /^param\(\[string\]\$Payload\)/);
  assert.match(SPOTIFY_QUEUE_SCRIPT, /FromBase64String\(\$Payload\)/);
  assert.match(SPOTIFY_QUEUE_SCRIPT, /ConvertTo-Json -Compress/);
  for (const reason of ['bad-request', 'not-running', 'no-window', 'no-queue', 'not-found', 'not-visible', 'no-remove-item', 'not-removed', 'error']) {
    assert.ok(SPOTIFY_QUEUE_SCRIPT.includes(`'${reason}'`), `script should be able to report ${reason}`);
  }
});

test('helper script: never moves or clicks the mouse', () => {
  assert.doesNotMatch(SPOTIFY_QUEUE_SCRIPT, /mouse_event|SetCursorPos|SendInput|SendKeys/);
});

test('helper script: its only keystroke is a guarded Enter on "Remove from queue"', () => {
  // Accessibility "invoke" only closes Spotify's menu, and keys posted into its window
  // are ignored (both verified live) — a real Enter on the focused item is what runs the
  // action. It is pressed only with Spotify in the foreground and focus still on that
  // item, so the key can never land in another app.
  assert.match(SPOTIFY_QUEUE_SCRIPT, /\$removeItem\.SetFocus\(\)/);
  // lastIndexOf: the first "PressEnter()" is the C# method's own definition.
  const guard = SPOTIFY_QUEUE_SCRIPT.slice(
    SPOTIFY_QUEUE_SCRIPT.indexOf('# Spotify ignores keys posted'),
    SPOTIFY_QUEUE_SCRIPT.lastIndexOf('PressEnter()')
  );
  assert.ok(guard.length > 0 && guard.length < 900, 'the guard sits right before the key press');
  assert.match(guard, /GetForegroundWindow\(\) -eq \$script:hwnd -and \(FocusIsRemoveItem\)/);
  // It never reports success on the key alone: the row has to be gone.
  assert.match(SPOTIFY_QUEUE_SCRIPT, /if \(RowGone \d+\) \{ Finish \$true 'keypress' \}/);
  assert.doesNotMatch(SPOTIFY_QUEUE_SCRIPT, /InvokePattern\]::Pattern\)\.Invoke\(\)/, 'accessibility invoke does not run Spotify menu actions');
});

test('helper script: shows Spotify only for the removal, then puts it back', () => {
  // Chromium won't draw the menu in a minimized or covered window, so the window is
  // restored without being activated and raised, then returned to how it was found.
  assert.match(SPOTIFY_QUEUE_SCRIPT, /ShowNoActivate\(\$script:hwnd\)/);
  assert.match(SPOTIFY_QUEUE_SCRIPT, /\$script:reminimize = \[SpotifyQueueHelper\.Win\]::IsIconic\(\$script:hwnd\)/);
  // Finish is the single exit, so every path re-minimizes and hands focus back.
  const finish = SPOTIFY_QUEUE_SCRIPT.slice(SPOTIFY_QUEUE_SCRIPT.indexOf('function Finish'), SPOTIFY_QUEUE_SCRIPT.indexOf('function Norm'));
  assert.match(finish, /ShowWindow\(\$script:hwnd, 7\)/, 'SW_SHOWMINNOACTIVE puts it back minimized');
  assert.match(finish, /GiveForeground\(\$script:userFg\)/, 'the window that had focus gets it back');
});

test('helper script: pure ASCII, so Windows PowerShell 5.1 parses it', () => {
  // scriptCache writes the .ps1 as UTF-8 without a BOM, which Windows PowerShell 5.1
  // reads as the ANSI code page: an em dash or curly quote turns into bytes that
  // include a quote character and break the script's string parsing. Keep it ASCII.
  const offenders = [...SPOTIFY_QUEUE_SCRIPT].filter((ch) => ch.charCodeAt(0) > 127);
  assert.deepEqual(offenders, [], 'non-ASCII characters in the PowerShell helper');
});

test('helper script: text survives the JS template literal intact', () => {
  assert.ok(!SPOTIFY_QUEUE_SCRIPT.includes('${'), 'a ${ would have been interpolated by JS');
  assert.equal(typeof SPOTIFY_QUEUE_SCRIPT_VERSION, 'string');
  assert.ok(SPOTIFY_QUEUE_SCRIPT_VERSION.length > 0);
});

test('main: registers the desktop-queue channel and passes the payload safely', () => {
  const src = stripComments(read('main/spotify.js'));
  assert.match(src, /ipcMain\.handle\('spotify-desktop-queue-remove'/);
  assert.match(src, /ensureVersionedScript\(DESKTOP_QUEUE_SCRIPT, SPOTIFY_QUEUE_SCRIPT_VERSION, SPOTIFY_QUEUE_SCRIPT\)/);
  assert.match(src, /runFile\('powershell\.exe'/, 'argv array, no shell string');
  assert.match(src, /'-Payload', payload/);
  assert.match(src, /toString\('base64'\)/);
});

test('preload: exposes the remove and warm-up bridge methods', () => {
  const src = stripComments(read('preload.js'));
  assert.match(src, /spotifyDesktopQueueRemove: \(title, occurrence\) => ipcRenderer\.invoke\('spotify-desktop-queue-remove', title, occurrence\)/);
  assert.match(src, /spotifyDesktopQueueWarm: \(\) => ipcRenderer\.invoke\('spotify-desktop-queue-warm'\)/);
});

test('helper script: waits for Chromium to build the tree and supports warm-up', () => {
  assert.match(SPOTIFY_QUEUE_SCRIPT, /\$json\.warm/);
  assert.match(SPOTIFY_QUEUE_SCRIPT, /for \(\$w = 0; \$w -lt 40/);
  const src = stripComments(read('main/spotify.js'));
  assert.match(src, /ipcMain\.handle\('spotify-desktop-queue-warm'/);
});

test('the mute-and-skip workaround is gone from every layer', () => {
  const layers = {
    'main/spotify.js': ['queueSkips', 'stepPastRemoved', 'spotify-queue-skip', 'spotify-volume-hold'],
    'preload.js': ['spotifyQueueSkip', 'onSpotifyQueueSkips', 'onSpotifyVolumeHold'],
    'renderer/spotify-enhanced.js': ['spotifyQueueSkips', 'spotifyRecentlySkipped', 'spotifySyncSkip', 'spotifyApplySkipEntries']
  };
  for (const [file, names] of Object.entries(layers)) {
    const src = stripComments(read(file));
    for (const name of names) assert.ok(!src.includes(name), `${file} still references ${name}`);
  }
});

test('renderer: the remove button passes the title and which copy it is', () => {
  const src = read('renderer/spotify-enhanced.js');
  assert.match(src, /spotifyQueueRemove\(this, \$\{jsAttr\(track\.name \|\| ''\)\}, \$\{jsAttr\(copy \|\| 0\)\}\)/);
  assert.match(src, /window\.electronAPI\.spotifyDesktopQueueRemove\(title, Number\(copy\) \|\| 0\)/);
});

test('helper script parses as valid PowerShell', { skip: process.platform !== 'win32' }, () => {
  const tmp = path.join(require('os').tmpdir(), `spotify-queue-remove-${process.pid}.ps1`);
  fs.writeFileSync(tmp, SPOTIFY_QUEUE_SCRIPT, 'utf8');
  try {
    const check = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${tmp.replace(/'/g, "''")}',[ref]$t,[ref]$e);$e.Count`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8', windowsHide: true });
    assert.equal(out.trim(), '0', 'PowerShell reported parse errors in the helper script');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
