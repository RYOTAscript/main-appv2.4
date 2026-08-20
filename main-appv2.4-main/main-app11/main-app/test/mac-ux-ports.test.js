// Stage 3 — core UX ports (autostart companion, clipboard files, tray icon).
// Exercises the electron-free helpers the feature modules delegate to, so the
// mac command-generation is verified from Windows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const osa = require('../main/osascript');
const { resolveTrayIcon } = require('../main/trayIcon');

// ── osascript arg building ─────────────────────────────────────────────
test('osascriptArgs wraps a single script in one -e', () => {
  assert.deepEqual(osa.osascriptArgs('return 1'), ['-e', 'return 1']);
});

test('osascriptArgs gives each line its own -e', () => {
  assert.deepEqual(osa.osascriptArgs(['a', 'b', 'c']), ['-e', 'a', '-e', 'b', '-e', 'c']);
});

// ── AppleScript string quoting ─────────────────────────────────────────
test('appleScriptQuote wraps and escapes', () => {
  assert.equal(osa.appleScriptQuote('/Users/me/a.png'), '"/Users/me/a.png"');
  assert.equal(osa.appleScriptQuote('a"b'), '"a\\"b"');           // embedded quote
  assert.equal(osa.appleScriptQuote('a\\b'), '"a\\\\b"');         // embedded backslash
  assert.equal(osa.appleScriptQuote(''), '""');
});

// ── named scripts ──────────────────────────────────────────────────────
test('scripts.hideOtherApps drives System Events visibility', () => {
  assert.match(osa.scripts.hideOtherApps, /System Events/);
  assert.match(osa.scripts.hideOtherApps, /set visible/);
});

test('scripts.setClipboardFiles builds a POSIX file list', () => {
  assert.equal(
    osa.scripts.setClipboardFiles(['/a/b.png']),
    'set the clipboard to {POSIX file "/a/b.png"}'
  );
  assert.equal(
    osa.scripts.setClipboardFiles(['/a.png', '/b.mov']),
    'set the clipboard to {POSIX file "/a.png", POSIX file "/b.mov"}'
  );
});

test('scripts.setClipboardFiles escapes quotes in paths', () => {
  const s = osa.scripts.setClipboardFiles(['/weird "name".png']);
  assert.equal(s, 'set the clipboard to {POSIX file "/weird \\"name\\".png"}');
});

// ── tray icon resolution ───────────────────────────────────────────────
test('resolveTrayIcon: macOS → resizable PNG for the menu bar', () => {
  const spec = resolveTrayIcon('darwin', '/app');
  assert.equal(path.basename(spec.iconPath), 'logo.png');
  assert.equal(spec.resize, 18);
  assert.equal(spec.isTemplate, false);
});

test('resolveTrayIcon: Windows → .ico, no resize', () => {
  const spec = resolveTrayIcon('win32', '/app');
  assert.equal(path.basename(spec.iconPath), 'main.ico');
  assert.equal(spec.resize, null);
});

test('resolveTrayIcon: unknown platform falls back to the .ico', () => {
  assert.equal(path.basename(resolveTrayIcon('linux', '/app').iconPath), 'main.ico');
});

test('resolveTrayIcon roots the icon under the given app dir', () => {
  const spec = resolveTrayIcon('darwin', path.join('C:', 'app'));
  assert.ok(spec.iconPath.includes('icons'), 'icon lives under icons/');
});
