// The relay's rules — room names, roles, limits, the license check, the rate
// limiter. Nothing here touches a Cloudflare API, so node:test runs it as-is.
//
// The relay is deliberately dumb: it pairs one PC ("host") with up to four
// phones in a room and passes sealed envelopes between them. It never sees the
// pairing secret or the key (see the desktop app's renderer/remote-protocol.js),
// so it can't read what's playing or forge a command — it only knows a room id.

export const ROOM_RE = /^[A-Za-z0-9_-]{43}$/;
export const ROLES = ['host', 'phone'];

export const LIMITS = {
  maxPhones: 4,
  maxMessageBytes: 64 * 1024,   // a long song's lyrics, sealed, fit with room to spare
  ratePerSecond: 25,
  burst: 50,
  maxTokenChars: 2048,
};

// Custom close codes the PC and the phone page understand.
export const CLOSE = {
  replaced: 4000,      // another PC took the room (the app was opened twice)
  roomFull: 4001,      // too many phones
  tooBig: 4002,
  rateLimited: 4008,
};

// The website's license-signing public key (Ed25519, SPKI DER) — the SAME key
// the desktop app checks its own unlock against (main/license.js). Only a PC
// running a licensed copy of main can open a room; phones need only the room
// id. A desktop test fails if the two copies of this key drift apart.
export const LICENSE_PUBLIC_KEY_HEX =
  '302a300506032b65700321000b568b3e9a061d2656dcb09d7761c994b917b4209c13ca0ca2dbfaa94fc5f313';

/** `/v1/room/<room>?role=host|phone` → { room, role }, or null. */
export function parseRoomPath(url) {
  const m = /^\/v1\/room\/([^/]+)$/.exec(url.pathname);
  if (!m || !ROOM_RE.test(m[1])) return null;
  const role = url.searchParams.get('role');
  if (!ROLES.includes(role)) return null;
  return { room: m[1], role };
}

/** True for a sealed envelope ({"t":"e",...}); anything else is not relayed. */
export function isEnvelope(text) {
  if (typeof text !== 'string' || !text.startsWith('{')) return false;
  try {
    const env = JSON.parse(text);
    return !!env && env.t === 'e' && typeof env.iv === 'string' && typeof env.d === 'string';
  } catch {
    return false;
  }
}

function b64urlToBytes(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function hexToBytes(hex) {
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
}

const keyCache = new Map();

async function importVerifyKey(hex) {
  if (keyCache.has(hex)) return keyCache.get(hex);
  const der = hexToBytes(hex);
  let key;
  try {
    key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    // Older runtimes spelled it this way.
    key = await crypto.subtle.importKey('spki', der, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']);
  }
  keyCache.set(hex, key);
  return key;
}

/**
 * Checks a license token the way the desktop app does (main/license.js):
 * `b64url(payload).b64url(signature)`, Ed25519 over the ASCII of the first
 * part, not yet expired. Returns the payload, or null.
 */
export async function verifyLicenseToken(token, now = Date.now(), keyHex = LICENSE_PUBLIC_KEY_HEX) {
  if (typeof token !== 'string' || token.length > LIMITS.maxTokenChars) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const sigBytes = b64urlToBytes(sig);
  const bodyBytes = b64urlToBytes(body);
  if (!sigBytes || sigBytes.length !== 64 || !bodyBytes) return null;
  try {
    const key = await importVerifyKey(keyHex);
    const ok = await crypto.subtle.verify(key.algorithm, key, sigBytes, new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(bodyBytes));
    if (!payload || typeof payload.exp !== 'number' || now >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Per-socket rate limit: `burst` messages at once, refilling at `rate`/s. */
export class TokenBucket {
  constructor(rate, burst, now) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  take(now) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) * this.rate) / 1000);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** A close code we may send back: the peer's own, or a plain 1000. */
export function replyCloseCode(code) {
  return code === 1000 || code === 1001 || (code >= 3000 && code <= 4999) ? code : 1000;
}
