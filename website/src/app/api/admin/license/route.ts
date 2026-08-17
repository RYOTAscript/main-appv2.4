import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin: permanently delete a license key. Deleting the License row cascades to
 * its Activation rows (onDelete: Cascade). The customer's User/Purchase records
 * are left intact — this only revokes the key + its device bindings, so a new
 * key could be re-provisioned later if needed.
 *
 * Admin-only (ADMIN_EMAILS allowlist). Non-admins get 403.
 */
export async function DELETE(req: Request) {
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
    await prisma.license.delete({ where: { id: licenseId } });
  } catch (err) {
    console.error("[admin/license] delete failed", err);
    return NextResponse.json(
      { error: "Could not delete license (already removed?)." },
      { status: 500 },
    );
  }

  return NextResponse.json({ deleted: true });
}
