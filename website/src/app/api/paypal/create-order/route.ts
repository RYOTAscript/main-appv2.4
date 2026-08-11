import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createOrder, isPayPalConfigured } from "@/lib/paypal";
import { hasActiveLicense } from "@/lib/license";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a PayPal order for the $5 license. Requires an authenticated user. */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }

  if (!isPayPalConfigured()) {
    return NextResponse.json(
      {
        error:
          "Payments aren't configured yet. Add your PayPal credentials to enable checkout.",
      },
      { status: 503 },
    );
  }

  if (await hasActiveLicense(session.user.id)) {
    return NextResponse.json(
      { error: "You already own a license.", alreadyOwned: true },
      { status: 409 },
    );
  }

  const origin = process.env.NEXTAUTH_URL ?? new URL(req.url).origin;

  try {
    const order = await createOrder(session.user.id, origin);
    if (!order.approveUrl) {
      throw new Error("No approval URL returned by PayPal.");
    }
    return NextResponse.json({ id: order.id, approveUrl: order.approveUrl });
  } catch (err) {
    console.error("[paypal/create-order]", err);
    return NextResponse.json(
      { error: "Could not start checkout. Please try again." },
      { status: 500 },
    );
  }
}
