import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/license/verify?key=MAIN-XXXX-XXXX-XXXX-XXXX
 * Lets the desktop app validate a license key online.
 * Returns { valid, email?, issuedAt? }.
 *
 * Optional shared secret: if LICENSE_VERIFY_SECRET is set, callers must send it
 * as `Authorization: Bearer <secret>` (or ?secret=). See README to wire the
 * desktop app to it.
 */
const requiredSecret = process.env.LICENSE_VERIFY_SECRET;

function getProvidedSecret(req: Request, url: URL) {
  const bearer = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  return bearer || url.searchParams.get("secret");
}

async function createVerifyResponse(req: Request, key: string) {
  const url = new URL(req.url);
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

  const license = await prisma.license.findUnique({
    where: { key },
    include: { user: { select: { email: true } } },
  });

  if (!license || !license.active) {
    return NextResponse.json({ valid: false });
  }

  const response: { valid: true; email?: string | null; issuedAt?: string } = { valid: true };
  if (isAuthorized) {
    response.email = license.user.email ?? null;
    response.issuedAt = license.issuedAt.toISOString();
  }

  return NextResponse.json(response);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key")?.trim();
  return createVerifyResponse(req, key || "");
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  return createVerifyResponse(req, key);
}
