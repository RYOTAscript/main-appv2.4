import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { resetDevicesByLicense } from "@/lib/activation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin: reset (clear) all device activations for a license — the support
 * action for "customer changed PCs and is stuck at the device limit". Clears the
 * activations and stamps lastResetAt (so any still-running devices log out on
 * next launch). No cooldown, admin-only.
 */
export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let licenseId: unknown;
  try {
    ({ licenseId } = (await req.json()) as { licenseId?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof licenseId !== "string" || !licenseId) {
    return NextResponse.json({ error: "licenseId required." }, { status: 400 });
  }

  try {
    const removed = await resetDevicesByLicense(licenseId);
    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    console.error("[admin/devices] reset failed", err);
    return NextResponse.json(
      { error: "Could not reset devices." },
      { status: 500 },
    );
  }
}
