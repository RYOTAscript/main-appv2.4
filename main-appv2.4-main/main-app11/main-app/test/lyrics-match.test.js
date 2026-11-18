'use strict';

// How lyrics are chosen and cleaned (main/lyricsMatch.js), and main/lyrics.js
// running against a stubbed lrclib. lrclib often holds the same song twice —
// the explicit release and a "clean" one with the swearing starred out — and
// the first one the old lookup found was the one shown, stars and all.

const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'main', 'lyricsMatch.js'));

test('LRC parsing: repeated lines, odd stamps, offsets, metadata', () => {
  const lrc = [
    '[ar:Someone]',
    '[ti:Song]',
    '[offset:+500]',
    '[00:12.00][00:45.50]Chorus line',
    '[01:02:30]Colon hundredths',
    '[1:05]No fraction, one-digit minutes',
    '[00:03.123]Thousandths',
    '[00:20.00]   ',
    'not a lyric',
  ].join('\n');
  const lines = M.parseLrc(lrc);
  assert.deepEqual(lines.map((l) => l.text), ['Thousandths', 'Chorus line', 'Chorus line', 'Colon hundredths', 'No fraction, one-digit minutes']);
  assert.equal(lines[0].time, 3123 - 500, 'a positive offset brings the lyrics earlier');
  assert.equal(lines[1].time, 12000 - 500);
  assert.equal(lines[2].time, 45500 - 500, 'every stamp on a line becomes a line');
  assert.equal(lines[3].time, 62300 - 500);
  assert.equal(lines[4].time, 65000 - 500);
  assert.deepEqual(M.parseLrc(''), []);
  assert.deepEqual(M.parseLrc(null), []);
});

test('starred-out swearing is put back, and only where the reading is clear', () => {
  assert.equal(M.uncensor('Two in his chest make a f**k n***a holla'), 'Two in his chest make a fuck nigga holla');
  assert.equal(M.uncensor('B*tch, you my son'), 'Bitch, you my son', 'capital kept');
  assert.equal(M.uncensor('SH*T'), 'SHIT', 'shouting kept');
  assert.equal(M.uncensor('s**t got real'), 'shit got real', 'the likelier word wins');
  assert.equal(M.uncensor('motherf***er'), 'motherfucker');
  assert.equal(M.uncensor('f***ing with me'), 'fucking with me');
  assert.equal(M.uncensor('n****s on the block'), 'niggas on the block');
  assert.equal(M.uncensor('kiss my a**'), 'kiss my ass');
  assert.equal(M.uncensor('**** this'), '**** this', 'no letters: nothing to go on');
  assert.equal(M.uncensor('x**yz'), 'x**yz', 'nothing it could be');
  assert.equal(M.uncensor('5 * 3 = 15'), '5 * 3 = 15', 'a lone star in maths is left alone');
  assert.equal(M.uncensor('No swearing here'), 'No swearing here');
  assert.equal(M.countMasked('f**k this sh*t'), 2);
  assert.equal(M.countMasked('clean words'), 0);
});

test("Spotify's title and artist are trimmed to what lrclib calls the song", () => {
  assert.equal(M.cleanTitle('Shotta Flow (feat. Blueface) - Remix'), 'Shotta Flow - Remix', 'a remix is a different song: kept');
  assert.equal(M.cleanTitle('Hey Jude - Remastered 2015'), 'Hey Jude');
  assert.equal(M.cleanTitle('Song - 2011 Remaster'), 'Song');
  assert.equal(M.cleanTitle('Song [Explicit]'), 'Song');
  assert.equal(M.cleanTitle('Song (with Friend)'), 'Song');
  assert.equal(M.cleanTitle('Live Forever - Live'), 'Live Forever - Live', 'a live recording keeps its timing: kept');
  assert.equal(M.primaryArtist('NLE Choppa, Blueface'), 'NLE Choppa');
  assert.equal(M.primaryArtist('Metro Boomin & Future'), 'Metro Boomin');
  assert.equal(M.primaryArtist('Drake feat. Rihanna'), 'Drake');
  assert.equal(M.primaryArtist('Solo'), 'Solo');
});

const want = { title: 'Shotta Flow (feat. Blueface) - Remix', artist: 'NLE Choppa, Blueface', album: 'Shotta Flow', durationSec: 176 };
const entry = (over) => Object.assign({
  id: Math.random(), trackName: 'Shotta Flow - Remix', artistName: 'NLE Choppa', albumName: 'Shotta Flow', duration: 176,
  syncedLyrics: '[00:01.00]real words here', plainLyrics: 'real words here', instrumental: false,
}, over);

test('the uncensored entry beats the clean one, even when the clean one is the exact match', () => {
  const clean = entry({ id: 1, syncedLyrics: '[00:01.00]make a f**k n***a holla' });
  const explicit = entry({ id: 2, artistName: 'NLE Choppa feat. Blueface', duration: 177 });
  assert.equal(M.pickBest([clean, explicit], want).id, 2);
  assert.equal(M.pickBest([clean], want).id, 1, 'but a clean one is still better than nothing (and gets uncensored)');
});

test('the wrong recording is never taken, however well its name matches', () => {
  const cover = entry({ id: 3, duration: 190 });
  assert.equal(M.pickBest([cover], want), null, 'more than 3 s off: a different recording');
  const timed = entry({ id: 4, duration: 178 });
  const untimed = entry({ id: 5, syncedLyrics: null });
  assert.equal(M.pickBest([untimed, timed], want).id, 4, 'timed lyrics win');
  const other = entry({ id: 6, trackName: 'Completely Different', artistName: 'Someone Else' });
  assert.equal(M.pickBest([other, timed], want).id, 4, 'the name still counts');
  assert.equal(M.pickBest([entry({ id: 7, syncedLyrics: null, plainLyrics: null })], want), null, 'nothing to show');
  assert.equal(M.pickBest([], want), null);
});

// main/lyrics.js against a fake lrclib.
function loadLyrics(routes) {
  const calls = [];
  const handlers = new Map();
  const fakeNet = {
    netFetch: async (url) => {
      calls.push(url);
      for (const [match, reply] of routes) {
        if (url.includes(match)) {
          if (reply === 'network') throw new Error('socket hang up');
          if (reply === 404) return { ok: false, status: 404, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => reply };
        }
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
  const fakeElectron = { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) } };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === './netClient') return fakeNet;
    return original.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'main', 'lyrics.js'))];
    const mod = require(path.join(ROOT, 'main', 'lyrics.js'));
    const api = mod.init({ logger: { debug() {}, error() {}, warn() {} }, APP_VERSION: 'test' });
    return { api, calls };
  } finally {
    Module._load = original;
  }
}

test('a clean exact match sends the lookup on to find the explicit one, and the result is uncensored', async () => {
  const clean = entry({ id: 1, syncedLyrics: '[00:01.00]make a f**k n***a holla' });
  const explicit = entry({ id: 2, syncedLyrics: '[00:01.00]make a fuck nigga holla', artistName: 'NLE Choppa feat. Blueface' });
  const { api, calls } = loadLyrics([['/get?', clean], ['/search?', [clean, explicit]]]);
  const r = await api.getLyrics(want.title, want.artist, want.album, 176000);
  assert.equal(r.success, true);
  assert.equal(r.synced, true);
  assert.equal(r.lyrics[0].text, 'make a fuck nigga holla');
  assert.ok(calls.some((u) => u.includes('/search?')), 'searched beyond the exact match');
});

test('only the clean version exists: shown with the words put back', async () => {
  const clean = entry({ id: 1, syncedLyrics: '[00:01.00]shut the f**k up' });
  const { api } = loadLyrics([['/get?', clean], ['/search?', [clean]]]);
  const r = await api.getLyrics(want.title, want.artist, want.album, 176000);
  assert.equal(r.lyrics[0].text, 'shut the fuck up');
});

test('a good exact match is taken straight away', async () => {
  const { api, calls } = loadLyrics([['/get?', entry({ id: 9 })]]);
  const r = await api.getLyrics('Shotta Flow - Remix', 'NLE Choppa', 'Shotta Flow', 176000);
  assert.equal(r.success, true);
  assert.equal(calls.length, 1, 'one request');
});

test("a network failure isn't remembered as 'no lyrics'", async () => {
  const { api, calls } = loadLyrics([['lrclib', 'network']]);
  const first = await api.getLyrics('Song', 'Artist', '', 200000);
  assert.equal(first.success, false);
  assert.equal(first.reason, 'network');
  const really404 = loadLyrics([['lrclib', 404]]);
  const none = await really404.api.getLyrics('Song', 'Artist', '', 200000);
  assert.equal(none.reason, 'lyrics_not_found', 'an answer of "nothing" is a real not-found');
  assert.ok(calls.length >= 1);
});
