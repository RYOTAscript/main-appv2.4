'use strict';

// The Phone Remote's seams — the parts that fail SILENTLY: two copies of the
// protocol drifting apart (the phone just never decrypts anything), the relay
// trusting a different license key than the app (every PC turned away), the
// hidden socket window handed the wide app bridge, a socket page missing from
// the build (the window opens and connects to nothing), a shipped build that
// can be pointed at someone else's relay, and Spotify text reaching markup on
// either end.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const readRepo = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const moduleSrc = read('main', 'phoneRemote.js');
const preloadSrc = read('preload.js');
const socketPreloadSrc = read('phone-remote-preload.js');
const panelSrc = read('renderer', 'phone-remote.js');
const mainSrc = read('main.js');
const spotifySrc = read('main', 'spotify.js');
const licenseSrc = read('main', 'license.js');
const htmlSrc = read('main.html');
const pkg = require(path.join(ROOT, 'package.json'));

test('the phone page runs exactly the protocol file the PC runs', () => {
  assert.equal(
    readRepo('website', 'public', 'remote', 'protocol.js'),
    read('renderer', 'remote-protocol.js'),
    'copy renderer/remote-protocol.js over website/public/remote/protocol.js',
  );
});

test('the relay admits PCs on the same license key the app trusts', () => {
  const kv = [...licenseSrc.match(/const _kv = \[([\s\S]*?)\];/)[1].matchAll(/'([0-9a-f]+)'/g)].map((m) => m[1]).join('');
  const relayHex = readRepo('relay', 'src', 'rules.js').match(/LICENSE_PUBLIC_KEY_HEX =\s*'([0-9a-f]+)'/)[1];
  assert.equal(relayHex, kv);
});

test('the relay is only ever reached with the license token that unlocks this machine', () => {
  assert.match(licenseSrc, /function relayToken\(\) \{[\s\S]*?return tokenUnlock\(stored\) \? stored\.token : null;/);
  assert.match(moduleSrc, /license\.relayToken \? license\.relayToken\(\) : null/);
  assert.match(moduleSrc, /setStatus\('unlicensed', 0\)/);
});

test('every phone-remote:* call the panel makes is handled', () => {
  const handled = new Set([...moduleSrc.matchAll(/ipcMain\.handle\('(phone-remote:[^']+)'/g)].map((m) => m[1]));
  const bridged = [...preloadSrc.matchAll(/invoke\('(phone-remote:[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(bridged.sort(), ['phone-remote:get', 'phone-remote:pair', 'phone-remote:set-enabled', 'phone-remote:sync', 'phone-remote:unpair']);
  assert.deepEqual(bridged.filter((c) => !handled.has(c)), []);
  const used = new Set([...panelSrc.matchAll(/electronAPI\??\.((?:phoneRemote|onPhoneRemote)[A-Za-z]+)/g)].map((m) => m[1]));
  for (const name of used) assert.match(preloadSrc, new RegExp(`\\b${name}:`), `${name} is in preload.js`);
});

test('the socket window gets a narrow preload that exposes nothing to its page', () => {
  const code = stripComments(socketPreloadSrc);
  assert.doesNotMatch(code, /contextBridge|exposeInMainWorld/);
  const sent = new Set([...code.matchAll(/ipcRenderer\.send\('([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...sent].sort(), ['phone-remote:socket-event', 'phone-remote:socket-ready']);
  const heard = [...code.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(heard, ['phone-remote:socket']);
  assert.match(moduleSrc, /preload: path\.join\(ctx\.appRoot, 'phone-remote-preload\.js'\)/);
  assert.doesNotMatch(moduleSrc, /preload: path\.join\([^)]*'preload\.js'\)/, 'never the app preload');
});

test('main only listens to its own socket window', () => {
  for (const ch of ['phone-remote:socket-ready', 'phone-remote:socket-event']) {
    const body = moduleSrc.slice(moduleSrc.indexOf(`ipcMain.on('${ch}'`));
    assert.match(body.slice(0, 200), /if \(!fromSocketWindow\(event\)/, `${ch} checks its sender`);
  }
  assert.match(moduleSrc, /event\.sender === win\.webContents/);
});

test('the socket window is hidden, unthrottled and locked down', () => {
  assert.match(moduleSrc, /show: false/);
  assert.match(moduleSrc, /backgroundThrottling: false/);
  assert.match(moduleSrc, /contextIsolation: true/);
  assert.match(moduleSrc, /sandbox: true/);
  assert.match(moduleSrc, /nodeIntegration: false/);
  assert.match(moduleSrc, /lockNavigation\(win, logger\)/);
  assert.match(moduleSrc, /did-fail-load/);
});

test('the socket page and its preload ship in the build', () => {
  for (const f of ['phone-remote.html', 'phone-remote-preload.js']) {
    assert.ok(pkg.build.files.includes(f), `${f} is in package.json build.files`);
  }
});

test('a shipped build cannot be pointed at another relay', () => {
  assert.match(moduleSrc, /const RELAY_HOST = \(!app\.isPackaged && process\.env\.MAIN_PHONE_RELAY\) \|\| RELAY_HOST_DEFAULT;/);
});

test('the pairing secret is kept with safeStorage where the OS offers it', () => {
  assert.match(moduleSrc, /safeStorage\.encryptString\(secret\)/);
  assert.match(moduleSrc, /safeStorage\.decryptString\(/);
});

test('Spotify hands main the calls the remote needs, and the IPC still uses them', () => {
  const ret = spotifySrc.slice(spotifySrc.lastIndexOf('return {'));
  for (const name of ['getCurrentTrack', 'control: playerControl', 'seek: seekTo', 'setVolume', 'isSaved', 'setSaved', 'getQueue']) {
    assert.ok(ret.includes(name), `spotify exports ${name}`);
  }
  assert.match(spotifySrc, /ipcMain\.handle\('spotify-set-volume', \(_event, volume\) => setVolume\(volume\)\)/);
  assert.match(spotifySrc, /ipcMain\.handle\('spotify-get-queue', \(\) => getQueue\(\)\)/);
  assert.match(spotifySrc, /ipcMain\.handle\('spotify-is-saved', \(_event, trackId\) => isSaved\(trackId\)\)/);
  assert.match(spotifySrc, /ipcMain\.handle\('spotify-set-saved', \(_event, trackId, saved\) => setSaved\(trackId, saved\)\)/);
});

test('main.js starts the remote with what it needs, and stops it on quit', () => {
  assert.match(mainSrc, /require\('\.\/main\/phoneRemote'\)/);
  assert.match(mainSrc, /phoneRemote\.init\(ctx, \{\s*spotify: spotifyModule, lyrics: lyricsModule, license: licenseModule, siteUrl: licenseModule\.SITE_URL\s*\}\)/);
  assert.match(mainSrc, /if \(phoneRemoteModule\) phoneRemoteModule\.teardown\(\);/);
});

test('the widget is registered, has its panel, and hears its switch', () => {
  const core = read('renderer', 'core.js');
  const entry = core.slice(core.indexOf("id: 'phoneRemote'"));
  assert.match(entry.slice(0, 1600), /panelId: 'phone-remote-panel',\s*panelRenderer: 'renderPhoneRemotePanel'/);
  assert.match(panelSrc, /function renderPhoneRemotePanel\(\)/);
  assert.match(panelSrc, /if \(!panel\) return;/);
  const scripts = [...htmlSrc.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.indexOf('renderer/qr-code.js') !== -1 && scripts.indexOf('renderer/qr-code.js') < scripts.indexOf('renderer/phone-remote.js'));
  assert.match(read('renderer', 'widgets-settings.js'), /applyPhoneRemoteEnabled\(!!prefs\.phoneRemote\)/);
});

test('the pairing code is drawn from the QR matrix, never from the link text', () => {
  const code = stripComments(panelSrc);
  assert.match(code, /QRCode\.encode\(phoneRemoteLink, 'M'\)/);
  assert.doesNotMatch(code, /\$\{phoneRemoteLink\}/, 'the link is never interpolated into markup');
});

test('the phone page builds nothing from the wire as markup, and its CSP holds it to that', () => {
  const remoteJs = stripComments(readRepo('website', 'public', 'remote', 'remote.js'));
  assert.doesNotMatch(remoteJs, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const page = readRepo('website', 'public', 'remote', 'index.html');
  const csp = page.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  const directives = new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));
  assert.deepEqual(directives.get('default-src'), ["'none'"]);
  assert.deepEqual(directives.get('script-src'), ["'self'"], 'no inline script, no remote script');
  assert.deepEqual(directives.get('style-src'), ["'self'"]);
  assert.deepEqual(directives.get('connect-src'), ['wss:', 'ws://localhost:*', 'ws://127.0.0.1:*']);
  assert.match(page, /<meta name="referrer" content="no-referrer">/);
  assert.doesNotMatch(page, /<script>[\s\S]*?<\/script>|\son[a-z]+="/i, 'no inline script or handlers');
});
