'use strict';

// The corner player's pure rules (renderer/mini-player-engine.js): where the
// window sits, when it shows, and which lyric line is current. Shared by the
// window's page and main/miniPlayer.js, so a mistake here shows up in both.

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const E = require(path.join(__dirname, '..', 'renderer', 'mini-player-engine.js'));

const AREA = { x: 0, y: 0, width: 1920, height: 1040 }; // a 1080p screen minus a 40px taskbar

test('prefs default to a quiet, safe state and reject junk', () => {
  const d = E.sanitizePrefs(null);
  assert.deepEqual(d, {
    enabled: false, lyrics: true, style: 'glass', showWhen: 'hidden', corner: 'bottom-right',
    displayId: null, accent: '#ffffff', anticipateMs: 700
  });
  const junk = E.sanitizePrefs({
    enabled: 'yes', lyrics: 0, style: 'neon', showWhen: 'sometimes', corner: 'middle',
    displayId: 'two', accent: 'red', anticipateMs: 99999
  });
  assert.equal(junk.enabled, false, 'only a real true enables it');
  assert.equal(junk.lyrics, true, 'only an explicit false hides the lyric line');
  assert.equal(junk.style, 'glass');
  assert.equal(junk.showWhen, 'hidden');
  assert.equal(junk.corner, 'bottom-right');
  assert.equal(junk.displayId, null);
  assert.equal(junk.accent, '#ffffff');
  assert.equal(junk.anticipateMs, E.MAX_ANTICIPATE_MS);
});

test('accent colours are normalised, including the short #fff form CSS hands over', () => {
  assert.equal(E.sanitizePrefs({ accent: '#FFF' }).accent, '#ffffff');
  assert.equal(E.sanitizePrefs({ accent: ' #7DD3FC ' }).accent, '#7dd3fc');
  assert.deepEqual(E.hexToRgb('#7dd3fc'), [125, 211, 252]);
  assert.deepEqual(E.hexToRgb('not a colour'), [255, 255, 255]);
});

test('the window wraps the card with room for its shadow, within sane heights', () => {
  assert.deepEqual(E.windowSize(70), { width: E.CARD_WIDTH + E.PAD * 2, height: 70 + E.PAD * 2 });
  assert.equal(E.windowSize(5).height, 40 + E.PAD * 2, 'never collapses');
  assert.equal(E.windowSize(5000).height, 400 + E.PAD * 2, 'never covers the screen');
  assert.equal(E.windowSize(NaN).height, 72 + E.PAD * 2);
});

test('every corner keeps the whole window inside the work area', () => {
  const size = E.windowSize(116);
  for (const corner of E.CORNERS) {
    const p = E.cornerPosition(AREA, size, corner);
    assert.ok(p.x >= AREA.x && p.y >= AREA.y, `${corner}: not off the top/left`);
    assert.ok(p.x + size.width <= AREA.x + AREA.width, `${corner}: not off the right`);
    assert.ok(p.y + size.height <= AREA.y + AREA.height, `${corner}: never over the taskbar`);
  }
  const br = E.cornerPosition(AREA, size, 'bottom-right');
  assert.equal(br.x + size.width + E.EDGE, AREA.width, 'tucked right into the corner');
  assert.equal(br.y + size.height + E.EDGE, AREA.height);
  // A second screen to the left, with a negative origin.
  const left = { x: -1280, y: 0, width: 1280, height: 984 };
  const tl = E.cornerPosition(left, size, 'top-left');
  assert.deepEqual(tl, { x: -1280 + E.EDGE, y: E.EDGE });
});

test('a dragged window snaps to the corner nearest its centre', () => {
  const w = 376, h = 156;
  assert.equal(E.nearestCorner({ x: 10, y: 10, width: w, height: h }, AREA), 'top-left');
  assert.equal(E.nearestCorner({ x: 1500, y: 20, width: w, height: h }, AREA), 'top-right');
  assert.equal(E.nearestCorner({ x: 40, y: 800, width: w, height: h }, AREA), 'bottom-left');
  assert.equal(E.nearestCorner({ x: 1400, y: 820, width: w, height: h }, AREA), 'bottom-right');
});

test('playback position runs on from the last sample, only while playing, and stops at the end', () => {
  const sample = { playing: true, progressMs: 60000, at: 1000, track: { durationMs: 200000 } };
  assert.equal(E.positionAt(sample, 6000), 65000);
  assert.equal(E.positionAt(Object.assign({}, sample, { playing: false }), 6000), 60000, 'paused stays put');
  assert.equal(E.positionAt(sample, 1000 + 500000), 200000, 'never past the end');
  assert.equal(E.positionAt(Object.assign({}, sample, { track: null }), 6000), 0);
});

test('the current lyric line uses the same lead as the launcher', () => {
  const lines = [{ t: 9400, text: 'one' }, { t: 16800, text: 'two' }, { t: 24100, text: 'three' }];
  assert.equal(E.lineIndex(lines, 5000, 700), -1, 'before the first line');
  assert.equal(E.lineIndex(lines, 8700, 700), 0, 'surfaces 700ms early');
  assert.equal(E.lineIndex(lines, 8699, 700), -1);
  assert.equal(E.lineIndex(lines, 16100, 700), 1);
  assert.equal(E.lineIndex(lines, 999999, 700), 2);
  assert.equal(E.lineIndex(lines, 9400, 0), 0, 'a zero lead is honoured');
  assert.equal(E.lineIndex([{ t: null, text: 'plain' }], 50000, 700), -1, 'unsynced lyrics have no current line');
  assert.equal(E.lineIndex([], 1000, 700), -1);
});

test('a poll corrects the clock instead of replacing it', () => {
  const track = { id: 'a', durationMs: 200000 };
  const first = E.followClock(null, { track, playing: true, progressMs: 60000, at: 1000 }, 1000);
  assert.equal(first.jump, 'track', 'the first sample is adopted');
  assert.equal(E.positionAt(first.clock, 3500), 62500);

  // Spotify's answer is 400ms behind where the clock already is: that's noise.
  const noisy = E.followClock(first.clock, { track, playing: true, progressMs: 62100, at: 3500 }, 3500);
  assert.equal(noisy.jump, null, 'nothing to show for it');
  assert.equal(E.positionAt(noisy.clock, 3500), 62500 - 400 * E.DRIFT_NUDGE, 'but some of it is corrected');

  // A real offset still melts away over a few polls.
  let clock = first.clock;
  for (let at = 3500; at < 26000; at += 2500) {
    clock = E.followClock(clock, { track, playing: true, progressMs: 60000 + (at - 1000) + 900, at }, at).clock;
  }
  const off = E.positionAt(clock, 26000) - (60000 + 25000 + 900);
  assert.ok(Math.abs(off) < 40, `converged to within ${off}ms`);

  const seek = E.followClock(first.clock, { track, playing: true, progressMs: 120000, at: 3500 }, 3500);
  assert.equal(seek.jump, 'seek', 'somebody really moved the song');
  assert.equal(E.positionAt(seek.clock, 3500), 120000);
  const back = E.followClock(first.clock, { track, playing: true, progressMs: 61000 - E.DRIFT_JUMP_MS, at: 3500 }, 3500);
  assert.equal(back.jump, 'seek', 'backwards counts too');

  const pause = E.followClock(first.clock, { track, playing: false, progressMs: 62400, at: 3500 }, 3500);
  assert.equal(pause.jump, 'state');
  assert.equal(E.positionAt(pause.clock, 9000), 62400, 'a paused clock stands still');
  const still = E.followClock(pause.clock, { track, playing: false, progressMs: 62300, at: 9000 }, 9000);
  assert.equal(still.jump, null);
  assert.equal(E.positionAt(still.clock, 9000), 62400);

  const next = E.followClock(first.clock, { track: { id: 'b', durationMs: 1000 }, playing: true, progressMs: 0, at: 3500 }, 3500);
  assert.equal(next.jump, 'track');
  const gone = E.followClock(first.clock, { track: null, playing: false, progressMs: 0, at: 3500 }, 3500);
  assert.equal(gone.jump, 'track');
  assert.equal(E.positionAt(gone.clock, 3500), 0);
});

test('a line on screen does not drop back for a small correction', () => {
  const lines = [{ t: 9400, text: 'one' }, { t: 16800, text: 'two' }, { t: 24100, text: 'three' }];
  assert.equal(E.settledLine(lines, 16200, 700, 1), 1, 'on time');
  assert.equal(E.settledLine(lines, 16000, 700, 1), 1, 'pulled back 100ms under the line: stays');
  assert.equal(E.settledLine(lines, 16100 - E.DRIFT_JUMP_MS + 1, 700, 1), 1, 'still inside the noise');
  assert.equal(E.settledLine(lines, 16100 - E.DRIFT_JUMP_MS, 700, 1), 0, 'really behind: goes back');
  assert.equal(E.settledLine(lines, 16000, 700, null), 0, 'a jump passes no line on screen');
  assert.equal(E.settledLine(lines, 16000, 700, 'loading'), 0, 'nor does a status message');
  assert.equal(E.settledLine(lines, 24000, 700, 1), 2, 'moving forward is never held');
  assert.equal(E.settledLine(lines, 16000, 700, 7), 0, 'a line that does not exist holds nothing');
  // Two quick lines: a correction across both still holds.
  const quick = [{ t: 1000, text: 'a' }, { t: 1300, text: 'b' }, { t: 1600, text: 'c' }];
  assert.equal(E.settledLine(quick, 500, 700, 2), 2);
});

test('a long lyric line shrinks to fit, then gets out of the way of the corner buttons', () => {
  const centred = { left: 10, right: 273, centre: 167, align: 'centre' };
  assert.deepEqual(E.lyricFit(100, centred), { scale: 1, shift: 0 }, 'short: untouched');
  assert.deepEqual(E.lyricFit(212, centred), { scale: 1, shift: 0 }, 'just clear of the buttons when centred');
  assert.deepEqual(E.lyricFit(240, centred), { scale: 1, shift: -14 }, 'wider: slides left, full size');
  const long = E.lyricFit(300, centred);
  assert.ok(long.scale < 1 && long.scale > E.MIN_LINE_SCALE);
  assert.equal(long.shift, Math.round(10 + 263 / 2 - 167), 'fills the whole free span');
  const huge = E.lyricFit(2000, centred);
  assert.equal(huge.scale, E.MIN_LINE_SCALE, 'never smaller than the next-line row');
  assert.equal(huge.shift, long.shift);
  assert.deepEqual(E.lyricFit(0, centred), { scale: 1, shift: 0 });
  assert.deepEqual(E.lyricFit(NaN, centred), { scale: 1, shift: 0 });

  const left = { left: 14, right: 273, centre: 14, align: 'left' };
  assert.deepEqual(E.lyricFit(100, left), { scale: 1, shift: 0 });
  const leftLong = E.lyricFit(300, left);
  assert.ok(leftLong.scale < 1);
  assert.equal(leftLong.shift, 0, 'a left-aligned line keeps its left edge');
});

test('the rest dots count down the gap to the next line', () => {
  const lines = [{ t: 5000, text: 'one' }, { t: 9000, text: '' }, { t: 17700, text: 'two' }];
  assert.deepEqual(E.restSpan(lines, -1, 1000, 700), { durationMs: 4300, elapsedMs: 1000 }, 'the intro');
  assert.deepEqual(E.restSpan(lines, 1, 10300, 700), { durationMs: 8700, elapsedMs: 2000 }, 'a gap in the song');
  assert.equal(E.restSpan(lines, 2, 20000, 700), null, 'nothing follows the last line');
  assert.equal(E.restSpan([], -1, 0, 700), null);
  assert.equal(E.restSpan([{ t: null, text: 'plain' }], -1, 0, 700), null, 'untimed lyrics');
  assert.deepEqual(E.restSpan(lines, -1, 90000, 700), { durationMs: 4300, elapsedMs: 4300 }, 'capped');
});

test('polling follows the song: quick at its end, slow when nothing is happening', () => {
  const track = { id: 'a', durationMs: 180000 };
  const s = (over) => Object.assign({ connected: true, playing: true, progressMs: 60000, at: 1000, track }, over);
  assert.equal(E.pollDelay(s(), 1000), E.POLL_PLAYING_MS);
  assert.equal(E.pollDelay(s({ playing: false }), 1000), E.POLL_IDLE_MS);
  assert.equal(E.pollDelay(s({ connected: false }), 1000), E.POLL_OFFLINE_MS);
  assert.equal(E.pollDelay(null, 1000), E.POLL_OFFLINE_MS);
  assert.equal(E.pollDelay(s({ progressMs: 179000 }), 1000), 1150, 'right after the song ends');
  assert.equal(E.pollDelay(s({ progressMs: 179900 }), 1000), E.POLL_EDGE_MIN_MS, 'never hammering');
  assert.equal(E.pollDelay(s({ progressMs: 180000 }), 90000), E.POLL_EDGE_MIN_MS);
  assert.equal(E.pollDelay(s({ track: { id: 'b', durationMs: 0 } }), 1000), E.POLL_PLAYING_MS, 'no duration, no rush');
});

test('the window eases into its corner and lands exactly', () => {
  const from = { x: 100, y: 200, width: 376, height: 160 };
  const to = { x: 1000, y: 800, width: 376, height: 163 };
  assert.deepEqual(E.snapStep(from, to, 0), { x: 100, y: 200, width: 376, height: 163 });
  assert.deepEqual(E.snapStep(from, to, 1), to);
  assert.deepEqual(E.snapStep(from, to, 3), to, 'a late tick still lands');
  const half = E.snapStep(from, to, 0.5);
  assert.ok(half.x > 550 && half.x < 1000, 'most of the way by halfway');
});

test('it shows only when it should', () => {
  const base = { enabled: true, hasTrack: true, showWhen: 'hidden', mainVisible: false, immersive: false, dismissedKey: null, trackKey: 'a' };
  assert.equal(E.shouldShow(base), true);
  assert.equal(E.shouldShow(Object.assign({}, base, { enabled: false })), false, 'widget off');
  assert.equal(E.shouldShow(Object.assign({}, base, { hasTrack: false })), false, 'nothing playing');
  assert.equal(E.shouldShow(Object.assign({}, base, { mainVisible: true })), false, 'Main is open: it has its own player');
  assert.equal(E.shouldShow(Object.assign({}, base, { mainVisible: true, showWhen: 'always' })), true, 'unless told always');
  assert.equal(E.shouldShow(Object.assign({}, base, { immersive: true, showWhen: 'always' })), false, 'never over the full-screen stage');
  assert.equal(E.shouldShow(Object.assign({}, base, { dismissedKey: 'a' })), false, 'hidden until the next song');
  assert.equal(E.shouldShow(Object.assign({}, base, { dismissedKey: 'b' })), true, 'and back for the next one');
});

test('tracks without a Spotify id still get a stable identity', () => {
  assert.equal(E.trackKey({ id: '4uLU6hMCjMI75M1A2tKUQC' }), '4uLU6hMCjMI75M1A2tKUQC');
  const local = { id: '', name: 'Demo', artist: 'Me', durationMs: 1000 };
  assert.equal(E.trackKey(local), E.trackKey(Object.assign({}, local)));
  assert.notEqual(E.trackKey(local), E.trackKey(Object.assign({}, local, { name: 'Other' })));
  assert.equal(E.trackKey(null), null);
});

test('times read like the launcher', () => {
  assert.equal(E.formatTime(0), '0:00');
  assert.equal(E.formatTime(61999), '1:01');
  assert.equal(E.formatTime(221000), '3:41');
  assert.equal(E.formatTime(-5), '0:00');
});
