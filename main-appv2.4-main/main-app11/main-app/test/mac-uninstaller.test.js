// P2.3 — App Uninstaller. The isPathSafe() guard is the single thing standing
// between "move a leftover to Trash" and "trash the wrong thing", so it gets the
// most thorough coverage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../main/appUninstaller.logic');

const HOME = '/Users/ivan';

// ── isPathSafe — the safety gate ───────────────────────────────────────
test('isPathSafe allows files strictly inside allowed ~/Library roots', () => {
  assert.equal(L.isPathSafe('/Users/ivan/Library/Caches/com.foo.bar', HOME), true);
  assert.equal(L.isPathSafe('/Users/ivan/Library/Preferences/com.foo.bar.plist', HOME), true);
  assert.equal(L.isPathSafe('/Users/ivan/Library/Application Support/Foo', HOME), true);
  assert.equal(L.isPathSafe('/Applications/Foo.app', HOME), true);
  assert.equal(L.isPathSafe('/Users/ivan/Applications/Foo.app', HOME), true);
});

test('isPathSafe REJECTS the roots themselves (never delete a whole dir)', () => {
  assert.equal(L.isPathSafe('/Users/ivan/Library/Caches', HOME), false);
  assert.equal(L.isPathSafe('/Users/ivan/Library/Preferences', HOME), false);
  assert.equal(L.isPathSafe('/Applications', HOME), false);
  assert.equal(L.isPathSafe('/Users/ivan/Library', HOME), false);
});

test('isPathSafe REJECTS anything outside the allow-list', () => {
  assert.equal(L.isPathSafe('/Users/ivan/Documents/thesis.pdf', HOME), false);
  assert.equal(L.isPathSafe('/System/Library/Caches/x', HOME), false);
  assert.equal(L.isPathSafe('/etc/passwd', HOME), false);
  assert.equal(L.isPathSafe('/', HOME), false);
  assert.equal(L.isPathSafe('/Users/ivan/Library/Keychains/login.keychain', HOME), false); // not a leftover root
  assert.equal(L.isPathSafe('/Users/OTHER/Library/Caches/x', HOME), false); // another user
});

test('isPathSafe REJECTS path traversal and junk input', () => {
  assert.equal(L.isPathSafe('/Users/ivan/Library/Caches/../../Documents/x', HOME), false);
  assert.equal(L.isPathSafe('/Users/ivan/Library/Caches/..', HOME), false);
  assert.equal(L.isPathSafe('', HOME), false);
  assert.equal(L.isPathSafe(null, HOME), false);
  assert.equal(L.isPathSafe('/Users/ivan/Library/Caches/x', ''), false);
});

// ── leftoverMatches ────────────────────────────────────────────────────
test('leftoverMatches on bundle id: exact + boundary prefixes', () => {
  const bid = 'com.foo.bar';
  assert.equal(L.leftoverMatches('com.foo.bar', bid, 'Foo'), true);
  assert.equal(L.leftoverMatches('com.foo.bar.plist', bid, 'Foo'), true);
  assert.equal(L.leftoverMatches('com.foo.bar.savedState', bid, 'Foo'), true);
  assert.equal(L.leftoverMatches('com.foo.bar.binarycookies', bid, 'Foo'), true);
});

test('leftoverMatches does NOT match a different app sharing a prefix', () => {
  // "com.foo.bar" must not match "com.foo.barbaz" (no real boundary).
  assert.equal(L.leftoverMatches('com.foo.barbaz', 'com.foo.bar', 'Foo'), false);
  assert.equal(L.leftoverMatches('com.foo.barbaz.plist', 'com.foo.bar', 'Foo'), false);
});

test('leftoverMatches never sweeps Apple/system bundle ids', () => {
  assert.equal(L.leftoverMatches('com.apple.finder.plist', 'com.apple.finder', 'Finder'), false);
});

test('leftoverMatches app-name path is strict (exact folder or .plist only)', () => {
  assert.equal(L.leftoverMatches('Spotify', '', 'Spotify'), true);
  assert.equal(L.leftoverMatches('Spotify.plist', '', 'Spotify'), true);
  assert.equal(L.leftoverMatches('SpotifyHelper', '', 'Spotify'), false); // not exact
  assert.equal(L.leftoverMatches('My Spotify Backup', '', 'Spotify'), false);
  assert.equal(L.leftoverMatches('foo', '', 'ab'), false); // 2-char app name too short
});

// ── isProtectedApp ─────────────────────────────────────────────────────
test('isProtectedApp shields Apple, /System, and our own app', () => {
  assert.equal(L.isProtectedApp('com.apple.Safari', '/Applications/Safari.app'), true);
  assert.equal(L.isProtectedApp('com.foo.bar', '/System/Applications/Music.app'), true);
  assert.equal(L.isProtectedApp('com.launcher.app', '/Applications/main.app'), true);
  assert.equal(L.isProtectedApp('com.spotify.client', '/Applications/Spotify.app'), false);
});

test('allowedRoots includes the Library leftover dirs + app locations', () => {
  const roots = L.allowedRoots(HOME);
  assert.ok(roots.includes('/Users/ivan/Library/Caches'));
  assert.ok(roots.includes('/Users/ivan/Library/Application Support'));
  assert.ok(roots.includes('/Applications'));
  assert.ok(roots.includes('/Users/ivan/Applications'));
});
