// A room, driven through a stand-in for the Durable Object state: who hears
// whom, presence, one PC at a time, the phone cap, the size and rate limits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.js';
import { LIMITS, CLOSE } from '../src/rules.js';

function fakeCtx() {
  const sockets = [];
  return {
    acceptWebSocket(ws, tags) { ws.tags = tags; sockets.push(ws); },
    getWebSockets(tag) { return sockets.filter((w) => !w.closed && w.tags.includes(tag)); },
    getTags(ws) { return ws.tags; },
    setWebSocketAutoResponse() {},
  };
}

function socket(name) {
  return {
    name,
    sent: [],
    closed: null,
    send(text) {
      if (this.closed) throw new Error('closed');
      this.sent.push(text);
    },
    close(code, reason) { if (!this.closed) this.closed = { code, reason }; },
    last() { return this.sent[this.sent.length - 1]; },
    json() { return this.sent.map((t) => JSON.parse(t)); },
  };
}

const ENV = '{"t":"e","v":1,"iv":"aaaaaaaaaaaaaaaa","d":"bbbb"}';

function room() {
  return new Room(fakeCtx(), {});
}

test('the PC and the phones hear about each other', () => {
  const r = room();
  const host = socket('host');
  r.accept(host, 'host');
  assert.deepEqual(host.json().at(-1), { t: 'peers', phones: 0 });

  const phone = socket('phone');
  r.accept(phone, 'phone');
  assert.deepEqual(host.json().at(-1), { t: 'peers', phones: 1 }, 'the PC starts streaming');
  assert.deepEqual(phone.json().at(-1), { t: 'host', online: true });

  host.closed = { code: 1000 };
  r.webSocketClose(host, 1000, 'bye');
  assert.deepEqual(phone.json().at(-1), { t: 'host', online: false }, 'the phone shows the PC went away');

  phone.closed = { code: 1001 };
  r.webSocketClose(phone, 1001, '');
});

test('envelopes go PC → every phone, and phone → PC, and nowhere else', () => {
  const r = room();
  const host = socket('host');
  const a = socket('a');
  const b = socket('b');
  r.accept(host, 'host');
  r.accept(a, 'phone');
  r.accept(b, 'phone');
  const before = { host: host.sent.length, a: a.sent.length, b: b.sent.length };

  r.webSocketMessage(host, ENV);
  assert.equal(a.last(), ENV);
  assert.equal(b.last(), ENV);
  assert.equal(host.sent.length, before.host, 'the PC is not echoed');

  r.webSocketMessage(a, ENV);
  assert.equal(host.last(), ENV);
  assert.equal(b.sent.length, before.b + 1, 'phones never hear each other');

  r.webSocketMessage(host, '{"t":"peers","phones":99}');
  r.webSocketMessage(a, 'not json');
  assert.equal(a.sent.length, before.a + 1, 'only sealed envelopes are passed on');
  assert.equal(host.last(), ENV);
});

test('a second PC takes the room over', () => {
  const r = room();
  const first = socket('first');
  const second = socket('second');
  r.accept(first, 'host');
  r.accept(second, 'host');
  assert.equal(first.closed.code, CLOSE.replaced);
  assert.equal(second.closed, null);
});

test('a room holds four phones, and turns the fifth away', () => {
  const r = room();
  const phones = Array.from({ length: LIMITS.maxPhones + 1 }, (_, i) => socket(`p${i}`));
  phones.forEach((p) => r.accept(p, 'phone'));
  assert.equal(phones.at(-1).closed.code, CLOSE.roomFull);
  assert.ok(phones.slice(0, -1).every((p) => p.closed === null));
  const host = socket('host');
  r.accept(host, 'host');
  assert.deepEqual(host.json().at(-1), { t: 'peers', phones: LIMITS.maxPhones }, 'the turned-away phone is not counted');
});

test('oversized messages and floods close the socket', () => {
  const r = room();
  const host = socket('host');
  const phone = socket('phone');
  r.accept(host, 'host');
  r.accept(phone, 'phone');

  r.webSocketMessage(phone, 'x'.repeat(LIMITS.maxMessageBytes + 1));
  assert.equal(phone.closed.code, CLOSE.tooBig);

  const noisy = socket('noisy');
  r.accept(noisy, 'phone');
  for (let i = 0; i < LIMITS.burst + 5 && !noisy.closed; i++) r.webSocketMessage(noisy, ENV);
  assert.equal(noisy.closed.code, CLOSE.rateLimited);
});
