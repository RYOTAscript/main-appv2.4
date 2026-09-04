'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  classifySpotifyConnectivity,
  SPOTIFY_NETWORK_CODES,
  SPOTIFY_TLS_CODES
} = require('../main/spotify.connectivity');

// The regression this guards: a TLS-inspecting proxy/antivirus makes every
// Spotify poll throw "self signed certificate in certificate chain". That must be
// classified as a quiet, retry-until-it-clears connectivity failure — NOT logged
// as a full ERROR+stack every 2.5s, which floods errors.log (observed live).

test('the exact self-signed-cert error that flooded the log is classified tls', () => {
  // With a code (Node usually sets it) …
  assert.strictEqual(
    classifySpotifyConnectivity({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self signed certificate in certificate chain' }),
    'tls'
  );
  // … and code-less (the shape that actually reached the logger in the wild).
  assert.strictEqual(
    classifySpotifyConnectivity({ message: 'self signed certificate in certificate chain' }),
    'tls'
  );
});

test('every known TLS cert code classifies as tls', () => {
  for (const code of SPOTIFY_TLS_CODES) {
    assert.strictEqual(classifySpotifyConnectivity({ code }), 'tls', `code ${code}`);
  }
});

test('every known network code classifies as network', () => {
  for (const code of SPOTIFY_NETWORK_CODES) {
    assert.strictEqual(classifySpotifyConnectivity({ code }), 'network', `code ${code}`);
  }
});

test('ECONNRESET during token refresh is network, not an error', () => {
  // This is the token-refresh line that also flooded the log.
  assert.strictEqual(classifySpotifyConnectivity({ code: 'ECONNRESET', message: 'read ECONNRESET' }), 'network');
});

test('httpClient\'s literal "Request timeout" message is network', () => {
  // httpClient rejects timeouts with this message and no code.
  assert.strictEqual(classifySpotifyConnectivity({ message: 'Request timeout' }), 'network');
});

test('cert errors are found through cause and aggregate wrappers', () => {
  assert.strictEqual(
    classifySpotifyConnectivity({ message: 'request failed', cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }),
    'tls'
  );
  assert.strictEqual(
    classifySpotifyConnectivity({ message: 'agg', errors: [{ code: 'ENOTFOUND' }] }),
    'network'
  );
});

test('genuine, non-connectivity faults stay null so they remain loud ERRORs', () => {
  assert.strictEqual(classifySpotifyConnectivity({ message: 'Unexpected token < in JSON at position 0' }), null);
  assert.strictEqual(classifySpotifyConnectivity({ message: 'Cannot read properties of undefined' }), null);
  assert.strictEqual(classifySpotifyConnectivity(null), null);
  assert.strictEqual(classifySpotifyConnectivity(undefined), null);
  assert.strictEqual(classifySpotifyConnectivity({}), null);
});

test('a self-referential cause does not infinite-loop', () => {
  const e = { message: 'boom' };
  e.cause = e;
  assert.strictEqual(classifySpotifyConnectivity(e), null);
});
