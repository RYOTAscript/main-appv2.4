// Stage 2 — macOS build & packaging config.
// Validates package.json build targets, the entitlements plist, and the two
// electron-builder hooks (fuses/afterPack, notarize/afterSign) — all from
// Windows, without running an actual mac build.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FuseV1Options } = require('@electron/fuses');

const APP = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));

// ── package.json: scripts ──────────────────────────────────────────────
test('mac build scripts exist', () => {
  assert.equal(pkg.scripts['build:mac'], 'electron-builder --mac --publish never');
  assert.equal(pkg.scripts['build:mac:dir'], 'electron-builder --mac --dir --publish never');
  // Windows build script is untouched.
  assert.equal(pkg.scripts.build, 'electron-builder --win --publish never');
});

// ── package.json: mac target ───────────────────────────────────────────
test('build.mac target ships dmg + zip for arm64 and x64', () => {
  const mac = pkg.build.mac;
  assert.ok(mac, 'build.mac exists');
  const byTarget = Object.fromEntries(mac.target.map(t => [t.target, t.arch]));
  assert.deepEqual(byTarget.dmg, ['arm64', 'x64'], 'dmg for both arches');
  assert.deepEqual(byTarget.zip, ['arm64', 'x64'], 'zip (auto-update feed) for both arches');
});

test('build.mac has hardened runtime + entitlements + category', () => {
  const mac = pkg.build.mac;
  assert.equal(mac.hardenedRuntime, true);
  assert.equal(mac.gatekeeperAssess, false);
  assert.equal(mac.entitlements, 'build/entitlements.mac.plist');
  assert.equal(mac.entitlementsInherit, 'build/entitlements.mac.plist');
  assert.equal(mac.category, 'public.app-category.utilities');
  // Built-in auto-notarize is off; our afterSign hook owns notarization.
  assert.equal(mac.notarize, false);
});

test('build.mac declares the TCC usage strings it will trigger', () => {
  const info = pkg.build.mac.extendInfo;
  assert.ok(info.NSMicrophoneUsageDescription, 'mic usage string present');
  assert.ok(info.NSAppleEventsUsageDescription, 'apple-events usage string present');
});

test('mac icon source exists and is a large square PNG', () => {
  const iconRel = pkg.build.mac.icon;
  assert.ok(iconRel, 'mac.icon set');
  const buf = fs.readFileSync(path.join(APP, iconRel));
  assert.equal(buf.slice(1, 4).toString(), 'PNG', 'icon is a PNG');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  assert.equal(w, h, 'icon is square');
  assert.ok(w >= 512, `icon is >=512px (got ${w}) so electron-builder can build the .icns`);
});

test('dmg artifactName is versioned + arch-tagged', () => {
  assert.match(pkg.build.dmg.artifactName, /\$\{version\}/);
  assert.match(pkg.build.dmg.artifactName, /\$\{arch\}/);
});

test('both electron-builder hooks are wired', () => {
  assert.equal(pkg.build.afterPack, './build/fuses.js');
  assert.equal(pkg.build.afterSign, './build/notarize.js');
});

test('@electron/notarize is declared as a devDependency', () => {
  assert.ok(pkg.devDependencies['@electron/notarize'], 'notarize devDependency present');
});

// ── entitlements plist ─────────────────────────────────────────────────
test('entitlements.mac.plist is well-formed and grants the needed keys', () => {
  const plist = fs.readFileSync(path.join(APP, 'build', 'entitlements.mac.plist'), 'utf8');
  assert.match(plist, /^<\?xml/, 'starts with XML prolog');
  assert.match(plist, /<plist[^>]*>/);
  assert.match(plist, /<\/plist>/);
  // Balanced <dict> tags.
  assert.equal((plist.match(/<dict>/g) || []).length, (plist.match(/<\/dict>/g) || []).length);
  for (const key of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.disable-library-validation',
    'com.apple.security.device.audio-input',
    'com.apple.security.automation.apple-events',
    'com.apple.security.files.user-selected.read-write',
  ]) {
    assert.ok(plist.includes(key), `entitlement ${key} present`);
  }
});

// ── build/fuses.js ─────────────────────────────────────────────────────
const fuses = require('../build/fuses.js');

test('fuseOptionsFor hardens win32 and darwin, ignores others', () => {
  const win = fuses.fuseOptionsFor('win32');
  const mac = fuses.fuseOptionsFor('darwin');
  assert.ok(win && mac, 'options returned for win32 + darwin');
  assert.equal(fuses.fuseOptionsFor('linux'), null, 'linux not hardened here');

  // Core hardening applied on both.
  for (const o of [win, mac]) {
    assert.equal(o[FuseV1Options.RunAsNode], false);
    assert.equal(o[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
    assert.equal(o[FuseV1Options.EnableNodeCliInspectArguments], false);
    assert.equal(o[FuseV1Options.OnlyLoadAppFromAsar], true);
    assert.equal(o[FuseV1Options.EnableCookieEncryption], true);
  }
});

test('fuseOptionsFor: mac re-signs ad-hoc; asar-integrity is win-only', () => {
  const win = fuses.fuseOptionsFor('win32');
  const mac = fuses.fuseOptionsFor('darwin');
  assert.equal(mac.resetAdHocDarwinSignature, true, 'mac binary is re-signed after flipping');
  assert.equal(win.resetAdHocDarwinSignature, false, 'no-op on Windows');
  assert.equal(win[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true, 'asar integrity on Windows');
  assert.equal(mac[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], undefined, 'asar integrity left off on mac');
});

test('binaryPathFor resolves per-platform packaged binary', () => {
  const ctx = (platform) => ({ electronPlatformName: platform, appOutDir: '/out', packager: { appInfo: { productFilename: 'main' } } });
  assert.ok(fuses.binaryPathFor(ctx('win32')).endsWith('main.exe'));
  const macPath = fuses.binaryPathFor(ctx('darwin')).replace(/\\/g, '/');
  assert.ok(macPath.endsWith('main.app/Contents/MacOS/main'), `mac binary path (${macPath})`);
  assert.equal(fuses.binaryPathFor(ctx('linux')), null);
});

test('afterPack default no-ops on an unsupported platform (no throw)', async () => {
  const ctx = { electronPlatformName: 'linux', appOutDir: '/out', packager: { appInfo: { productFilename: 'main' } } };
  await fuses.default(ctx); // must resolve without touching any binary
});

// ── build/notarize.js ──────────────────────────────────────────────────
const notarize = require('../build/notarize.js');

test('hasCredentials detects either credential set', () => {
  assert.equal(notarize.hasCredentials({}), false);
  assert.equal(notarize.hasCredentials({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }), true);
  assert.equal(notarize.hasCredentials({ APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 'u' }), true);
  // Partial creds → not enough.
  assert.equal(notarize.hasCredentials({ APPLE_ID: 'a' }), false);
});

test('notarizeOptionsFor prefers the API key, else Apple ID', () => {
  const api = notarize.notarizeOptionsFor({ APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 'u' }, '/x.app');
  assert.deepEqual(api, { appPath: '/x.app', appleApiKey: 'k', appleApiKeyId: 'i', appleApiIssuer: 'u' });
  const id = notarize.notarizeOptionsFor({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }, '/x.app');
  assert.deepEqual(id, { appPath: '/x.app', appleId: 'a', appleIdPassword: 'b', teamId: 'c' });
});

test('afterSign default: no-op on Windows, clean skip on mac without creds', async () => {
  // Windows → returns immediately.
  await notarize.default({ electronPlatformName: 'win32', appOutDir: '/out', packager: { appInfo: { productFilename: 'main' } } });

  // macOS with no creds → skips without requiring @electron/notarize or throwing.
  const saved = {};
  for (const k of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    await notarize.default({ electronPlatformName: 'darwin', appOutDir: '/out', packager: { appInfo: { productFilename: 'main' } } });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});
