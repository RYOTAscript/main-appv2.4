// License / entitlement for the paid app.
//
// The app is gated behind a purchase. A user unlocks it either by
//   • signing in with Google (native OAuth → the website's /api/app/session), or
//   • pasting the license key they got after buying.
// Either way we cache the license locally and re-verify against the website's
// /api/license/verify on each launch, with an offline grace window so a brief
// loss of internet doesn't lock a paying user out.
//
// The website is the single source of truth (see the `website/` project).

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { shell } = require('electron');

// ── Config ──────────────────────────────────────────────────────────────────
// The deployed website is the licensing authority. Override with MAIN_SITE_URL
// (e.g. set MAIN_SITE_URL=http://localhost:3000 while developing locally).
const SITE_URL = (process.env.MAIN_SITE_URL || 'https://main-website-eosin-beta.vercel.app').replace(/\/$/, '');
// From your Google "Desktop app" OAuth client (see website docs/DESKTOP_APP_AUTH.md).
// Until these are set, the "Sign in with Google" path is unavailable and users
// unlock with their license key instead.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_DESKTOP_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_DESKTOP_CLIENT_SECRET || '';
// Optional shared secret if the website's verify endpoint is locked down.
const VERIFY_SECRET = process.env.LICENSE_VERIFY_SECRET || '';

const GRACE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days offline grace
const NET_TIMEOUT_MS = 6000;
const KEY_PATTERN = /^MAIN-[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/;

let logger = null;
let storePath = null;

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
async function verifyKeyOnline(key) {
  const headers = { 'Content-Type': 'application/json' };
  if (VERIFY_SECRET) headers.Authorization = `Bearer ${VERIFY_SECRET}`;
  const res = await fetch(`${SITE_URL}/api/license/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 200) throw new Error(`verify HTTP ${res.status}`);
  return res.json(); // { valid, email?, issuedAt? }
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
    const r = await verifyKeyOnline(key);
    if (r && r.valid) {
      const rec = {
        key,
        email: r.email || null,
        issuedAt: r.issuedAt || null,
        provider: 'key',
        lastVerified: Date.now(),
      };
      writeStore(rec);
      logger?.success?.('License unlocked via key', { email: rec.email });
      return { valid: true, license: rec };
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
          const rec = {
            key: licenseKey,
            email: data.email || null,
            name: data.name || null,
            issuedAt: data.license.issuedAt || null,
            provider: 'google',
            lastVerified: Date.now(),
          };
          writeStore(rec);
          logger?.success?.('License unlocked via Google', { email: rec.email });
          done({ ok: true, purchased: true, license: rec, email: data.email });
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
 * Startup entitlement check. Re-verifies the stored license online; falls back
 * to an offline grace window if the network is down. Returns { unlocked, ... }.
 */
async function check() {
  const stored = readStore();
  if (!stored || !stored.key) return { unlocked: false, reason: 'none' };
  try {
    const r = await verifyKeyOnline(stored.key);
    if (r && r.valid) {
      stored.lastVerified = Date.now();
      if (r.email) stored.email = r.email;
      writeStore(stored);
      return { unlocked: true, license: stored };
    }
    // Definitive "not valid" from the server → license was revoked/refunded.
    clearStore();
    return { unlocked: false, reason: 'revoked' };
  } catch (e) {
    // Network failure — honour the offline grace window.
    if (stored.lastVerified && Date.now() - stored.lastVerified < GRACE_MS) {
      logger?.log?.('License check offline — within grace window', 'INFO');
      return { unlocked: true, offline: true, license: stored };
    }
    return { unlocked: false, reason: 'offline-expired' };
  }
}

/**
 * Instant, network-free entitlement decision from the local cache — used at
 * STARTUP so the app can show immediately instead of blocking on an online
 * verify (which can hang for seconds while the network comes up at boot). If a
 * cached license is present and within the grace window we unlock right away and
 * re-verify in the background (see verifyInBackground).
 *   { unlocked:true }             → cached + within grace
 *   { unlocked:false, reason }    → 'none' (no license) or 'stale' (grace expired,
 *                                    caller should fall back to the online check)
 */
function getCachedUnlock() {
  const stored = readStore();
  if (!stored || !stored.key) return { unlocked: false, reason: 'none' };
  if (stored.lastVerified && Date.now() - stored.lastVerified < GRACE_MS) {
    return { unlocked: true, cached: true, license: stored };
  }
  return { unlocked: false, reason: 'stale', license: stored };
}

/**
 * Re-verify the cached license online, quietly, after the app has already
 * started. Refreshes lastVerified on success; on a definitive server "invalid"
 * (revoked/refunded) it clears the cache and calls onRevoked. Network errors are
 * ignored so a transient blip never kicks a paying user out.
 */
async function verifyInBackground(onRevoked) {
  const stored = readStore();
  if (!stored || !stored.key) return;
  try {
    const r = await verifyKeyOnline(stored.key);
    if (r && r.valid) {
      stored.lastVerified = Date.now();
      if (r.email) stored.email = r.email;
      writeStore(stored);
    } else {
      logger?.warn?.('Background re-verify: license no longer valid');
      clearStore();
      if (typeof onRevoked === 'function') onRevoked();
    }
  } catch (e) {
    /* offline / transient — keep the cached license */
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
