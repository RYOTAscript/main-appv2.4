import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Self-serve account deletion (GDPR right to erasure). Requires an authenticated
 * session. Deleting the User row cascades to the user's accounts, sessions,
 * license and purchase records (onDelete: Cascade in the schema).
 *
 * After this succeeds the client should sign out — the session cookie now
 * points at a user that no longer exists.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  try {
    await prisma.user.delete({ where: { id: session.user.id } });
  } catch (err) {
    console.error("[account/delete] failed", err);
    return NextResponse.json(
      { error: "Could not delete your account. Please contact support." },
      { status: 500 },
    );
  }

  return NextResponse.json({ deleted: true });
}
