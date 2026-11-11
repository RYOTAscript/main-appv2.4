'use strict';

// The PC's half of a Phone Remote session, driven the way the relay drives it,
// with a phone on the other end that holds only the pairing secret. Covers what
// matters when the other side is on the internet: nothing is sent unless a
// phone is watching, commands are only acted on when they really come from a
// paired phone (right key, right direction, fresh, never twice, not a flood),
// and the phone sees each command's result straight away, even while Spotify's
// own state is a few seconds behind.

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require(path.join(__dirname, '..', 'renderer', 'remote-protocol.js'));
const { RemoteHost, HOLD_MS, COMMANDS_PER_SECOND, POLL_PLAYING_MS } = require(path.join(__dirname, '..', 'main', 'phoneRemoteHost.js'));

const TRACK = {
  id: 'abc123', name: 'Concrete Halo', artist: 'Juno Vale', album: 'Night Shift Diaries',
  image: 'https://i.scdn.co/image/abc', duration_ms: 221000, progress_ms: 30000,
};

function fakeSpotify(overrides = {}) {
  const calls = [];
  const state = { playing: true, track: { ...TRACK }, volume: 60, shuffle: false, repeat: 'off' };
  return {
    calls,
    state,
    isConnected: () => true,
    async getCurrentTrack() {
      return {
        connected: true, is_playing: state.playing, track: state.track ? { ...state.track } : null,
        volume_percent: state.volume, shuffle_state: state.shuffle, repeat_state: state.repeat, device: 'Desk',
      };
    },
    async control(action) { calls.push(['control', action]); return { success: true }; },
    async seek(ms) { calls.push(['seek', ms]); return { success: true }; },
    async setVolume(v) { calls.push(['volume', v]); return { success: true }; },
    async isSaved(id) { calls.push(['isSaved', id]); return { ok: true, saved: false }; },
    async setSaved(id, v) { calls.push(['setSaved', id, v]); return { ok: true, saved: v }; },
    async getQueue() { calls.push(['queue']); return { ok: true, queue: [{ name: 'Gold Hours', artist: 'Mara Lune', image: 'https://i.scdn.co/image/q', duration_ms: 192000 }] }; },
    ...overrides,
  };
}

const LYRICS = {
  async getLyrics() {
    return { success: true, synced: true, lyrics: [{ time: 0, text: '' }, { time: 9400, text: 'City breathing slow' }] };
  },
};

async function session(opts = {}) {
  const secret = P.newSecret();
  const key = await P.deriveKey(secret);
  const sent = [];
  let clock = opts.now || 1_800_000_000_000;
  const spotify = opts.spotify || fakeSpotify();
  const host = new RemoteHost({
    protocol: P,
    spotify,
    lyrics: opts.lyrics || LYRICS,
    send: (text) => sent.push(text),
    getSettings: () => ({ look: 'white', lead: 500 }),
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
    logger: { warn() {} },
  });
  await host.setSecret(secret);
  host.onOpen();
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    host, spotify, sent, key, secret, settle,
    tick(ms) { clock += ms; },
    now: () => clock,
    async inbox() {
      const out = [];
      for (const text of sent.splice(0)) out.push(await P.open(key, P.TO_PHONE, text));
      return out;
    },
    async command(action, value, at = clock) {
      const text = await P.seal(key, P.TO_HOST, P.makeCommand(action, value, at));
      await host.onMessage(text);
      return text;
    },
  };
}

test('nothing is polled or sent until a phone is watching', async () => {
  const s = await session();
  await s.host.onMessage('{"t":"peers","phones":0}');
  await s.settle();
  assert.equal(s.sent.length, 0);
  assert.equal(s.host.polling, false);

  await s.host.onMessage('{"t":"peers","phones":1}');
  await s.settle();
  const msgs = await s.inbox();
  const state = msgs.filter((m) => m.k === 'state').at(-1);   // the heart lands in a follow-up
  const lyrics = msgs.filter((m) => m.k === 'lyrics');
  assert.equal(state.track.name, 'Concrete Halo');
  assert.equal(state.look, 'white');
  assert.equal(state.lead, 500);
  assert.equal(state.liked, false, 'the heart is looked up once per song');
  assert.deepEqual(lyrics.map((l) => l.status), ['loading', 'ready']);
  assert.equal(lyrics[1].lines[1].text, 'City breathing slow');

  await s.host.onMessage('{"t":"peers","phones":0}');
  assert.equal(s.host.polling, false, 'the last phone leaving stops the polling');
});

test('the phone can only read what the PC sent it, sealed', async () => {
  const s = await session();
  await s.host.onMessage('{"t":"peers","phones":1}');
  await s.settle();
  for (const text of s.sent) {
    assert.doesNotMatch(text, /Concrete Halo|Juno Vale|i\.scdn\.co/, 'nothing in clear on the wire');
    assert.equal(await P.open(await P.deriveKey(P.newSecret()), P.TO_PHONE, text), null, 'another pairing cannot read it');
  }
});

test('commands do what they say, and the phone sees the result at once', async () => {
  const s = await session();
  await s.host.onMessage('{"t":"peers","phones":1}');
  await s.settle();
  await s.inbox();

  await s.command('toggle');
  let state = (await s.inbox()).find((m) => m.k === 'state');
  assert.deepEqual(s.spotify.calls.at(-1), ['control', 'pause']);
  assert.equal(state.playing, false);

  await s.command('seek', 60000);
  state = (await s.inbox()).find((m) => m.k === 'state');
  assert.deepEqual(s.spotify.calls.at(-1), ['seek', 60000]);
  assert.equal(state.progressMs, 60000);

  await s.command('volume', 35);
  assert.deepEqual(s.spotify.calls.at(-1), ['volume', 35]);
  await s.command('like', true);
  assert.deepEqual(s.spotify.calls.at(-1), ['setSaved', 'abc123', true]);
  await s.command('shuffle', true);
  assert.deepEqual(s.spotify.calls.at(-1), ['control', 'shuffle-on']);
  await s.command('repeat', 'track');
  assert.deepEqual(s.spotify.calls.at(-1), ['control', 'repeat-track']);
  s.tick(1000);
  await s.command('next');
  assert.deepEqual(s.spotify.calls.at(-1), ['control', 'next']);

  const queue = await (async () => { s.sent.length = 0; await s.command('queue'); return (await s.inbox()).find((m) => m.k === 'queue'); })();
  assert.equal(queue.items[0].name, 'Gold Hours');
});

test('a poll Spotify has not caught up with yet does not undo a command', async () => {
  const s = await session();
  await s.host.onMessage('{"t":"peers","phones":1}');
  await s.settle();
  await s.command('toggle');      // pause — but Spotify still reports playing
  await s.inbox();
  s.tick(1000);
  await s.host.poll();
  let state = (await s.inbox()).find((m) => m.k === 'state');
  assert.equal(state.playing, false, 'held for a moment');
  s.tick(HOLD_MS);
  await s.host.poll();
  state = (await s.inbox()).find((m) => m.k === 'state');
  assert.equal(state.playing, true, 'then Spotify is believed again');
});

test('a failed like is put back', async () => {
  const s = await session({ spotify: fakeSpotify({ async setSaved() { return { ok: false }; } }) });
  await s.host.onMessage('{"t":"peers","phones":1}');
  await s.settle();
  await s.inbox();
  await s.command('like', true);
  const states = (await s.inbox()).filter((m) => m.k === 'state');
  assert.deepEqual(states.map((m) => m.liked), [true, false]);
});

test('only fresh commands from a paired phone are acted on, once', async () => {
  const s = await session();
  await s.host.onMessage('{"t":"peers","phones":1}');
  await s.settle();
  const before = () => s.spotify.calls.filter(([k]) => k === 'control').length;

  const text = await s.command('next');
  const once = before();
  await s.host.onMessage(text);
  assert.equal(before(), once, 'a replayed command is dropped');

  const stranger = await P.deriveKey(P.newSecret());
  await s.host.onMessage(await P.seal(stranger, P.TO_HOST, P.makeCommand('next', undefined, s.now())));
  assert.equal(before(), once, 'another pairing is ignored');

  // The PC's own outgoing state, bounced back by the relay, is not a command.
  const echoed = await P.seal(s.key, P.TO_PHONE, P.makeCommand('next', undefined, s.now()));
  await s.host.onMessage(echoed);
  assert.equal(before(), once, 'the wrong direction is ignored');

  await s.command('next', undefined, s.now() - P.LIMITS.replayWindowMs - 1);
  assert.equal(before(), once, 'a stale command is ignored');

  await s.host.onMessage(await P.seal(s.key, P.TO_HOST, { k: 'cmd', a: 'format-disk', ts: s.now(), n: 'abcdefghij' }));
  await s.host.onMessage('not json');
  await s.host.onMessage('{"t":"e","v":1,"iv":"x","d":"y"}');
  assert.equal(before(), once, 'unknown and malformed messages are ignored');
});

test('a flood of commands is cut off', async () => {
  const s = await session();
  await s.host.onMessage('{"t":"peers","phones":1}');
  await s.settle();
  const start = s.spotify.calls.length;
  for (let i = 0; i < COMMANDS_PER_SECOND * 3; i++) await s.command('volume', i);
  const handled = s.spotify.calls.slice(start).filter(([k]) => k === 'volume').length;
  assert.equal(handled, COMMANDS_PER_SECOND);
});

test('a new song resets the heart and fetches its own lyrics', async () => {
  const s = await session();
  await s.host.onMessage('{"t":"peers","phones":1}');
  await s.settle();
  await s.inbox();
  s.spotify.state.track = { ...TRACK, id: 'next456', name: 'Gold Hours' };
  s.tick(POLL_PLAYING_MS);
  await s.host.poll();
  await s.settle();
  const msgs = await s.inbox();
  assert.ok(msgs.some((m) => m.k === 'lyrics' && m.key === 'next456' && m.status === 'ready'));
  assert.equal(msgs.find((m) => m.k === 'state').track.name, 'Gold Hours');
  assert.deepEqual(s.spotify.calls.filter(([k]) => k === 'isSaved').map((c) => c[1]), ['abc123', 'next456']);
});
