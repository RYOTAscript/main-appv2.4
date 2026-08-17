import { createPrivateKey, sign, type KeyObject } from "crypto";

/**
 * License tokens — the cryptographic heart of the licensing system.
 *
 * The desktop app no longer trusts a plain `{ valid: true }` reply (a fake local
 * server or a hand-edited license.json could forge that). Instead, a valid
 * license is proven by a short **signed token** that only this server can mint,
 * because only this server holds the Ed25519 private key. The client verifies
 * the signature offline against a public key baked into the app, so:
 *   • a forged license.json fails signature verification, and
 *   • a fake verify server can't produce a token at all.
 *
 * Token format (JWT-ish, EdDSA):  b64url(payloadJSON) "." b64url(signature)
 * where the signature covers the ASCII bytes of the b64url(payloadJSON) part.
 *
 * Payload shape (kept terse — it travels on every launch):
 *   { k, m, iat, exp, v, email? }
 *     k     license key
 *     m     machine id (hardware-bound; the client refuses a token minted for
 *           another machine)
 *     iat   issued-at (ms epoch)
 *     exp   expiry (ms epoch) — the offline grace horizon (see GRACE_MS)
 *     v     payload version
 *     email optional, for the in-app account panel
 *
 * The private key lives in the LICENSE_SIGNING_PRIVATE_KEY env var (PKCS#8 PEM).
 * Generate a fresh pair with:
 *   node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'pem'}));console.log(publicKey.export({type:'spki',format:'pem'}))"
 * Put the private PEM in LICENSE_SIGNING_PRIVATE_KEY (Vercel env) and paste the
 * public PEM into the desktop app's main/license.js (LICENSE_PUBLIC_KEY).
 */

// Offline grace horizon baked into every token. After a successful online
// verify the app runs offline until this elapses, then must reconnect. Because
// it lives inside the signed payload, the client can't extend it by editing a
// local timestamp. Override with LICENSE_GRACE_DAYS.
export const GRACE_MS =
  Number(process.env.LICENSE_GRACE_DAYS || 3) * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = 1;

let cachedKey: KeyObject | null = null;

/** The Ed25519 signing key, or null when signing isn't configured. */
function getPrivateKey(): KeyObject | null {
  if (cachedKey) return cachedKey;
  const pem = process.env.LICENSE_SIGNING_PRIVATE_KEY;
  if (!pem || !pem.includes("PRIVATE KEY")) return null;
  try {
    // Env vars sometimes arrive with literal "\n" instead of real newlines.
    cachedKey = createPrivateKey(pem.replace(/\\n/g, "\n"));
    return cachedKey;
  } catch (err) {
    console.error("[licenseToken] invalid LICENSE_SIGNING_PRIVATE_KEY", err);
    return null;
  }
}

/** True when the server can mint tokens (private key present + valid). */
export function signingConfigured(): boolean {
  return getPrivateKey() !== null;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export type LicenseTokenClaims = {
  key: string;
  machineId: string;
  email?: string | null;
};

/**
 * Mint a signed license token, or null if signing isn't configured.
 * `exp` is set GRACE_MS into the future.
 */
export function signLicenseToken(claims: LicenseTokenClaims): string | null {
  const priv = getPrivateKey();
  if (!priv) return null;

  const now = Date.now();
  const payload = {
    k: claims.key,
    m: claims.machineId,
    iat: now,
    exp: now + GRACE_MS,
    v: TOKEN_VERSION,
    ...(claims.email ? { email: claims.email } : {}),
  };

  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const signature = sign(null, Buffer.from(body), priv); // Ed25519
  return `${body}.${b64url(signature)}`;
}
