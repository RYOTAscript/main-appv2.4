import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientIp } from "@/lib/rateLimit";
import { registerActivation } from "@/lib/activation";
import { signLicenseToken, signingConfigured, GRACE_MS } from "@/lib/licenseToken";
import { sendNewDeviceEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * POST /api/license/verify   { key, machineId? }
 * GET  /api/license/verify?key=MAIN-XXXX-XXXX-XXXX-XXXX      (no binding)
 *
 * Validates a license key online. The desktop app posts a `machineId` (an opaque
 * hardware fingerprint); when present we:
 *   1. enforce the per-key device limit (see lib/activation), and
 *   2. return a short **signed token** the app verifies offline against a baked-in
 *      public key. The token — not the bare `{ valid }` boolean — is what unlocks
 *      the app, so a fake verify server or a hand-edited license.json can't forge
 *      an entitlement (they can't produce a valid signature).
 *
 * Returns { valid, token?, email?, issuedAt?, exp?, error? }.
 *
 * Optional shared secret: if LICENSE_VERIFY_SECRET is set, callers must send it
 * as `Authorization: Bearer <secret>` (or ?secret=).
 */
const requiredSecret = process.env.LICENSE_VERIFY_SECRET;

function getProvidedSecret(req: Request, url: URL) {
  const bearer = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  return bearer || url.searchParams.get("secret");
}

async function createVerifyResponse(
  req: Request,
  key: string,
  machineId: string,
  tokenIat: number,
  deviceName: string,
) {
  const url = new URL(req.url);

  // Throttle per-IP so the endpoint can't be used to brute-force/enumerate keys.
  const limit = rateLimit(`license-verify:${clientIp(req)}`, 60, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { valid: false, error: "rate limited" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const providedSecret = getProvidedSecret(req, url);
  const isAuthorized = requiredSecret ? providedSecret === requiredSecret : false;

  if (requiredSecret && !isAuthorized) {
    return NextResponse.json({ valid: false, error: "unauthorized" }, { status: 401 });
  }

  if (!key) {
    return NextResponse.json(
      { valid: false, error: "missing key" },
      { status: 400 },
    );
  }

  let license;
  try {
    license = await prisma.license.findUnique({
      where: { key },
      include: { user: { select: { email: true } } },
    });
  } catch (err) {
    console.error("[license/verify] db error", err);
    return NextResponse.json(
      { valid: false, error: "temporarily unavailable" },
      { status: 503 },
    );
  }

  if (!license || !license.active) {
    return NextResponse.json({ valid: false });
  }

  const email = license.user.email ?? null;
  const issuedAt = license.issuedAt.toISOString();

  // No machineId → legacy/inspection path (e.g. the GET browser check or the
  // secret-authorized tooling). We answer the boolean but never a token: tokens
  // are always machine-bound.
  if (!machineId) {
    const response: {
      valid: true;
      email?: string | null;
      issuedAt?: string;
    } = { valid: true };
    if (isAuthorized) {
      response.email = email;
      response.issuedAt = issuedAt;
    }
    return NextResponse.json(response);
  }

  // Logout-on-reset: if the client presents a token minted BEFORE the user's
  // last device reset, that device was reset away — tell it to log out (return
  // to the gate) instead of silently re-activating. The device re-authenticates
  // on the gate and gets a fresh (post-reset) token + activation. A device with
  // no token, or a post-reset token, is unaffected. This is what makes "Reset
  // devices" behave like "sign out everywhere on next launch".
  if (
    tokenIat &&
    license.lastResetAt &&
    tokenIat < license.lastResetAt.getTime()
  ) {
    return NextResponse.json({ valid: false, error: "reset" });
  }

  // Machine-bound path (the desktop app). Enforce the device limit first.
  try {
    const act = await registerActivation(license.id, machineId, deviceName);
    if (!act.ok) {
      return NextResponse.json({ valid: false, error: "device-limit" });
    }
    // A brand-new 2nd+ device just came online → alert the owner (best-effort;
    // no-op unless email is configured). The first device after purchase isn't
    // worth a "new device" email, hence priorCount >= 1.
    if (act.created && act.priorCount >= 1 && email) {
      void sendNewDeviceEmail(email, {
        name: deviceName || null,
        shortId: machineId.slice(0, 8).toUpperCase(),
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[license/verify] activation error", err);
    return NextResponse.json(
      { valid: false, error: "temporarily unavailable" },
      { status: 503 },
    );
  }

  // Mint the signed, machine-bound token that actually unlocks the app.
  if (!signingConfigured()) {
    // Fail closed: without a signing key we cannot issue a trustworthy token.
    console.error(
      "[license/verify] LICENSE_SIGNING_PRIVATE_KEY not configured — cannot issue token",
    );
    return NextResponse.json(
      { valid: false, error: "signing-unavailable" },
      { status: 503 },
    );
  }

  const token = signLicenseToken({ key, machineId, email });
  return NextResponse.json({
    valid: true,
    token,
    email,
    issuedAt,
    exp: Date.now() + GRACE_MS,
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key")?.trim();
  return createVerifyResponse(req, key || "", "", 0, "");
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const machineId =
    typeof body?.machineId === "string" ? body.machineId.trim().slice(0, 128) : "";
  // The client's current token issue-time (ms epoch), so we can detect a token
  // that predates a device reset. 0/absent for a fresh unlock.
  const tokenIat = typeof body?.tokenIat === "number" ? body.tokenIat : 0;
  // The PC's hostname, for a human-readable device label. Optional.
  const deviceName =
    typeof body?.deviceName === "string" ? body.deviceName.trim().slice(0, 64) : "";
  return createVerifyResponse(req, key, machineId, tokenIat, deviceName);
}
