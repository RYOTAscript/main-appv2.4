// License / entitlement for the paid app.
//
// The app is gated behind a purchase. A user unlocks it either by
//   • signing in with Google (native OAuth → the website's /api/app/session), or
//   • pasting the license key they got after buying.
//
// SECURITY MODEL (why this file looks the way it does)
// ----------------------------------------------------
// The app never trusts a plain "valid: true" reply, and never trusts the local
// license.json on its own — either could be forged (a fake local verify server,
// a hand-edited JSON file, a copied file from another machine). Instead:
//
//   • The website mints a short **Ed25519-signed token** bound to (this key,
//     this machine, an expiry). Only the website holds the private key.
//   • This client verifies that signature OFFLINE against LICENSE_PUBLIC_KEY
//     (baked in below). No valid signature ⇒ no unlock. So a fake server can't
//     forge one, and a forged/edited license.json fails verification.
//   • The token is machine-bound (`m`), so copying one paying user's
//     license.json to another machine fails the machine check.
//   • The offline grace window lives INSIDE the signed token (`exp`), so it
//     can't be extended by editing a local timestamp.
//
// None of this makes a determined reverse-engineer's binary patch impossible
// (nothing client-side can) — it closes the easy, no-skill bypasses (shared
// files, keygens, fake servers, timestamp edits) and makes the rest real work.
//
// The website is the single source of truth (see the `website/` project).

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { shell } = require('electron');

// ── Config ──────────────────────────────────────────────────────────────────
// The deployed website is the licensing authority. Override with MAIN_SITE_URL
// (e.g. set MAIN_SITE_URL=http://localhost:3000 while developing locally).
const SITE_URL = (process.env.MAIN_SITE_URL || 'https://main-website-eosin-beta.vercel.app').replace(/\/$/, '');
// From your Google "Desktop app" OAuth client (see website docs/DESKTOP_APP_AUTH.md).
const GOOGLE_CLIENT_ID = process.env.GOOGLE_DESKTOP_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_DESKTOP_CLIENT_SECRET || '';
// Optional shared secret if the website's verify endpoint is locked down.
const VERIFY_SECRET = process.env.LICENSE_VERIFY_SECRET || '';

// Ed25519 PUBLIC key that verifies license tokens. Its private half lives only
// on the website (LICENSE_SIGNING_PRIVATE_KEY). A public key can only VERIFY,
// never mint, so shipping it is safe.
//
// It's stored as split SPKI-DER hex — NOT a "-----BEGIN PUBLIC KEY-----" PEM
// block — specifically so a cracker can't grep the binary for the key and
// swap in their own (which, paired with a fake verify server, would forge
// tokens). Reconstructed to a KeyObject once at load. Rotating the key requires
// changing these bytes AND the server's private key together.
const _kv = [
  '302a300506032b65700321',
  '000b568b3e9a061d2656dc',
  'b09d7761c994b917b4209c',
  '13ca0ca2dbfaa94fc5f313',
];

let PUBLIC_KEY_OBJ = null;
try {
  PUBLIC_KEY_OBJ = crypto.createPublicKey({
    key: Buffer.from(_kv.join(''), 'hex'),
    format: 'der',
    type: 'spki',
  });
} catch (e) {
  // Left null → tokenUnlock() fails closed (app stays gated) rather than
  // silently unlocking. This should never happen with a valid baked-in key.
}

const NET_TIMEOUT_MS = 6000;
// Tolerance for clock drift/corrections before we treat a backwards jump as
// tampering (the "wind the system clock back to dodge token expiry" trick).
const ROLLBACK_SKEW_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^MAIN-[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/;

// Anti-hook tripwire. Forging tokens by globally patching crypto.verify to
// always return true (via a Frida/module hook — a common RE technique) also
// makes a KNOWN-BAD signature verify as valid. cryptoIntact() detects exactly
// that: it signs a canary with an ephemeral key and asserts the good signature
// verifies AND a tampered message does NOT. If the verifier has been neutered,
// this returns false and we refuse to unlock (fail closed) instead of trusting
// a compromised primitive.
let _canaryPub = null;
let _canaryGoodSig = null;
const _CANARY_GOOD = Buffer.from('main-canary-ok');
const _CANARY_BAD = Buffer.from('main-canary-XX');
try {
  const kp = crypto.generateKeyPairSync('ed25519');
  _canaryPub = kp.publicKey;
  _canaryGoodSig = crypto.sign(null, _CANARY_GOOD, kp.privateKey);
} catch (e) {
  /* leave null → cryptoIntact() returns false → fail closed */
}
function cryptoIntact() {
  try {
    if (!_canaryPub || !_canaryGoodSig) return false;
    return (
      crypto.verify(null, _CANARY_GOOD, _canaryPub, _canaryGoodSig) === true &&
      crypto.verify(null, _CANARY_BAD, _canaryPub, _canaryGoodSig) === false
    );
  } catch (e) {
    return false;
  }
}
const DEVICE_LIMIT_MSG =
  "This license is already active on the maximum number of devices. " +
  "Open your account page and use “Reset devices” to free your slots, then try again.";

let logger = null;
let storePath = null;

// ── Machine fingerprint ───────────────────────────────────────────────────────
// Stable, non-PII hardware id used to bind a license token to this machine.
// Primary source is the Windows MachineGuid (survives app reinstalls, changes
// only on OS reinstall); falls back to hostname + first physical MAC.
let _machineId = null;
function computeMachineId() {
  let raw = '';
  try {
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: 'utf8', windowsHide: true, timeout: 4000 },
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
    if (m) raw = m[1];
  } catch (e) {
    /* fall through to the network-interface fallback */
  }
  if (!raw) {
    try {
      const nets = os.networkInterfaces();
      let mac = '';
      for (const name of Object.keys(nets)) {
        for (const ni of nets[name] || []) {
          if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') { mac = ni.mac; break; }
        }
        if (mac) break;
      }
      raw = `${os.hostname()}|${mac}`;
    } catch (e) {
      raw = os.hostname() || 'unknown';
    }
  }
  return crypto.createHash('sha256').update(`main-license|${raw}`).digest('hex').slice(0, 32);
}
function machineId() {
  if (!_machineId) _machineId = computeMachineId();
  return _machineId;
}

// ── Token verification ────────────────────────────────────────────────────────
function b64urlDecode(s) {
  const str = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(str, 'base64');
}

/** Verify a token's Ed25519 signature and return its payload, or null. */
function verifyToken(token) {
  try {
    if (!PUBLIC_KEY_OBJ || !cryptoIntact()) return null;
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const ok = crypto.verify(null, Buffer.from(body), PUBLIC_KEY_OBJ, b64urlDecode(sig));
    if (!ok) return null;
    return JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Decide whether the stored record proves a live entitlement, using ONLY the
 * signed token (offline-safe). Returns the payload when it does, else null.
 * A record unlocks iff: token signature is valid AND it was minted for this key
 * AND for this machine AND has not expired.
 */
function tokenUnlock(stored) {
  if (!stored || !stored.token || !stored.key) return null;
  const p = verifyToken(stored.token);
  if (!p) return null;
  if (p.k !== stored.key) return null;
  if (p.m !== machineId()) return null;
  const now = Date.now();
  // Clock-rollback guard: a token can't be valid before it was issued, and we
  // never trust a clock wound back below the newest time we've already seen —
  // that's the "set the system clock back to dodge expiry" trick. On a detected
  // rollback we fail closed here, which forces an online re-verify (fresh token).
  if (typeof p.iat === 'number' && now < p.iat - ROLLBACK_SKEW_MS) return null;
  if (typeof stored.maxSeen === 'number' && now < stored.maxSeen - ROLLBACK_SKEW_MS) return null;
  if (typeof p.exp !== 'number' || now >= p.exp) return null;
  return p;
}

// Persist the newest wall-clock time we've legitimately observed, so a later
// backward jump is detectable (see tokenUnlock's rollback guard).
function noteSeen(stored) {
  try {
    const now = Date.now();
    if (stored && (!stored.maxSeen || now > stored.maxSeen)) {
      stored.maxSeen = now;
      writeStore(stored);
    }
  } catch (e) {
    /* non-fatal */
  }
}

function readStore() {
  try {
    if (fs.existsSync(storePath)) return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch (e) {
    logger?.warn?.('License store unreadable', e);
  }
  return null;
}

function writeStore(rec) {
  try {
    fs.writeFileSync(storePath, JSON.stringify(rec, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (e) {
    logger?.error?.('Failed to write license store', e);
  }
}

function clearStore() {
  try {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  } catch (e) {
    logger?.warn?.('Failed to clear license store', e);
  }
}

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── Website calls ─────────────────────────────────────────────────────────────
// tokenIat: issue-time of the token we currently hold (ms epoch), so the server
// can detect a token minted before a device reset and log this machine out. 0
// for a fresh unlock (no token yet).
async function verifyKeyOnline(key, tokenIat = 0) {
  const headers = { 'Content-Type': 'application/json' };
  if (VERIFY_SECRET) headers.Authorization = `Bearer ${VERIFY_SECRET}`;
  let deviceName = '';
  try { deviceName = String(os.hostname() || '').slice(0, 64); } catch (e) { /* optional */ }
  const res = await fetch(`${SITE_URL}/api/license/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key, machineId: machineId(), tokenIat, deviceName }),
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  // device-limit / reset / plain-invalid come back as HTTP 200 { valid:false }.
  // Genuine transport/server errors throw → callers fall back to the offline
  // grace path (a still-valid cached token).
  if (!res.ok && res.status !== 200) throw new Error(`verify HTTP ${res.status}`);
  return res.json(); // { valid, token?, email?, issuedAt?, exp?, error? }
}

/** Issue-time of the token in a stored record, or 0 if none/invalid. */
function tokenIatOf(stored) {
  const p = stored && stored.token ? verifyToken(stored.token) : null;
  return p && typeof p.iat === 'number' ? p.iat : 0;
}

/**
 * Online-verify a key, validate the returned signed token, and on success
 * persist the record. Shared by the key-paste and Google-sign-in paths.
 */
async function mintAndStore(key, extra = {}) {
  const r = await verifyKeyOnline(key);
  if (!r || !r.valid || !r.token) {
    if (r && r.error === 'device-limit') return { valid: false, error: 'device-limit' };
    if (r && r.error === 'signing-unavailable') return { valid: false, error: 'server' };
    return { valid: false, error: 'invalid' };
  }
  const p = verifyToken(r.token);
  if (!p || p.k !== key || p.m !== machineId()) {
    // A well-formed 200 whose token doesn't verify ⇒ not the real server.
    logger?.warn?.('License token failed verification — refusing to unlock');
    return { valid: false, error: 'bad-token' };
  }
  const rec = {
    key,
    token: r.token,
    email: r.email || extra.email || null,
    name: extra.name || null,
    issuedAt: r.issuedAt || extra.issuedAt || null,
    provider: extra.provider || 'key',
    machineId: machineId(),
    lastVerified: Date.now(),
    maxSeen: Date.now(),
  };
  writeStore(rec);
  return { valid: true, license: rec };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Verify a pasted license key and, on success, persist it. */
async function verifyKey(rawKey) {
  const key = String(rawKey || '').trim().toUpperCase();
  if (!key) return { valid: false, error: 'Enter your license key.' };
  if (!KEY_PATTERN.test(key)) {
    return {
      valid: false,
      error: 'That license key is malformed. Double-check it and try again.',
    };
  }
  try {
    const r = await mintAndStore(key, { provider: 'key' });
    if (r.valid) {
      logger?.success?.('License unlocked via key', { email: r.license.email });
      return { valid: true, license: r.license };
    }
    if (r.error === 'device-limit') return { valid: false, error: DEVICE_LIMIT_MSG };
    if (r.error === 'server') {
      return { valid: false, error: 'Licensing is temporarily unavailable. Try again shortly.' };
    }
    if (r.error === 'bad-token') {
      return { valid: false, error: "Couldn't establish a trusted connection to the licensing server." };
    }
    return { valid: false, error: "That key isn't valid. Double-check it, or buy a license." };
  } catch (e) {
    logger?.warn?.('Key verify failed (network?)', e);
    return { valid: false, error: "Couldn't reach the licensing server. Check your connection." };
  }
}

/** Native Google OAuth (PKCE + loopback) → website session → entitlement. */
function signInWithGoogle() {
  return new Promise((resolve) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      resolve({ ok: false, error: 'Google sign-in is not configured in this build.' });
      return;
    }

    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { server.close(); } catch {} resolve(v); } };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (!url.searchParams.get('code') && !url.searchParams.get('error')) {
          res.writeHead(204).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><meta charset="utf-8"><body style="background:#080808;color:#fff;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p>You can close this tab and return to main.</p></body>');

        if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error'));
        if (url.searchParams.get('state') !== state) throw new Error('State mismatch');

        const code = url.searchParams.get('code');
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: verifier,
          }),
          signal: AbortSignal.timeout(NET_TIMEOUT_MS),
        });
        const tokens = await tokenRes.json();
        if (!tokens.id_token) throw new Error(tokens.error_description || 'No id_token from Google');

        const siteRes = await fetch(`${SITE_URL}/api/app/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: tokens.id_token }),
          signal: AbortSignal.timeout(NET_TIMEOUT_MS),
        });
        const data = await siteRes.json();
        if (!siteRes.ok || !data.authenticated) throw new Error(data.error || 'Sign-in failed');

        if (data.purchased && data.license) {
          const licenseKey = String(data.license.key || '').trim().toUpperCase();
          if (!KEY_PATTERN.test(licenseKey)) {
            throw new Error('Invalid license key returned by server');
          }
          // Prove the entitlement the same way as key-paste: mint & verify a
          // machine-bound signed token. Google sign-in identifies the user; the
          // token is what actually unlocks the app.
          const minted = await mintAndStore(licenseKey, {
            provider: 'google',
            email: data.email,
            name: data.name,
            issuedAt: data.license.issuedAt,
          });
          if (!minted.valid) {
            done({
              ok: false,
              error: minted.error === 'device-limit'
                ? DEVICE_LIMIT_MSG
                : 'Signed in, but this device could not be activated. Please try again.',
            });
            return;
          }
          logger?.success?.('License unlocked via Google', { email: minted.license.email });
          done({ ok: true, purchased: true, license: minted.license, email: data.email });
        } else {
          done({ ok: true, purchased: false, email: data.email });
        }
      } catch (e) {
        logger?.warn?.('Google sign-in failed', e);
        done({ ok: false, error: 'Google sign-in failed. Please try again.' });
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}`;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        prompt: 'select_account',
      });
      shell.openExternal(authUrl);
    });

    setTimeout(() => done({ ok: false, error: 'Sign-in timed out.' }), 5 * 60 * 1000);
  });
}

/**
 * Authoritative startup entitlement check. Re-verifies online (refreshing the
 * signed token, hence the offline grace); on a network failure falls back to a
 * still-valid cached token.
 */
async function check() {
  const stored = readStore();
  if (!stored || !stored.key) return { unlocked: false, reason: 'none' };
  try {
    const r = await verifyKeyOnline(stored.key, tokenIatOf(stored));
    if (r && r.valid && r.token) {
      const p = verifyToken(r.token);
      if (p && p.k === stored.key && p.m === machineId()) {
        stored.token = r.token;
        stored.lastVerified = Date.now();
        if (r.email) stored.email = r.email;
        writeStore(stored);
        return { unlocked: true, license: stored };
      }
      throw new Error('token failed verification'); // → offline fallback below
    }
    if (r && r.error === 'reset') {
      // Devices were reset from the account page → log out and re-authenticate.
      logger?.system?.('Devices were reset — logging out');
      clearStore();
      return { unlocked: false, reason: 'reset' };
    }
    if (r && r.error === 'device-limit') {
      // Key is real but over its device cap — don't wipe it, just gate.
      return { unlocked: false, reason: 'device-limit' };
    }
    // Definitive "not valid" from the server → license revoked/refunded.
    clearStore();
    return { unlocked: false, reason: 'revoked' };
  } catch (e) {
    // Network failure (or an untrusted reply) — honour a still-valid token.
    const p = tokenUnlock(stored);
    if (p) {
      logger?.log?.('License check offline — cached token still valid', 'INFO');
      return { unlocked: true, offline: true, license: stored };
    }
    return { unlocked: false, reason: 'offline-expired' };
  }
}

/**
 * Instant, network-free entitlement decision from the local cache — used at
 * STARTUP so the app shows immediately instead of blocking on an online verify.
 * Trusts ONLY a valid, unexpired, machine-matched signed token.
 *   { unlocked:true }             → cached token valid
 *   { unlocked:false, reason }    → 'none' (no license) or 'stale' (no valid
 *                                    token / expired → caller does the online check)
 */
function getCachedUnlock() {
  const stored = readStore();
  if (!stored || !stored.key) return { unlocked: false, reason: 'none' };
  if (tokenUnlock(stored)) {
    noteSeen(stored); // advance the rollback watermark on each successful launch
    return { unlocked: true, cached: true, license: stored };
  }
  return { unlocked: false, reason: 'stale', license: stored };
}

/**
 * Re-verify quietly after the app has started. Refreshes the token on success;
 * on a definitive server "invalid" (revoked/refunded) clears the cache and calls
 * onRevoked. Network errors and device-limit are ignored so a transient blip
 * never kicks a paying user out.
 */
async function verifyInBackground(onRevoked) {
  const stored = readStore();
  if (!stored || !stored.key) return;
  try {
    const r = await verifyKeyOnline(stored.key, tokenIatOf(stored));
    if (r && r.valid && r.token) {
      const p = verifyToken(r.token);
      if (p && p.k === stored.key && p.m === machineId()) {
        stored.token = r.token;
        stored.lastVerified = Date.now();
        if (r.email) stored.email = r.email;
        writeStore(stored);
      }
      return;
    }
    if (r && r.error === 'device-limit') return; // already-activated machines don't hit this
    if (r && r.error === 'reset') {
      logger?.system?.('Devices were reset — logging out to the gate');
    } else {
      logger?.warn?.('Background re-verify: license no longer valid');
    }
    // reset OR revoked/refunded → clear the local license and return to the gate.
    clearStore();
    if (typeof onRevoked === 'function') onRevoked();
  } catch (e) {
    /* offline / transient — keep the cached token */
  }
}

function getState() {
  const stored = readStore();
  return {
    siteUrl: SITE_URL,
    googleAvailable: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    email: stored?.email || null,
    hasLicense: !!stored?.key,
  };
}

// Full stored license details for the in-app Account settings section.
function getAccount() {
  const s = readStore();
  if (!s || !s.key) return null;
  return {
    key: s.key,
    email: s.email || null,
    name: s.name || null,
    provider: s.provider || 'key',
    issuedAt: s.issuedAt || null,
    lastVerified: s.lastVerified || null,
    siteUrl: SITE_URL,
  };
}

function openPricing() {
  shell.openExternal(`${SITE_URL}/#pricing`);
}

function openAccount() {
  shell.openExternal(`${SITE_URL}/account`);
}

function signOut() {
  clearStore();
}

function init(ctx) {
  logger = ctx.logger;
  storePath = path.join(ctx.userDataPath, 'license.json');
  return { check, getCachedUnlock, verifyInBackground, verifyKey, signInWithGoogle, getState, getAccount, openPricing, openAccount, signOut, SITE_URL };
}

module.exports = { init };
