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
const { app, shell, safeStorage } = require('electron');

// ── Config ──────────────────────────────────────────────────────────────────
// The deployed website is the licensing authority. In a dev run (`npm start`)
// MAIN_SITE_URL repoints it — e.g. http://localhost:3000; see the dev-only
// override block below for why a packaged build ignores it.

// ── Google "Desktop app" OAuth credentials ───────────────────────────────────
// PASTE YOUR CREDENTIALS HERE to enable in-app Google sign-in. They come from
// the Google Cloud console → Credentials → OAuth client ID → "Desktop app"
// (see website docs/DESKTOP_APP_AUTH.md).
//
// Yes, these are baked into a shipped binary, and that is correct: Google
// documents that an installed app cannot keep a client secret, which is exactly
// why this flow uses PKCE + a validated `state` and why the secret is not a
// security boundary here. Leaving them blank does NOT make the app safer — it
// only disables Google sign-in, which pushes every user onto the pasteable
// license key, the most shareable credential we issue.
//
// While these are blank the gate hides the Google button (see getState's
// googleAvailable) and key-paste stays the only route in.
// The real values live in main/googleCredentials.js, which is gitignored: a
// credential sitting in a repository is far easier to harvest at scale than one
// inside a shipped installer, and GitHub's push protection rejects it outright.
// A clone without that file gets blanks, which hides the Google button and
// leaves key-paste as the only route in — see googleCredentials.example.js.
const googleCreds = (() => {
  try { return require('./googleCredentials'); } catch (e) { return {}; }
})();
const GOOGLE_DESKTOP_CLIENT_ID = googleCreds.GOOGLE_DESKTOP_CLIENT_ID || '';
const GOOGLE_DESKTOP_CLIENT_SECRET = googleCreds.GOOGLE_DESKTOP_CLIENT_SECRET || '';

// ── Dev-only overrides ───────────────────────────────────────────────────────
// These repoint the licensing authority, so they're honoured ONLY in an
// unpackaged dev run. In a shipped build an environment variable must never be
// able to nominate a different verify server: a fake authority still can't forge
// a signature, but it hands half the attack to anyone who patches the baked-in
// public key, for no benefit to a real user.
const IS_DEV = (() => {
  try { return !app.isPackaged; } catch (e) { return false; }
})();
const devEnv = (name) => (IS_DEV ? process.env[name] || '' : '');

const SITE_URL = (devEnv('MAIN_SITE_URL') || 'https://main-website-eosin-beta.vercel.app').replace(/\/$/, '');
const GOOGLE_CLIENT_ID = GOOGLE_DESKTOP_CLIENT_ID || devEnv('GOOGLE_DESKTOP_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = GOOGLE_DESKTOP_CLIENT_SECRET || devEnv('GOOGLE_DESKTOP_CLIENT_SECRET');
// Optional shared secret if the website's verify endpoint is locked down.
const VERIFY_SECRET = devEnv('LICENSE_VERIFY_SECRET');

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
// Windows: MachineGuid · macOS: IOPlatformUUID · else: hostname + first MAC.
// The compute/hash logic lives in ./machineId (electron-free + unit-tested); the
// Windows result is byte-identical to before so existing users aren't logged out.
const { computeMachineId } = require('./machineId');
const {
  effectiveMaxSeen: pickMaxSeen, isRollback, nextWatermark,
} = require('./licenseWatermark');
const { RETURN_PAGE } = require('./licenseReturnPage');
let _machineId = null;
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
  // Rollback watermark. Reading it through effectiveMaxSeen() matters: the old
  // check was `typeof stored.maxSeen === 'number' && ...`, which meant deleting
  // that one field from license.json made the guard skip ITSELF, and a wound-back
  // clock then replayed a 3-day token forever. Now a record that should carry a
  // watermark and doesn't is treated as tampered, not as permission to skip.
  if (isRollback(effectiveMaxSeen(stored), now, ROLLBACK_SKEW_MS)) return null;
  if (typeof p.exp !== 'number' || now >= p.exp) return null;
  return p;
}

// ── Rollback watermark ────────────────────────────────────────────────────────
// The newest wall-clock time we've legitimately observed. license.json is
// plaintext and user-owned, so the watermark is MIRRORED to a second file that
// goes through safeStorage (OS-encrypted): a user can delete that file but can't
// hand-edit it down to a smaller number, and we take whichever copy is newer.
//
// `wm: 1` on the record marks "the mirror has been established". Its absence is
// the one-run grace for a record written by a build that predates this mirror —
// without it, upgrading users would be logged straight out. Once set, a missing
// mirror means someone removed it.
function watermarkPath() {
  return storePath ? storePath.replace(/license\.json$/, 'license-wm') : null;
}

function readWatermark() {
  try {
    const p = watermarkPath();
    if (!p || !fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p);
    // Encrypted normally; plaintext only where the OS offers no key store.
    let text;
    if (app.isReady() && safeStorage.isEncryptionAvailable()) {
      try { text = safeStorage.decryptString(raw); } catch (e) { text = raw.toString('utf8'); }
    } else {
      text = raw.toString('utf8');
    }
    const v = JSON.parse(text);
    return typeof v?.maxSeen === 'number' ? v.maxSeen : null;
  } catch (e) {
    return null;
  }
}

function writeWatermark(ms) {
  try {
    const p = watermarkPath();
    if (!p) return;
    const json = JSON.stringify({ maxSeen: ms });
    const usable = app.isReady() && safeStorage.isEncryptionAvailable();
    fs.writeFileSync(p, usable ? safeStorage.encryptString(json) : json, { mode: 0o600 });
  } catch (e) {
    /* non-fatal — the in-record copy still applies */
  }
}

/** The watermark to enforce, reading both copies. See ./licenseWatermark.js. */
function effectiveMaxSeen(stored) {
  return pickMaxSeen(stored, readWatermark());
}

// Advance both copies to now. Called on each successful launch.
function noteSeen(stored) {
  try {
    const now = Date.now();
    const next = nextWatermark(effectiveMaxSeen(stored), now);
    writeWatermark(next);
    if (stored && (stored.maxSeen !== next || !stored.wm)) {
      stored.maxSeen = next;
      stored.wm = 1; // mirror established — its absence is tampering from here on
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
  // Drop the watermark mirror too — a genuine sign-out/revoke must not leave a
  // stale marker that makes the next legitimate unlock look like tampering.
  try {
    const p = watermarkPath();
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    /* non-fatal */
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
    wm: 1,
  };
  writeWatermark(rec.maxSeen);
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
    // What the browser tab is told. The tab is answered the instant Google
    // redirects to it — long before the token exchange, the site call and the
    // activation have run — so instead of the old page that always claimed
    // success, it gets a "finishing" state and polls /status for the real
    // outcome. A failure now ends up on screen where the user is looking,
    // rather than only in the app behind the browser window.
    let outcome = { state: 'working', stage: 'auth' };
    // Advances as the handshake progresses: auth → license → device. The
    // return page renders it as a live trace, so a failure names its stage
    // on screen instead of only in the log.
    const setStage = (stage) => { if (!settled) outcome = { state: 'working', stage }; };
    const done = (v) => {
      if (settled) return;
      settled = true;
      const stage = outcome.stage || 'auth';
      outcome = v.ok
        ? {
            state: 'ok',
            stage,
            title: v.purchased ? 'You’re all set' : 'Signed in',
            detail: v.purchased
              ? 'main is unlocked on this computer. You can close this tab.'
              : 'Signed in, but this account has no license yet. Head back to main to buy one.',
          }
        : { state: 'error', stage, title: 'Sign-in didn’t finish', detail: v.error };
      resolve(v);
      // Leave the loopback server up briefly so the tab can pick up that final
      // state, then tear it down.
      const t = setTimeout(() => {
        try { server.closeAllConnections?.(); } catch (e) { /* older Node */ }
        try { server.close(); } catch (e) { /* already closing */ }
      }, 4000);
      if (t.unref) t.unref();
    };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');

        // Poll target for the page served below.
        if (url.pathname === '/status') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(outcome));
          return;
        }

        if (!url.searchParams.get('code') && !url.searchParams.get('error')) {
          res.writeHead(204).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(RETURN_PAGE);

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
        if (!tokens.id_token) {
          // Google rejected the code exchange. `error` is the machine-readable
          // half and is what actually identifies the misconfiguration —
          // redirect_uri_mismatch here almost always means the OAuth client was
          // created as a "Web application" instead of a "Desktop app", since only
          // the desktop type accepts a loopback redirect on a random port.
          logger?.error?.('Google token exchange rejected', null, {
            status: tokenRes.status,
            error: tokens.error || null,
            description: tokens.error_description || null,
          });
          if (tokens.error === 'redirect_uri_mismatch') {
            throw new Error(
              'Google rejected the sign-in redirect. The OAuth client must be of type "Desktop app".',
            );
          }
          if (tokens.error === 'invalid_client') {
            throw new Error('Google rejected this app’s credentials. Check the client ID and secret.');
          }
          throw new Error(tokens.error_description || tokens.error || 'No id_token from Google');
        }

        setStage('license');
        const siteRes = await fetch(`${SITE_URL}/api/app/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: tokens.id_token }),
          signal: AbortSignal.timeout(NET_TIMEOUT_MS),
        });
        const data = await siteRes.json().catch(() => ({}));
        if (!siteRes.ok || !data.authenticated) {
          logger?.error?.('Licensing server rejected the Google sign-in', null, {
            siteUrl: SITE_URL,
            status: siteRes.status,
            error: data.error || null,
          });
          if (siteRes.status === 503) {
            throw new Error('The licensing server isn’t set up for app sign-in yet.');
          }
          if (siteRes.status === 401) {
            // The id_token is real and freshly signed by Google, so a 401 here is
            // an audience mismatch: the server's GOOGLE_DESKTOP_CLIENT_ID doesn't
            // match the client ID this build signs in with.
            logger?.warn?.(
              'Google token was valid but the site refused it — the server\'s GOOGLE_DESKTOP_CLIENT_ID ' +
              'must equal this build\'s client ID',
              { clientId: GOOGLE_CLIENT_ID },
            );
            throw new Error('The licensing server didn’t accept this Google account. Try again shortly.');
          }
          throw new Error(data.error || 'Sign-in failed');
        }

        if (data.purchased && data.license) {
          const licenseKey = String(data.license.key || '').trim().toUpperCase();
          if (!KEY_PATTERN.test(licenseKey)) {
            throw new Error('Invalid license key returned by server');
          }
          // Prove the entitlement the same way as key-paste: mint & verify a
          // machine-bound signed token. Google sign-in identifies the user; the
          // token is what actually unlocks the app.
          setStage('device');
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
        // Log the reason, not just the fact. The old bare warning meant every
        // distinct failure — bad client type, audience mismatch, network, a
        // declined consent screen — looked identical in the log.
        logger?.error?.('Google sign-in failed', e, { siteUrl: SITE_URL });
        done({ ok: false, error: e?.message || 'Google sign-in failed. Please try again.' });
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

function openSupport() {
  shell.openExternal(`${SITE_URL}/support`);
}

function signOut() {
  clearStore();
}

function init(ctx) {
  logger = ctx.logger;
  storePath = path.join(ctx.userDataPath, 'license.json');
  return { check, getCachedUnlock, verifyInBackground, verifyKey, signInWithGoogle, getState, getAccount, openPricing, openAccount, openSupport, signOut, SITE_URL };
}

module.exports = { init };
