import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { captureOrder, getOrderOwner } from "@/lib/paypal";
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
    // The order id is a query parameter, so the session presenting it isn't
    // necessarily the session that started the checkout. createOrder stamps the
    // buyer's user id into custom_id; require it to match before we capture, or
    // an approved order id could be redeemed by a different signed-in account.
    const owner = await getOrderOwner(token);
    if (!owner || owner !== session.user.id) {
      console.warn("[paypal/return] order owner mismatch", {
        order: token,
        session: session.user.id,
      });
      return NextResponse.redirect(`${origin}/account?paypal=mismatch`);
    }

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
