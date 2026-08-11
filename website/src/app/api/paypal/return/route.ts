import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { captureOrder } from "@/lib/paypal";
import { provisionLicense } from "@/lib/provision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PayPal redirects the buyer back here after they approve on PayPal's hosted
 * page (`return_url`). We capture the order, provision the license
 * (idempotently), then bounce to /account. The returning request carries the
 * user's session cookie, so we know who they are.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = process.env.NEXTAUTH_URL ?? url.origin;
  const token = url.searchParams.get("token"); // the PayPal order id

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${origin}/signin?callbackUrl=/account`);
  }
  if (!token) {
    return NextResponse.redirect(`${origin}/#pricing?paypal=cancelled`);
  }

  try {
    const capture = await captureOrder(token);
    if (capture.status !== "COMPLETED") {
      return NextResponse.redirect(`${origin}/#pricing?paypal=incomplete`);
    }
    await provisionLicense({
      userId: session.user.id,
      provider: "paypal",
      externalId: capture.orderId,
      captureId: capture.captureId,
      amountCents: capture.amountCents,
      currency: capture.currency,
    });
    return NextResponse.redirect(`${origin}/account?purchased=1`);
  } catch (err) {
    console.error("[paypal/return] capture failed", err);
    return NextResponse.redirect(`${origin}/account?paypal=error`);
  }
}
