'use strict';

// What the corner player's window does between polls. The bug these pin down
// was invisible in any one frame: every 2.5s Spotify's position lands a few
// hundred ms off, and taken literally that made a lyric line drop back and come
// straight in again, the whole lyric block blink, and the progress bar hiccup.
// Same with what it costs: it sits on top of games for hours, and moving width
// or left instead of transform is main-thread layout on every frame, for as
// long as the music plays, with nothing to show for it in any screenshot.
//
// These run the REAL renderer/mini-player-window.js in a vm, on a virtual clock,
// with a DOM that counts what it is asked to do. Same idea as animation-idle.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const engineSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'mini-player-engine.js'), 'utf8');
const windowSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'mini-player-window.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'mini-player.html'), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const CARD_IDS = [
  'card', 'tools', 'lyric', 'lyric-rows', 'lyric-measure', 'lyric-live', 'row', 'halo', 'disk', 'cover-tile',
  'vinyl-slide', 'vinyl', 'cover-label', 'cover-sleeve', 'title', 'artist', 'seek', 'seek-fill', 'seek-rail',
  't-cur', 't-total', 'btn-prev', 'btn-play', 'btn-next', 'btn-expand', 'btn-dismiss'
];

function boot({ reducedMotion = false } = {}) {
  let now = 1000000;
  let seq = 0;
  const timers = new Map();
  const counts = { animate: {}, textWrites: {}, rowsAdded: 0, heights: [] };
  const currents = [];       // every text that became the current lyric row, in order
  const actions = [];
  let frames = 0;

  const addTimer = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, seq: id });
    return id;
  };
  const clearTimer = (id) => { timers.delete(id); };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      let due = null;
      for (const [id, t] of timers) {
        if (t.at <= end && (!due || t.at < due.t.at || (t.at === due.t.at && t.seq < due.t.seq))) due = { id, t };
      }
      if (!due) break;
      timers.delete(due.id);
      now = Math.max(now, due.t.at);
      due.t.fn(now);
    }
    now = end;
  }

  function makeAnimation(el) {
    const a = {
      playState: 'running',
      playbackRate: 1,
      play() { a.playState = 'running'; },
      pause() { a.playState = 'paused'; },
      cancel() {
        a.playState = 'idle';
        el.anims = el.anims.filter((x) => x !== a);
      }
    };
    return a;
  }

  function makeEl(id) {
    let text = '';
    const classes = new Set();
    const el = {
      id,
      anims: [],
      children: [],
      parent: null,
      dataset: {},
      title: '',
      attrs: {},
      listeners: {},
      offsetWidth: 150,
      offsetHeight: 123,
      offsetLeft: 277,
      clientWidth: 334,
      style: { setProperty() {}, transform: '', transformOrigin: '' },
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return text; },
      set textContent(v) {
        text = String(v);
        el.children = [];
        if (id) counts.textWrites[id] = (counts.textWrites[id] || 0) + 1;
      },
      classList: {
        add(...c) {
          for (const x of c) {
            if (x === 'is-cur' && !classes.has('is-cur')) currents.push(text);
            classes.add(x);
          }
        },
        remove(...c) { for (const x of c) classes.delete(x); },
        toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
        contains(c) { return classes.has(c); }
      },
      animate(keyframes, opts) {
        counts.animate[id || 'row'] = (counts.animate[id || 'row'] || 0) + 1;
        const a = makeAnimation(el);
        a.keyframes = keyframes;
        a.options = opts;
        el.anims.push(a);
        return a;
      },
      getAnimations() { return el.anims.slice(); },
      appendChild(c) {
        if (el === elements['lyric-rows']) counts.rowsAdded++;
        el.children.push(c);
        c.parent = el;
        return c;
      },
      after() {},
      remove() {
        if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
        el.parent = null;
      },
      cloneNode() { return makeEl(''); },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
      removeAttribute(k) { delete el.attrs[k]; },
      addEventListener(type, fn) { el.listeners[type] = fn; },
      getBoundingClientRect() { return { left: 0, top: 0, width: el.offsetWidth, height: el.offsetHeight }; },
      querySelector() { return null; }
    };
    Object.defineProperty(el, 'src', {
      get() { return el.attrs.src; },
      set(v) { el.attrs.src = String(v); }
    });
    return el;
  }

  const elements = {};
  for (const id of CARD_IDS) elements[id] = makeEl(id);
  const body = makeEl('body');
  let apply = null;

  const sandbox = {
    console,
    Math, Number, String, Object, Array, Map, Set, Promise, JSON,
    Date: { now: () => now },
    performance: { now: () => now },
    setTimeout: addTimer,
    clearTimeout: clearTimer,
    requestAnimationFrame(cb) { frames++; return addTimer(cb, 16); },
    cancelAnimationFrame: clearTimer,
    getComputedStyle: () => ({ transform: 'none' }),
    DOMMatrixReadOnly: function () { this.m41 = 0; },
    Image: function () {
      const img = this;
      Object.defineProperty(img, 'src', { set() { addTimer(() => img.onload && img.onload(), 20); } });
    },
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {} }),
    addEventListener() {},
    miniPlayer: {
      ready: () => Promise.resolve(null),
      action: (a, v) => { actions.push([a, v]); return Promise.resolve({ ok: true }); },
      laidOut: (h) => counts.heights.push(h),
      menu() {},
      dismiss() {},
      expand() {},
      onState: (fn) => { apply = fn; }
    },
    document: {
      body,
      documentElement: makeEl('html'),
      getElementById: (id) => elements[id] || null,
      createElement: () => makeEl('')
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(engineSrc, sandbox, { filename: 'mini-player-engine.js' });
  vm.runInContext(windowSrc, sandbox, { filename: 'mini-player-window.js' });

  return {
    apply: (s) => apply(s),
    advance,
    now: () => now,
    counts,
    currents,
    actions,
    elements,
    body,
    pendingTimers: () => timers.size,
    frames: () => frames,
    curRow: () => elements['lyric-rows'].children.find((c) => c.classList.contains('is-cur')),
    nextRow: () => elements['lyric-rows'].children.find((c) => c.classList.contains('is-next') && !c.classList.contains('is-faded'))
  };
}

const TRACK = { id: 'a', name: 'Song', artist: 'Artist', album: 'Album', image: 'https://i.scdn.co/a', durationMs: 180000 };
const LINES = [];
for (let i = 0; i < 40; i++) LINES.push({ t: 5000 + i * 3000, text: 'line ' + i });
const READY = { status: 'ready', synced: true, lines: LINES };
const PREFS = { lyrics: true, style: 'glass', accent: '#ffffff', anticipateMs: 700, corner: 'bottom-right' };

function stateAt(page, positionMs, over) {
  return Object.assign({
    presence: 'in', prefs: PREFS, track: TRACK, playing: true, progressMs: positionMs, at: page.now(), lyrics: READY
  }, over);
}

// A reproducible stream of noise, so a failure can be replayed.
function noiseSource(seed) {
  let s = seed;
  return (range) => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return ((s / 4294967296) * 2 - 1) * range;
  };
}

test('a noisy poll moves nothing: every line appears exactly once, in order', () => {
  const page = boot();
  const start = 10000;
  page.apply(stateAt(page, start));          // arrives
  page.advance(800);
  const barAnimations = page.counts.animate['seek-rail'];
  const titleWrites = page.counts.textWrites.title;
  const totalWrites = page.counts.textWrites['t-total'];
  const rowsBefore = page.counts.rowsAdded;
  page.currents.length = 0;

  const noise = noiseSource(7);
  const t0 = page.now();
  // A minute of polls, four times the real rate, each up to 450ms off. That puts
  // plenty of them across a line boundary, which is where the old page flipped.
  for (let i = 0; i < 100; i++) {
    page.advance(600);
    const truth = start + 800 + (page.now() - t0);
    page.apply(stateAt(page, truth + noise(450)));
  }
  const seen = page.currents.map((t) => Number(t.replace('line ', '')));
  for (let i = 1; i < seen.length; i++) {
    assert.equal(seen[i], seen[i - 1] + 1, `line ${seen[i]} after line ${seen[i - 1]}: no repeats, no steps back`);
  }
  assert.ok(seen.length >= 18, `the lines did keep coming (${seen.length})`);
  assert.equal(page.counts.rowsAdded - rowsBefore, seen.length, 'one new row for each new line, and no more');
  assert.equal(page.counts.animate['seek-rail'], barAnimations, 'the progress bar was never re-seated');
  assert.equal(page.counts.textWrites.title, titleWrites, 'the song title was left alone');
  assert.equal(page.counts.textWrites['t-total'], totalWrites);
  assert.equal(page.elements['seek-rail'].anims.length, 1, 'one animation carries the bar');
});

test('the clock label never runs backwards for a correction', () => {
  const page = boot();
  page.apply(stateAt(page, 60000));
  const noise = noiseSource(3);
  let last = -1;
  const t0 = page.now();
  for (let i = 0; i < 200; i++) {
    page.advance(137);
    if (i % 4 === 0) page.apply(stateAt(page, 60000 + (page.now() - t0) + noise(600)));
    const [m, s] = page.elements['t-cur'].textContent.split(':').map(Number);
    const shown = m * 60 + s;
    assert.ok(shown >= last, `${shown} after ${last}`);
    last = shown;
  }
});

test('a real seek does move everything, once', () => {
  const page = boot();
  page.apply(stateAt(page, 10000));
  page.advance(500);
  const bar = page.counts.animate['seek-rail'];
  page.currents.length = 0;
  page.apply(stateAt(page, 80000));
  assert.equal(page.counts.animate['seek-rail'], bar + 1);
  assert.equal(page.currents.length, 1);
  const expected = LINES.filter((l) => l.t - 700 <= 80000).length - 1;
  assert.equal(page.curRow().textContent, 'line ' + expected);
  // A seek backwards goes straight there too, without the small-correction hold.
  page.apply(stateAt(page, 74000));
  assert.equal(page.curRow().textContent, 'line ' + (LINES.filter((l) => l.t - 700 <= 74000).length - 1));
});

test('a click on the bar goes there now, however near, and tells main', () => {
  const page = boot();
  page.apply(stateAt(page, 60000));
  page.advance(500);
  const bar = page.counts.animate['seek-rail'];
  const seek = page.elements.seek;
  // A click a hair's width from where the song is: under the drift tolerance.
  seek.listeners.click({ clientX: (60500 / 180000) * 150 + 0.1 });
  assert.equal(page.counts.animate['seek-rail'], bar + 1);
  assert.equal(page.actions.at(-1)[0], 'seek');
});

test('a quick lyrics lookup never flashes "Finding lyrics…"', () => {
  const page = boot();
  page.apply(stateAt(page, 10000));
  page.advance(500);
  const other = Object.assign({}, TRACK, { id: 'b', name: 'Other' });
  page.apply(stateAt(page, 0, { track: other, lyrics: { status: 'loading', synced: false, lines: [] } }));
  page.advance(300);
  assert.equal(page.curRow().textContent, '', 'nothing yet');
  page.apply(stateAt(page, 300, { track: other }));
  page.advance(2000);
  assert.ok(!page.currents.includes('Finding lyrics…'));

  const third = Object.assign({}, TRACK, { id: 'c', name: 'Third' });
  page.apply(stateAt(page, 0, { track: third, lyrics: { status: 'loading', synced: false, lines: [] } }));
  page.advance(300);
  assert.ok(!page.currents.includes('Finding lyrics…'));
  page.advance(500);
  assert.equal(page.curRow().textContent, 'Finding lyrics…', 'a slow one says so, after a beat');
});

test('a paused or hidden card schedules nothing', () => {
  const page = boot();
  page.apply(stateAt(page, 10000));
  page.advance(2000);
  assert.ok(page.pendingTimers() > 0, 'playing: the next second or line');
  page.apply(stateAt(page, 12000, { playing: false }));
  page.advance(3000);
  assert.equal(page.pendingTimers(), 0, 'paused: no timers, ramps or retiring rows left over');
  const disk = page.elements.disk.anims[0];
  assert.equal(disk.playState, 'paused', 'the disc stopped, so the compositor has nothing to do');
  const bar = page.elements['seek-rail'].anims;
  assert.ok(bar.every((a) => a.options.duration < 500), 'and the bar has no song-long animation left');

  const hidden = boot();
  hidden.apply(stateAt(hidden, 10000));
  hidden.advance(1000);
  hidden.apply(stateAt(hidden, 11000, { presence: 'out' }));
  assert.equal(hidden.elements.disk.anims[0].playState, 'running', 'still turning while the exit plays');
  hidden.advance(3000);
  assert.equal(hidden.pendingTimers(), 0, 'hidden: nothing either');
  // This window is never throttled, so anything left running would run for as
  // long as the card stayed hidden.
  assert.equal(hidden.elements.disk.anims[0].playState, 'paused', 'the disc is stopped outright');
  assert.equal(hidden.elements['seek-rail'].anims.length, 0, 'and so is the bar');

  // News while hidden (a dismissed card still hears about the next song) starts nothing.
  const other = Object.assign({}, TRACK, { id: 'b', name: 'Other' });
  hidden.apply(stateAt(hidden, 0, { presence: 'out', track: other }));
  hidden.apply(stateAt(hidden, 500, { presence: 'out', track: other, playing: false }));
  hidden.apply(stateAt(hidden, 500, { presence: 'out', track: other, playing: true }));
  hidden.advance(3000);
  assert.equal(hidden.elements.disk.anims[0].playState, 'paused');
  assert.equal(hidden.elements['seek-rail'].anims.length, 0);
  assert.equal(hidden.pendingTimers(), 0);
  assert.equal(hidden.frames(), 0, 'not even a ramp');

  // Arriving seats it all again.
  hidden.apply(stateAt(hidden, 4000, { track: other }));
  assert.equal(hidden.elements.disk.anims[0].playState, 'running');
  assert.equal(hidden.elements.disk.anims[0].playbackRate, 1);
  assert.equal(hidden.elements['seek-rail'].anims.length, 1);
  assert.ok(hidden.pendingTimers() > 0);
});

test('a song going away leaves with the card, still showing', () => {
  const page = boot();
  page.apply(stateAt(page, 10000));
  page.advance(1500);
  const titleWrites = page.counts.textWrites.title;
  const rows = page.counts.rowsAdded;
  const bar = page.counts.animate['seek-rail'];
  const line = page.curRow().textContent;
  // Spotify stops: main says so, then takes the card off screen.
  const nothing = { track: null, playing: false, progressMs: 0, lyrics: { status: 'none', synced: false, lines: [] } };
  page.apply(stateAt(page, 0, nothing));
  page.apply(stateAt(page, 0, Object.assign({ presence: 'out' }, nothing)));
  page.advance(150);
  assert.equal(page.elements.title.textContent, 'Song', 'no "Nothing playing" flashing by as it fades');
  assert.equal(page.counts.textWrites.title, titleWrites);
  assert.equal(page.counts.animate.title, undefined);
  assert.equal(page.elements['cover-tile'].attrs.src, TRACK.image, 'the cover stays');
  assert.equal(page.curRow().textContent, line, 'and so does the lyric line');
  assert.equal(page.counts.rowsAdded, rows);
  assert.equal(page.counts.animate['seek-rail'], bar, 'the bar is not sent back to the start');
  assert.ok(!page.body.classList.contains('is-in'), 'but it is leaving');
  assert.equal(page.counts.animate.card, 2);

  // The next song arrives with the card, already in place.
  page.advance(5000);
  const other = Object.assign({}, TRACK, { id: 'b', name: 'Other' });
  page.apply(stateAt(page, 2000, { track: other }));
  assert.equal(page.elements.title.textContent, 'Other');
  assert.equal(page.counts.animate.title, undefined, 'nothing slides in under the entrance');
});

test('the disc winds up and coasts down instead of snapping', () => {
  const page = boot();
  page.apply(stateAt(page, 10000));
  page.advance(100);
  const a = page.elements.disk.anims[0];
  assert.equal(a.playState, 'running');
  assert.equal(a.playbackRate, 1, 'arriving: already at speed');
  page.apply(stateAt(page, 10100, { playing: false }));
  assert.equal(a.playState, 'running', 'still turning');
  page.advance(300);
  assert.ok(a.playbackRate > 0 && a.playbackRate < 1, `slowing (${a.playbackRate})`);
  page.advance(1200);
  assert.equal(a.playState, 'paused');
  assert.equal(a.playbackRate, 0);
  page.apply(stateAt(page, 10100, { playing: true }));
  page.advance(200);
  assert.ok(a.playbackRate > 0 && a.playbackRate < 1, `picking up (${a.playbackRate})`);
  page.advance(800);
  assert.equal(a.playbackRate, 1);
});

test('only the visible look spins', () => {
  const page = boot();
  page.apply(stateAt(page, 10000, { prefs: Object.assign({}, PREFS, { style: 'white' }) }));
  page.advance(100);
  assert.equal(page.elements.disk.anims.length, 0, 'the glass disc is not even running');
  assert.equal(page.elements.vinyl.anims[0].playState, 'running');
  page.apply(stateAt(page, 10100));
  assert.equal(page.elements.vinyl.anims[0].playState, 'paused', 'a look change hands over');
  assert.equal(page.elements.disk.anims[0].playState, 'running');
});

test('coming and going is the page\'s to play, and it never resizes the window', () => {
  const page = boot();
  page.apply(stateAt(page, 10000, { presence: 'out' }));
  assert.ok(!page.body.classList.contains('is-in'), 'invisible until main says so');
  assert.equal(page.counts.animate.card, undefined);
  const heights = page.counts.heights.length;
  assert.equal(heights, 1, 'it still reports its size, so main can place the window');

  page.apply(stateAt(page, 10000));
  assert.ok(page.body.classList.contains('is-in'));
  assert.equal(page.counts.animate.card, 1);
  const rows = page.counts.rowsAdded;
  page.apply(stateAt(page, 10000, { presence: 'out' }));
  assert.ok(!page.body.classList.contains('is-in'));
  assert.equal(page.counts.animate.card, 2, 'the exit');
  assert.equal(page.elements.card.anims[0].options.fill, 'forwards', 'and it stays gone until the next entrance');
  page.apply(stateAt(page, 10000));
  assert.equal(page.elements.card.anims.length, 1, 'the entrance replaced it');
  assert.equal(page.counts.rowsAdded, rows + 2, 'arriving lays the rows down fresh');
  assert.equal(page.counts.heights.length, heights, 'no size report from any of that');
});

test('a new song while hidden just shows, without playing motion to nobody', () => {
  const page = boot();
  page.apply(stateAt(page, 10000, { presence: 'out' }));
  const other = Object.assign({}, TRACK, { id: 'b', name: 'Other' });
  page.apply(stateAt(page, 0, { presence: 'out', track: other }));
  assert.equal(page.elements.title.textContent, 'Other', 'immediately');
  assert.equal(page.counts.animate.title, undefined);
  assert.equal(page.elements['cover-tile'].attrs.src, other.image, 'and the cover too');
});

test('reduced motion: nothing animates, and the bar still moves', () => {
  const page = boot({ reducedMotion: true });
  page.apply(stateAt(page, 10000));
  page.advance(10000);
  const other = Object.assign({}, TRACK, { id: 'b', name: 'Other' });
  page.apply(stateAt(page, 30000, { track: other }));
  page.advance(1000);
  page.apply(stateAt(page, 90000, { track: other }));
  page.advance(1000);
  assert.deepEqual({ ...page.counts.animate }, {}, 'no element was ever animated');
  assert.equal(page.frames(), 0, 'no ramps either');
  assert.notEqual(page.elements['seek-rail'].style.transform, 'translateX(150px)', 'the bar did not jump to the end of the song');
  const before = page.elements['seek-rail'].style.transform;
  page.advance(9000);
  assert.notEqual(page.elements['seek-rail'].style.transform, before, 'a tick carries it instead');
  assert.equal(page.elements['title'].textContent, 'Other');
});

test('the rest dots only count when there is time to count', () => {
  const page = boot();
  const lines = [{ t: 5000, text: 'one' }, { t: 8000, text: '' }, { t: 8600, text: 'two' }, { t: 12000, text: '' }];
  const lyrics = { status: 'ready', synced: true, lines };
  page.apply(stateAt(page, 1000, { lyrics }));
  const intro = page.curRow().children[0];
  assert.ok(intro && intro.classList.contains('dots'), 'the intro shows dots, not text');
  assert.ok(intro.classList.contains('is-filling'));
  assert.equal(page.nextRow().textContent, 'one', 'with the first line waiting beneath');
  // A gap too short to count down, and an empty last line with nothing after it.
  page.apply(stateAt(page, 7400, { lyrics }));
  assert.ok(!page.curRow().children[0].classList.contains('is-filling'));
  page.apply(stateAt(page, 20000, { lyrics }));
  assert.ok(!page.curRow().children[0].classList.contains('is-filling'));
});

// ── The page's CSS and script: properties that would cost on every frame ─────

const css = stripComments(html.slice(html.indexOf('<style>'), html.indexOf('</style>')));
const code = stripComments(windowSrc);
const ruleOf = (selector) => {
  const i = css.indexOf(selector + ' {');
  assert.notEqual(i, -1, selector);
  return css.slice(i, css.indexOf('}', i));
};

test('lyric rows only ever animate transform and opacity', () => {
  const props = [...ruleOf('.lline').match(/transition:\s*([^;]+);/)[1].matchAll(/(?:^|,)\s*([a-z-]+)\s/g)].map((m) => m[1]);
  assert.deepEqual(props.sort(), ['opacity', 'transform']);
  assert.match(ruleOf('.style-glass .lline::before'), /transition: opacity /, 'the glow fades, it never repaints');
  assert.doesNotMatch(css, /filter\s*:/, 'no blur: it repaints every frame, on the part that made lines blink');
});

test('the progress bar moves by transform, never by layout', () => {
  assert.doesNotMatch(code, /\.style\.(width|left)\b/);
  assert.doesNotMatch(css, /transition:[^;]*\b(width|left)\b/);
  assert.match(code, /els\.rail\.style\.transform = /);
  assert.match(code, /els\.fill\.style\.transform = /);
});

test('the current line glows exactly like the launcher\'s own lyric line', () => {
  const mainCss = stripComments(fs.readFileSync(path.join(ROOT, 'styles', 'main.css'), 'utf8'));
  const launcher = mainCss.match(/\.lyrics-slot-current \{\s*text-shadow:\s*([^;]+);/)[1].trim();
  const corner = ruleOf('.style-glass .lline::before').match(/text-shadow:\s*([^;]+);/)[1].trim();
  assert.equal(corner, launcher);
  assert.match(ruleOf('.lline.is-next'), /opacity: 0\.32/, 'and the line after it is as faint as the launcher\'s');
});

test('the glow is never sliced off at the edge of its own box', () => {
  const room = Number(ruleOf('.lline').match(/--glow-room:\s*(\d+)px/)[1]);
  const shadow = ruleOf('.style-glass .lline::before').match(/text-shadow:\s*([^;]+);/)[1];
  const blurs = [...shadow.matchAll(/0 0 (\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(blurs.length >= 1);
  assert.ok(room >= Math.max(...blurs), `room ${room}px must cover a ${Math.max(...blurs)}px glow`);
  assert.match(ruleOf('.lline'), /padding: var\(--glow-room\)/);
  assert.match(ruleOf('.lline'), /top: calc\(var\(--glow-room\) \* -1\)/, 'and the text stays where it belongs');
  assert.match(ruleOf('.style-glass .lline::before'), /padding: inherit/, 'the glow lines up with the text');
});

test('a row\'s box is wide enough for the longest line the fit allows', () => {
  const E = require(path.join(ROOT, 'renderer', 'mini-player-engine.js'));
  const toolsLeft = E.CARD_WIDTH - 2 /* borders */ - 8 - 22 - 5 - 22;
  const right = toolsLeft - 4;
  assert.ok(Number(ruleOf('.lline').match(/--line-w:\s*(\d+)px/)[1]) >= (right - 10) / E.MIN_LINE_SCALE);
  assert.ok(Number(ruleOf('.style-white .lline').match(/--line-w:\s*(\d+)px/)[1]) >= (right - 14) / E.MIN_LINE_SCALE);
  assert.match(css, /\.lline\.is-next \{[^}]*scale\(0\.8\)/, 'the next row is exactly MIN_LINE_SCALE, so a line keeps its length going up');
  assert.equal(E.MIN_LINE_SCALE, 0.8);
});

test('reduced motion reaches the pseudo-elements too', () => {
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
});

test('play and pause are one shape folding, with matching paths', () => {
  const paths = [...css.matchAll(/d: path\('([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(paths.length, 4);
  const shape = (p) => p.replace(/[\d.]+/g, '#');
  assert.equal(shape(paths[0]), shape(paths[2]), 'a browser only interpolates paths with the same commands');
  assert.equal(shape(paths[1]), shape(paths[3]));
});
