// The relay's rules: room paths, the license check (against tokens signed the
// way the website signs them), the envelope filter and the rate limiter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  parseRoomPath, verifyLicenseToken, isEnvelope, TokenBucket, replyCloseCode, LIMITS,
} from '../src/rules.js';

const ROOM = 'A'.repeat(43);
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Exactly website/src/lib/licenseToken.ts: Ed25519 over the ASCII of b64url(payload).
function mint(privateKey, payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(sign(null, Buffer.from(body), privateKey))}`;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
const now = Date.now();

test('room paths: only /v1/room/<43-char id> with a known role', () => {
  assert.deepEqual(parseRoomPath(new URL(`https://r.dev/v1/room/${ROOM}?role=host`)), { room: ROOM, role: 'host' });
  assert.deepEqual(parseRoomPath(new URL(`https://r.dev/v1/room/${ROOM}?role=phone`)), { room: ROOM, role: 'phone' });
  assert.equal(parseRoomPath(new URL(`https://r.dev/v1/room/${ROOM}?role=admin`)), null);
  assert.equal(parseRoomPath(new URL(`https://r.dev/v1/room/${ROOM}`)), null);
  assert.equal(parseRoomPath(new URL('https://r.dev/v1/room/short?role=host')), null);
  assert.equal(parseRoomPath(new URL(`https://r.dev/v1/room/${ROOM}/x?role=host`)), null);
  assert.equal(parseRoomPath(new URL(`https://r.dev/v2/room/${ROOM}?role=host`)), null);
});

test('a token the website signed opens a room until it expires', async () => {
  const token = mint(privateKey, { k: 'MAIN-AAAA', m: 'machine', iat: now, exp: now + 60_000, v: 1 });
  const payload = await verifyLicenseToken(token, now, keyHex);
  assert.equal(payload.k, 'MAIN-AAAA');
  assert.equal(await verifyLicenseToken(token, now + 60_000, keyHex), null, 'expired');
});

test('forged, tampered and malformed tokens are refused', async () => {
  const good = mint(privateKey, { k: 'MAIN-AAAA', m: 'machine', iat: now, exp: now + 60_000, v: 1 });
  const [, sig] = good.split('.');
  const otherBody = b64url(JSON.stringify({ k: 'MAIN-BBBB', m: 'machine', iat: now, exp: now + 9e12, v: 1 }));
  assert.equal(await verifyLicenseToken(`${otherBody}.${sig}`, now, keyHex), null, 'body swapped under a real signature');

  const stranger = generateKeyPairSync('ed25519').privateKey;
  assert.equal(await verifyLicenseToken(mint(stranger, { exp: now + 60_000 }), now, keyHex), null, 'signed by someone else');

  for (const bad of [undefined, null, '', 'x', 'a.b.c', `${otherBody}.`, `${otherBody}.@@`, 'x'.repeat(LIMITS.maxTokenChars + 1)]) {
    assert.equal(await verifyLicenseToken(bad, now, keyHex), null, String(bad).slice(0, 20));
  }
  const noExp = mint(privateKey, { k: 'MAIN-AAAA' });
  assert.equal(await verifyLicenseToken(noExp, now, keyHex), null, 'no expiry');
});

test('only sealed envelopes are relayed', () => {
  assert.ok(isEnvelope('{"t":"e","v":1,"iv":"abc","d":"def"}'));
  assert.ok(!isEnvelope('{"t":"ping"}'));
  assert.ok(!isEnvelope('{"t":"e","iv":1,"d":"x"}'));
  assert.ok(!isEnvelope('hello'));
  assert.ok(!isEnvelope('{"t":"e"'));
  assert.ok(!isEnvelope(null));
});

test('the rate limit allows a burst, then refills over time', () => {
  const b = new TokenBucket(10, 3, 0);
  assert.deepEqual([b.take(0), b.take(0), b.take(0), b.take(0)], [true, true, true, false]);
  assert.equal(b.take(50), false, 'half a token is not a message');
  assert.equal(b.take(100), true, 'a tenth of a second refills one at 10/s');
});

test('close codes sent back are always legal to send', () => {
  assert.equal(replyCloseCode(1000), 1000);
  assert.equal(replyCloseCode(4001), 4001);
  for (const reserved of [1005, 1006, 1015, 0, 99999]) assert.equal(replyCloseCode(reserved), 1000);
});
