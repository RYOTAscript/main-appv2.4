import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin: toggle whether a purchase counts toward revenue.
 *
 * Revenue + per-customer spend queries filter `status: "complete"`, so marking
 * a purchase `"excluded"` drops it from every total without deleting the record
 * (useful for test/sandbox payments). `provisionLicense` is idempotent on
 * externalId and never updates an existing purchase, so a webhook retry will
 * NOT revert this. `include` restores it to `"complete"`.
 *
 * Admin-only (ADMIN_EMAILS allowlist). Non-admins get 403.
 */
export async function PATCH(req: Request) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let purchaseId: unknown;
  let action: unknown;
  try {
    ({ purchaseId, action } = (await req.json()) as {
      purchaseId?: unknown;
      action?: unknown;
    });
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof purchaseId !== "string" || !purchaseId) {
    return NextResponse.json({ error: "purchaseId required." }, { status: 400 });
  }
  if (action !== "exclude" && action !== "include") {
    return NextResponse.json(
      { error: "action must be 'exclude' or 'include'." },
      { status: 400 },
    );
  }

  const status = action === "exclude" ? "excluded" : "complete";
  try {
    await prisma.purchase.update({ where: { id: purchaseId }, data: { status } });
  } catch (err) {
    console.error("[admin/purchase] toggle failed", err);
    return NextResponse.json(
      { error: "Could not update purchase." },
      { status: 500 },
    );
  }

  return NextResponse.json({ status });
}
