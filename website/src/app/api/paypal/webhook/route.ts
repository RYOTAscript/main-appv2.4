import { NextResponse } from "next/server";
import { isWebhookConfigured, verifyWebhookSignature } from "@/lib/paypal";
import { provisionLicense } from "@/lib/provision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PayPal webhook — a backup provisioning path for when the browser closes after
 * the buyer approves but before the capture round-trip finishes. Subscribe to
 * PAYMENT.CAPTURE.COMPLETED. Provisioning is idempotent (keyed by order id), so
 * this and the capture route can both fire safely.
 *
 * Requires PAYPAL_WEBHOOK_ID for signature verification; without it we refuse
 * (never trust an unverified webhook).
 */
export async function POST(req: Request) {
  if (!isWebhookConfigured()) {
    return NextResponse.json(
      { error: "Webhook not configured." },
      { status: 503 },
    );
  }

  const raw = await req.text();
  let event: {
    event_type?: string;
    resource?: {
      id?: string;
      custom_id?: string;
      amount?: { value?: string; currency_code?: string };
      supplementary_data?: { related_ids?: { order_id?: string } };
    };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const ok = await verifyWebhookSignature(req.headers, event);
  if (!ok) {
    return NextResponse.json(
      { error: "Signature verification failed." },
      { status: 400 },
    );
  }

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const r = event.resource ?? {};
    const userId = r.custom_id;
    const orderId = r.supplementary_data?.related_ids?.order_id || r.id;

    if (!userId || !orderId) {
      // Nothing we can act on — ack so PayPal stops retrying.
      return NextResponse.json({ received: true, skipped: "missing-ids" });
    }

    const value = r.amount?.value;
    try {
      await provisionLicense({
        userId,
        provider: "paypal",
        externalId: orderId,
        captureId: r.id ?? null,
        amountCents: value ? Math.round(parseFloat(value) * 100) : 500,
        currency: r.amount?.currency_code ?? "USD",
      });
    } catch (err) {
      console.error("[paypal/webhook] provisioning failed", err);
      return NextResponse.json({ error: "Provisioning failed." }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
