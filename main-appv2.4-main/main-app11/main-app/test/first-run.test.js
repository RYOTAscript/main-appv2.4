'use strict';

// The first-run welcome window: what it is allowed to reach, and what it must
// tell the user.
//
// Two things here are easy to undo by accident and impossible to notice:
//
//   1. The window's BRIDGE. It originally loaded the main preload.js, handing a
//      welcome screen the entire electronAPI surface — every feature channel in
//      the app — so it could render four lines of text. It now has its own
//      four-method preload, like every other auxiliary window. Pointing it back
//      at preload.js would look like a one-word simplification.
//
//   2. The ACCEPTANCE NOTICE. The installer is one-click and shows no license
//      page, so this screen is the only place the user is told what they are
//      agreeing to. Deleting the line leaves the product with no click-through
//      acceptance anywhere, and nothing fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const here = (...p) => path.join(__dirname, '..', ...p);

// A "this must NOT appear" assertion has to run against CODE, not against the
// file — otherwise the comment explaining why the thing is absent trips the
// assertion that checks it is absent. (Both of these did, first time out.)
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const mainSrc = fs.readFileSync(here('main', 'firstRun.js'), 'utf8');
const preloadSrc = fs.readFileSync(here('first-run-preload.js'), 'utf8');
const htmlSrc = fs.readFileSync(here('first-run.html'), 'utf8');
const rendererSrc = fs.readFileSync(here('renderer', 'first-run.js'), 'utf8');
const appPreloadSrc = fs.readFileSync(here('preload.js'), 'utf8');
const pkg = require(here('package.json'));

test('the welcome window loads its own narrow preload, not the app bridge', () => {
  assert.match(mainSrc, /preload:\s*path\.join\(__dirname,\s*'\.\.',\s*'first-run-preload\.js'\)/,
    'main/firstRun.js must point at first-run-preload.js');
  assert.ok(!/preload:\s*path\.join\(__dirname,\s*'\.\.',\s*'preload\.js'\)/.test(stripComments(mainSrc)),
    'it must NOT load the main app preload — that exposes the whole electronAPI surface');
});

test('the narrow bridge exposes only what the welcome screen actually does', () => {
  const exposed = [...preloadSrc.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exposed, ['done', 'getAppVersion', 'getFocusHotkey', 'openLegal'],
    'exactly four methods: read a version, read a hotkey, open a legal page, close');
  // No general-purpose escape hatch. The page names a KEY, main picks the URL.
  assert.ok(!/openExternal/.test(stripComments(preloadSrc)),
    'the welcome page must not be able to name a URL to open');
});

test('main resolves the legal links itself and refuses anything else', () => {
  assert.match(mainSrc, /LEGAL_URLS\s*=\s*\{/, 'a closed map of allowed destinations');
  assert.match(mainSrc, /terms:\s*`\$\{SITE_URL\}\/terms`/);
  assert.match(mainSrc, /privacy:\s*`\$\{SITE_URL\}\/privacy`/);
  // The lookup must be a map hit, never a pass-through of the renderer's value.
  const handler = mainSrc.slice(mainSrc.indexOf("'first-run:open-legal'"));
  assert.match(handler, /const url = LEGAL_URLS\[String\(which\)\]/,
    'the key is looked up, not used as a URL');
  assert.match(handler, /if \(!url\)/, 'an unknown key must be refused');
  assert.ok(handler.indexOf('if (!url)') < handler.indexOf('shell.openExternal'),
    'the refusal must come BEFORE anything is opened');
});

test('the legal URLs come from the one site constant, so they cannot drift', () => {
  // A hardcoded domain here would survive a deploy to a new one and quietly
  // point the Terms link at a dead host.
  assert.match(mainSrc, /require\('\.\/license'\)/);
  assert.match(mainSrc, /\{\s*SITE_URL\s*\}\s*=\s*require\('\.\/license'\)/);
  const licenseSrc = fs.readFileSync(here('main', 'license.js'), 'utf8');
  assert.match(licenseSrc, /module\.exports\s*=\s*\{[^}]*SITE_URL[^}]*\}/,
    'main/license.js must export SITE_URL for this to work');
  assert.ok(!/https:\/\/[a-z0-9.-]*vercel\.app/.test(stripComments(mainSrc)),
    'no hardcoded site URL in firstRun.js');
});

test('the welcome screen states what continuing agrees to, and links both documents', () => {
  // The one-click installer shows no license page, so if this line goes, the
  // product has no click-through acceptance at all.
  assert.match(htmlSrc, /By continuing you agree to the/i,
    'the acceptance line must be present');
  assert.match(htmlSrc, /data-legal="terms"[^>]*>\s*Terms\s*</,
    'a Terms link');
  assert.match(htmlSrc, /data-legal="privacy"[^>]*>\s*Privacy Policy\s*</,
    'a Privacy Policy link');
});

test('the acceptance line sits with the button it describes', () => {
  // Click-wrap depends on the notice being next to the action, not filed away
  // at the bottom of the window.
  const cta = htmlSrc.indexOf('id="start"');
  const legal = htmlSrc.indexOf('class="legal');
  const foot = htmlSrc.indexOf('class="foot');
  assert.ok(cta !== -1 && legal !== -1 && foot !== -1);
  assert.ok(cta < legal, 'the notice follows the button');
  assert.ok(legal < foot, 'and comes before the footer, not after it');
});

test('reading the terms does not dismiss the welcome screen', () => {
  // Someone who stops to read is not someone who is finished.
  const handler = rendererSrc.slice(rendererSrc.indexOf(".legal'"));
  assert.match(handler, /openLegal/);
  const closeCallInHandler = handler.slice(0, handler.indexOf('});'));
  assert.ok(!/\bclose\(\)/.test(closeCallInHandler),
    'the legal-link handler must not close the window');
});

test('the first-run files are in the packaged build', () => {
  // A window whose page is missing still OPENS, and this one is transparent —
  // it opens as an invisible rectangle over the desktop with no error anywhere.
  for (const file of ['first-run.html', 'first-run-preload.js']) {
    assert.ok(pkg.build.files.includes(file),
      `${file} must be in package.json build.files or it ships broken`);
  }
});

test('the welcome bridge is not duplicated on the main app surface', () => {
  // It lived on electronAPI briefly. Nothing in the main renderer used it, and
  // leaving it there would keep the wide surface the narrow preload removed.
  assert.ok(!/firstRunDone/.test(stripComments(appPreloadSrc)),
    'firstRunDone belongs on the welcome window bridge only');
});

test('re-initialising cannot throw on an already-registered channel', () => {
  // ipcMain.handle() throws on a second registration for a live channel, and
  // ipcMain.eventNames() can NEVER see a handle()-registered channel — it only
  // reports .on() listeners — so the guard that used it was dead code.
  assert.ok(!/eventNames\(\)/.test(stripComments(mainSrc)),
    'eventNames() cannot detect a handle() channel; use removeHandler instead');
  for (const channel of ['get-app-version', 'first-run-done', 'first-run:open-legal', 'first-run-show']) {
    assert.ok(
      mainSrc.includes(`ipcMain.removeHandler('${channel}')`),
      `${channel} must be removeHandler'd before it is handled`,
    );
  }
});
