'use strict';

// Player Style (Glass / White) and the full-screen stage's controls — the parts
// that fail SILENTLY in a running app: a stylesheet that loads before Tailwind
// and loses every tie, a White rule that leaks into Glass, a CSS rule thrown
// away for a pseudo-element inside :is(), an inline handler naming a function
// that does not exist, an empty <img> drawing Chromium's broken-image icon in
// the middle of the record, and a follow-loop that does DOM work on every
// frame of a stage that is just sitting there.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stripCss = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

const htmlSrc = read('main.html');
const styleSrc = read('renderer', 'player-style.js');
const fslSrc = read('renderer', 'fullscreen-lyrics.js');
const widgetSrc = read('renderer', 'spotify-widget.js');
const enhancedSrc = read('renderer', 'spotify-enhanced.js');
const widgetsSettingsSrc = read('renderer', 'widgets-settings.js');
const cssSrc = stripCss(read('styles', 'player-style.css'));
const mainCssSrc = stripCss(read('styles', 'main.css'));

// Every global function any renderer script declares.
const declared = new Set();
for (const f of fs.readdirSync(path.join(ROOT, 'renderer'))) {
  if (!f.endsWith('.js')) continue;
  for (const m of read('renderer', f).matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) declared.add(m[1]);
}

/** Top-level rule preludes in a stylesheet, with @media blocks descended into
 *  and @keyframes skipped (their from/to/% are not selectors). */
function selectorsOf(css) {
  const out = [];
  let i = 0;
  const walk = (stopAtClose) => {
    let prelude = '';
    while (i < css.length) {
      const ch = css[i++];
      if (ch === '{') {
        const p = prelude.trim();
        prelude = '';
        if (p.startsWith('@media') || p.startsWith('@supports')) { walk(true); continue; }
        if (p.startsWith('@')) { skipBlock(); continue; }
        out.push(p);
        skipBlock();
      } else if (ch === '}') {
        if (stopAtClose) return;
      } else {
        prelude += ch;
      }
    }
  };
  const skipBlock = () => {
    let depth = 1;
    while (i < css.length && depth) {
      const ch = css[i++];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  };
  walk(false);
  return out;
}

test('the stylesheet loads after main.css and before Tailwind, which must stay last', () => {
  const links = [...htmlSrc.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  const at = (href) => links.indexOf(href);
  assert.ok(at('styles/player-style.css') > at('styles/main.css'), 'after main.css, so its overrides win ties');
  assert.equal(links[links.length - 1], 'styles/vendor/tailwind.css', 'Tailwind still loads last');
});

test('the switcher loads after settings.js and before the player and the stage', () => {
  const scripts = [...htmlSrc.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const at = (src) => scripts.indexOf(src);
  assert.ok(at('renderer/player-style.js') > at('renderer/settings.js'), 'needs scheduleSettingsSave');
  assert.ok(at('renderer/player-style.js') < at('renderer/spotify-widget.js'));
  assert.ok(at('renderer/player-style.js') < at('renderer/fullscreen-lyrics.js'));
});

/** A selector list split on its top-level commas (not the ones inside :is()). */
function splitSelectorList(prelude) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

test('every White rule is scoped to a White element, so Glass is never touched', () => {
  const allowed = /^(#widget-spotify\.player-white|#fullscreen-lyrics\.player-white|\.pstyle-)/;
  for (const prelude of selectorsOf(cssSrc)) {
    for (const sel of splitSelectorList(prelude)) {
      assert.match(sel, allowed, `unscoped selector: ${sel}`);
    }
  }
});

test('no rule puts a pseudo-element inside :is() — the browser drops the whole rule', () => {
  for (const [name, css] of [['player-style.css', cssSrc], ['main.css', mainCssSrc]]) {
    for (const prelude of selectorsOf(css)) {
      for (const m of prelude.matchAll(/:is\(([^)]*)\)/g)) {
        assert.ok(!m[1].includes('::'), `${name}: ${prelude}`);
      }
    }
  }
});

test('both looks are offered in Settings, each wired to its own value', () => {
  const buttons = [...htmlSrc.matchAll(/data-player-style="([^"]+)"\s+onclick="setSpotifyPlayerStyle\('([^']+)'\)"/g)];
  assert.deepEqual(buttons.map(m => m[1]).sort(), ['glass', 'white']);
  for (const m of buttons) assert.equal(m[1], m[2], 'a tile must set the look it shows');
});

test('the record images can never draw a broken-image icon', () => {
  const disk = htmlSrc.match(/<img id="spotify-disk"[^>]*>/)[0];
  const sleeve = htmlSrc.match(/<img id="spotify-album-cover"[^>]*>/)[0];
  assert.match(disk, /alt=""/);
  assert.match(sleeve, /alt=""/);
  assert.match(disk, /onerror="spotifyDiskImageError\(this\)"/);
  // "No cover" is a transparent pixel, never a missing src.
  assert.doesNotMatch(styleSrc, /disk\.removeAttribute\('src'\)/);
  assert.match(styleSrc, /BLANK_LABEL = 'data:image\/gif;base64,/);
});

test('the look survives a settings backup', () => {
  assert.match(widgetsSettingsSrc, /spotifyPlayerStyle: localStorage\.getItem\('spotifyPlayerStyle'\)/);
  assert.match(widgetsSettingsSrc, /setSpotifyPlayerStyle\(data\.spotifyPlayerStyle\)/);
});

test('the volume fill reads its colours from variables, so White can repaint it', () => {
  assert.equal((widgetSrc.match(/var\(--accent-solid, #fff\) \$\{pct/g) || []).length, 0,
    'every volume paint goes through paintSpotifyVolume');
  assert.match(widgetSrc, /var\(--spotify-vol-fill, var\(--accent-solid, #fff\)\)/);
  assert.match(cssSrc, /--spotify-vol-fill:/);
});

test('every control on the full-screen stage calls a function that exists', () => {
  const start = htmlSrc.indexOf('<div id="fullscreen-lyrics"');
  const stage = htmlSrc.slice(start, htmlSrc.indexOf('<script', start));
  const called = new Set([...stage.matchAll(/on(?:click|input)="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]));
  for (const fn of ['spotifyTogglePlay', 'spotifyControl', 'spotifyToggleShuffle', 'spotifyCycleRepeat',
    'fslToggleLike', 'fslVolumeInput', 'setFslTab', 'toggleFslLook', 'closeFullscreenLyrics']) {
    assert.ok(called.has(fn), `${fn} is wired on the stage`);
  }
  for (const fn of called) assert.ok(declared.has(fn), `${fn}() is not declared in any renderer script`);
  for (const id of ['fsl-play', 'fsl-shuffle', 'fsl-repeat', 'fsl-like', 'fsl-volume', 'fsl-queue', 'fsl-context-name', 'fsl-vinyl-label']) {
    assert.ok(stage.includes(`id="${id}"`), `#${id} exists`);
  }
});

test('Up next is built from Spotify data with textContent only', () => {
  const body = fslSrc.slice(fslSrc.indexOf('function fslQueueEl('), fslSrc.indexOf('// ── Reactive skip'));
  assert.ok(body.includes('async function renderFslQueue'), 'the queue renderer is in the checked span');
  assert.doesNotMatch(body, /innerHTML|insertAdjacentHTML/);
});

test('the stage can show the heart even while the player heart is off', () => {
  assert.match(enhancedSrc, /async function spotifyRefreshLiked\(track, force = false\)/);
  assert.match(enhancedSrc, /if \(!force && !spotifyLikeEnabled\(\)\) return;/);
  // Reset before the "widget off" early return, so a stale heart never shows.
  const fn = enhancedSrc.slice(enhancedSrc.indexOf('async function spotifyEnhancedOnTrackChanged'));
  assert.ok(fn.indexOf('spotifyEnhancedCurrentSaved = null') < fn.indexOf('if (!isSpotifyEnhancedEnabled()) return;'));
});

// ── Behaviour, in a vm ─────────────────────────────────────────────────────

function fakeDom() {
  const counts = { writes: 0, lookups: 0 };
  const els = {};
  const make = (id) => {
    const classes = new Set();
    const attrs = {};
    const style = {};
    let title = '';
    let value = '';
    let className = '';
    const el = {
      id,
      isConnected: true,
      dataset: {},
      classList: {
        toggle(c, on) {
          const want = on === undefined ? !classes.has(c) : !!on;
          if (want) classes.add(c); else classes.delete(c);
          counts.writes++;
          return want;
        },
        add(...c) { c.forEach(x => classes.add(x)); counts.writes++; },
        remove(...c) { c.forEach(x => classes.delete(x)); counts.writes++; },
        contains: (c) => classes.has(c),
      },
      setAttribute(k, v) { attrs[k] = String(v); counts.writes++; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      removeAttribute(k) { delete attrs[k]; counts.writes++; },
      style: Object.assign(style, { setProperty(k, v) { style[k] = v; counts.writes++; } }),
      addEventListener() {},
      querySelector() { return els[`${id}:i`] || (els[`${id}:i`] = make(`${id}:i`)); },
      get title() { return title; },
      set title(v) { title = v; counts.writes++; },
      get value() { return value; },
      set value(v) { value = String(v); counts.writes++; },
      get className() { return className; },
      set className(v) { className = v; counts.writes++; },
      get src() { return attrs.src || ''; },
      set src(v) { attrs.src = String(v); counts.writes++; },
      has: (c) => classes.has(c),
    };
    return el;
  };
  const document = {
    getElementById(id) { counts.lookups++; return els[id] || (els[id] = make(id)); },
    querySelectorAll() { return []; },
  };
  return { document, els, counts };
}

function boot(src, { prelude = '', store = {} } = {}) {
  const dom = fakeDom();
  const map = new Map(Object.entries(store));
  const sandbox = {
    console,
    document: dom.document,
    localStorage: { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  if (prelude) vm.runInContext(prelude, sandbox);
  vm.runInContext(src, sandbox);
  return {
    ...dom,
    store: map,
    el: (id) => dom.document.getElementById(id),
    run: (code) => vm.runInContext(code, sandbox),
  };
}

test('the look is sanitised, stored, and applied to the card and the stage together', () => {
  const app = boot(styleSrc, { prelude: 'function scheduleSettingsSave() {}', store: { spotifyPlayerStyle: 'neon' } });
  assert.equal(app.run('getSpotifyPlayerStyle()'), 'glass', 'an unknown value falls back to Glass');
  app.run("setSpotifyPlayerStyle('white')");
  assert.equal(app.store.get('spotifyPlayerStyle'), 'white');
  assert.ok(app.els['widget-spotify'].has('player-white'));
  assert.ok(app.els['fullscreen-lyrics'].has('player-white'));
  app.run("setSpotifyPlayerStyle('sepia')");
  assert.equal(app.store.get('spotifyPlayerStyle'), 'white', 'an unknown look is ignored');
  app.run("setSpotifyPlayerStyle('glass')");
  assert.ok(!app.els['widget-spotify'].has('player-white'));
  assert.equal(app.els['spotify-disk'].getAttribute('src'), 'icons/player.png', 'Glass gets its vinyl image back');
});

test('White puts the sleeve’s cover on the label, and a blank label without one', () => {
  const app = boot(styleSrc, { prelude: 'function scheduleSettingsSave() {}', store: { spotifyPlayerStyle: 'white' } });
  const disk = app.els['spotify-disk'];
  const sleeve = app.els['spotify-album-cover'];
  assert.match(disk.getAttribute('src'), /^data:image\/gif/, 'no cover yet: a transparent pixel');
  sleeve.setAttribute('src', 'https://i.scdn.co/image/abc');
  sleeve.style.display = 'block';
  app.run('syncSpotifyDiskArt()');
  assert.equal(disk.getAttribute('src'), 'https://i.scdn.co/image/abc');
  // A cover that fails is not retried on the next sync.
  app.run("spotifyDiskImageError(document.getElementById('spotify-disk'))");
  assert.match(disk.getAttribute('src'), /^data:image\/gif/);
  app.run('syncSpotifyDiskArt()');
  assert.match(disk.getAttribute('src'), /^data:image\/gif/);
  sleeve.style.display = 'none';
  app.run('syncSpotifyDiskArt()');
  assert.match(disk.getAttribute('src'), /^data:image\/gif/, 'a hidden sleeve means no cover');
});

const stagePrelude = `
  let spotifyIsPlaying = false;
  let spotifyModeState = { shuffle: false, repeat: 'off' };
  let spotifyEnhancedCurrentSaved = null;
  let spotifyCurrentTrack = null;
  let isDraggingVolume = false;
  const SPOTIFY_REPEAT_TITLES = { off: 'Repeat: off', context: 'Repeat: all', track: 'Repeat: this song' };
  let volumeCalls = [];
  function spotifyVolumeSliderInput(v) { volumeCalls.push(v); }
`;

test('the stage mirrors play, shuffle, repeat, heart and volume from the player', () => {
  const app = boot(fslSrc, { prelude: stagePrelude });
  app.run("spotifyIsPlaying = true; spotifyModeState = { shuffle: true, repeat: 'track' }; spotifyEnhancedCurrentSaved = true;");
  app.el('spotify-volume').value = '64';
  app.run('updateFslControls(true)');
  assert.ok(app.els['fsl-play'].has('is-playing'));
  assert.ok(!app.els['fullscreen-lyrics'].has('fsl-paused'));
  assert.ok(app.els['fsl-shuffle'].has('is-on'));
  assert.ok(app.els['fsl-repeat'].has('is-on') && app.els['fsl-repeat'].has('is-track'));
  assert.equal(app.els['fsl-repeat'].title, 'Repeat: this song');
  assert.ok(app.els['fsl-like'].has('is-liked'));
  assert.equal(app.els['fsl-like:i'].className, 'fas fa-heart');
  assert.equal(app.els['fsl-volume'].value, '64');
  assert.equal(app.els['fsl-volume'].style['--fsl-vol'], '64%');

  app.run('spotifyIsPlaying = false;');
  app.run('updateFslControls()');
  assert.ok(app.els['fullscreen-lyrics'].has('fsl-paused'), 'paused stops the record and the bars');
});

test('a stage frame where nothing changed does no DOM work', () => {
  const app = boot(fslSrc, { prelude: stagePrelude });
  app.el('spotify-volume').value = '40';
  app.run('updateFslControls(true)');
  app.counts.writes = 0;
  app.counts.lookups = 0;
  app.run('for (let i = 0; i < 240; i++) updateFslControls();');
  assert.equal(app.counts.writes, 0, 'no writes on an unchanged frame');
  assert.equal(app.counts.lookups, 0, 'and no lookups either');
});

test('the stage volume drives the player slider, and a drag is never overwritten', () => {
  const app = boot(fslSrc, { prelude: stagePrelude });
  app.run("fslVolumeInput('30')");
  assert.equal(app.el('spotify-volume').value, '30');
  assert.equal(app.run('JSON.stringify(volumeCalls)'), '[30]', 'one debounced call, with a number');
  assert.equal(app.els['fsl-volume'].style['--fsl-vol'], '30%');

  app.run('fslVolumeDragging = true;');
  app.els['spotify-volume'].value = '80';   // a poll lands mid-drag
  app.run('updateFslControls()');
  assert.equal(app.els['fsl-volume'].style['--fsl-vol'], '30%', 'the thumb stays under the pointer');
  app.run('fslVolumeDragging = false;');
  app.run('updateFslControls()');
  assert.equal(app.els['fsl-volume'].style['--fsl-vol'], '80%', 'and catches up once released');
});
