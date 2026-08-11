import { NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Desktop-app sign-in (native Google OAuth in the app).
 *
 * The app runs its own Google OAuth (PKCE, loopback redirect) and posts the
 * resulting `id_token` here. We verify the token against Google's keys and the
 * allowed audiences, then match the user by their (verified) Google email and
 * return their license entitlement. Identity is proven by the id_token — no
 * password or key to copy.
 *
 *   POST /api/app/session   { "idToken": "<google id_token>" }
 *   → { authenticated, email, name, picture, purchased, license: { key, issuedAt } | null }
 *
 * The token's `aud` must be one of our Google client ids, so a token minted for
 * some other app can't be replayed here.
 */

const allowedAudiences = [
  process.env.GOOGLE_DESKTOP_CLIENT_ID,
  process.env.GOOGLE_CLIENT_ID,
].filter((v): v is string => Boolean(v));

const googleClient = new OAuth2Client();

export async function POST(req: Request) {
  if (allowedAudiences.length === 0) {
    return NextResponse.json(
      { authenticated: false, error: "App sign-in isn't configured." },
      { status: 503 },
    );
  }

  let idToken: string | undefined;
  try {
    const body = (await req.json()) as { idToken?: string };
    idToken = body.idToken;
  } catch {
    /* fall through to the missing-token error */
  }

  if (!idToken) {
    return NextResponse.json(
      { authenticated: false, error: "Missing idToken." },
      { status: 400 },
    );
  }

  // Verify signature, expiry, issuer, and that the token was minted for us.
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: allowedAudiences,
    });
    payload = ticket.getPayload();
  } catch (err) {
    console.error("[app/session] id_token verification failed", err);
    return NextResponse.json(
      { authenticated: false, error: "Invalid Google token." },
      { status: 401 },
    );
  }

  const email = payload?.email;
  if (!payload || !email || payload.email_verified !== true) {
    return NextResponse.json(
      { authenticated: false, error: "Unverified Google account." },
      { status: 401 },
    );
  }

  // Match the account created when they signed in / bought on the web. We look
  // up by email (stable + verified); we never auto-create a purchase here.
  const user = await prisma.user.findUnique({
    where: { email },
    include: { license: true },
  });

  const purchased = Boolean(user?.license?.active);

  return NextResponse.json({
    authenticated: true,
    email,
    name: payload.name ?? user?.name ?? null,
    picture: payload.picture ?? user?.image ?? null,
    purchased,
    license:
      purchased && user?.license
        ? {
            key: user.license.key,
            issuedAt: user.license.issuedAt.toISOString(),
          }
        : null,
  });
}
