import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getLicenseDevices, resetDevices } from "@/lib/activation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Device (HWID) management for the signed-in user's license.
 *
 *   GET  → { limit, used, resetInMs, devices: [{ id, shortId, firstSeen, lastSeen }] }
 *   POST → clear all activations (a "HWID reset"), then return the fresh summary.
 *
 * Both require an authenticated session. The reset is on a DB-enforced cooldown
 * (see resetDevices) so it can't be looped to stack machines past the device cap
 * within the offline grace window.
 */

function humanDuration(ms: number): string {
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  try {
    return NextResponse.json(await getLicenseDevices(session.user.id));
  } catch (err) {
    console.error("[account/devices] list failed", err);
    return NextResponse.json(
      { error: "Could not load your devices." },
      { status: 500 },
    );
  }
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  try {
    const result = await resetDevices(session.user.id);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: `You can reset your devices again in ${humanDuration(
            result.retryInMs,
          )}.`,
          ...(await getLicenseDevices(session.user.id)),
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(result.retryInMs / 1000)),
          },
        },
      );
    }
    const summary = await getLicenseDevices(session.user.id);
    return NextResponse.json({ removed: result.removed, ...summary });
  } catch (err) {
    console.error("[account/devices] reset failed", err);
    return NextResponse.json(
      { error: "Could not reset your devices. Please try again." },
      { status: 500 },
    );
  }
}
